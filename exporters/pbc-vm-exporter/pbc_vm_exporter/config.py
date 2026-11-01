"""Configuration (environment and an optional .env file) and secret redaction.

There is no command-line option for a token or password: argv is visible to other users and to shell history.
"""

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Iterable, Mapping
from urllib.parse import urlsplit

from .errors import ConfigError

log = logging.getLogger(__name__)

TOKEN_RE = re.compile(r"^pbcvm_[A-Za-z0-9_-]{43}\Z")
INDEX_RE = re.compile(r"^[A-Za-z0-9._*-]+\Z")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
ENV_LINE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
MODES = ("auto", "indexer", "api")
DEFAULT_INDEX = "wazuh-states-vulnerabilities-*"
TRUTHY = ("true", "1", "yes", "on")
SOURCES = ("wazuh", "xccdf", "action1", "sentinelone")
VENDOR_SOURCES = ("action1", "sentinelone")
ORG_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}\Z")
SITE_ID_RE = re.compile(r"^[0-9]{1,24}\Z")
WHITESPACE_OR_CONTROL_RE = re.compile(r"[\s\x00-\x1f\x7f]")


def is_truthy(value: str | None) -> bool:
    return value is not None and value.strip().lower() in TRUTHY


@dataclass(frozen=True)
class Action1Settings:
    base_url: str  # the full API root, for example https://app.action1.com/api/3.0
    client_id: str
    client_secret: str = field(repr=False)
    org_id: str
    verify: bool | str
    include_patch_findings: bool
    proxy_url: str | None


@dataclass(frozen=True)
class SentinelOneSettings:
    console_url: str  # host only; the reader appends /web/api/v2.1
    api_token: str = field(repr=False)
    site_ids: tuple[str, ...]
    verify: bool | str
    proxy_url: str | None


@dataclass(frozen=True)
class Config:
    pbc_url: str | None
    pbc_token: str | None = field(repr=False)
    pbc_verify: bool | str
    wazuh_mode: str
    api_url: str | None
    api_user: str | None
    api_password: str | None = field(repr=False)
    indexer_url: str | None
    indexer_user: str | None
    indexer_password: str | None = field(repr=False)
    indexer_index: str
    wazuh_verify: bool | str
    source_label: str | None
    max_hosts: int
    max_findings: int
    max_bytes: int
    timeout: int
    allow_insecure: bool
    action1: Action1Settings | None = None
    sentinelone: SentinelOneSettings | None = None

    def secrets(self) -> list[str]:
        found = [self.pbc_token, self.api_password, self.indexer_password]
        if self.action1 is not None:
            found.append(self.action1.client_secret)
        if self.sentinelone is not None:
            found.append(self.sentinelone.api_token)
        return [s for s in found if s]


def parse_env_file(path: str) -> dict[str, str]:
    """KEY=value lines, optional `export ` prefix, full-line # comments. No inline comments, escapes or interpolation."""
    try:
        with open(path, encoding="utf-8-sig") as fh:
            lines = fh.read().splitlines()
    except OSError as err:
        raise ConfigError(f"cannot read env file {path}: {err.strerror or type(err).__name__}") from None
    if os.name != "nt":
        try:
            if os.stat(path).st_mode & 0o077:
                log.warning("%s is readable by group/others; chmod 600", path)
        except OSError:
            pass
    out: dict[str, str] = {}
    for number, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export ") or line.startswith("export\t"):
            line = line[7:].lstrip()
        match = ENV_LINE_RE.match(line)
        if not match:
            # Never echo the line: it may be a secret that lost its key.
            raise ConfigError(f"{path}: line {number} is not KEY=value")
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        out[match.group(1)] = value
    return out


def _check_url(name: str, value: str | None, allow_insecure: bool, *, allow_http: bool = False) -> str | None:
    if value is None or not value.strip():
        return None
    value = value.strip()
    try:
        parts = urlsplit(value)
        hostname = parts.hostname
    except ValueError:
        raise ConfigError(f"{name} is not a valid URL") from None
    if parts.scheme == "https":
        pass
    elif parts.scheme == "http" and (allow_insecure or allow_http):
        pass
    elif parts.scheme == "http":
        raise ConfigError(f"{name} must use https (PBC_ALLOW_INSECURE_TRANSPORT is for development only)")
    elif allow_http:
        raise ConfigError(f"{name} must use http or https")
    else:
        raise ConfigError(f"{name} must use https")
    if "@" in parts.netloc or parts.username is not None or parts.password is not None:
        raise ConfigError(f"{name} must not contain credentials")
    if parts.query or parts.fragment:
        raise ConfigError(f"{name} must not contain a query or fragment")
    if not hostname:
        raise ConfigError(f"{name} has no host")
    return value.rstrip("/")


def _ca(name: str, value: str | None) -> bool | str:
    if value is None or not value.strip():
        return True
    path = value.strip()
    if not os.path.isfile(path):
        raise ConfigError(f"{name}: file not found: {path}")
    return path


def _int_setting(get, name: str, default: int, low: int, high: int) -> int:
    raw = get(name)
    if raw is None or raw.strip() == "":
        return default
    raw = raw.strip()
    if not re.fullmatch(r"[0-9]+", raw) or int(raw) <= 0:
        log.warning("%s is not a positive integer; using %d", name, default)
        return default
    n = int(raw)
    if n < low or n > high:
        clamped = min(max(n, low), high)
        log.warning("%s=%d is outside %d..%d; using %d", name, n, low, high, clamped)
        return clamped
    return n


def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def _clean_label(value: str | None) -> str | None:
    if value is None:
        return None
    label = value.strip()
    if not label:
        return None
    if CONTROL_RE.search(label):
        raise ConfigError("PBC_SOURCE_LABEL must not contain control characters")
    if _utf16_len(label) > 128:
        raise ConfigError("PBC_SOURCE_LABEL must be 1..128 characters")
    return label


def _plain_value(get, name: str, low: int, high: int, *, no_space: bool) -> str:
    """A required credential or identifier. The error names the variable, never the value."""
    value = (get(name) or "").strip()
    if not value:
        raise ConfigError(f"{name} is required")
    if _utf16_len(value) < low or _utf16_len(value) > high:
        raise ConfigError(f"{name} must be {low}..{high} characters")
    if no_space and WHITESPACE_OR_CONTROL_RE.search(value):
        raise ConfigError(f"{name} must not contain whitespace or control characters")
    if CONTROL_RE.search(value):
        raise ConfigError(f"{name} must not contain control characters")
    return value


def _action1_settings(get, allow_insecure: bool) -> Action1Settings:
    base = _check_url("ACTION1_BASE_URL", get("ACTION1_BASE_URL"), allow_insecure)
    if base is None:
        raise ConfigError("ACTION1_BASE_URL is required (the full API root, for example https://app.action1.com/api/3.0)")
    org = (get("ACTION1_ORG_ID") or "").strip()
    if not org:
        raise ConfigError("ACTION1_ORG_ID is required")
    if not ORG_ID_RE.match(org):
        raise ConfigError("ACTION1_ORG_ID must be 1..64 characters from A-Z a-z 0-9 -")
    raw_patch = get("ACTION1_INCLUDE_PATCH_FINDINGS")
    include = True if raw_patch is None or not raw_patch.strip() else is_truthy(raw_patch)
    return Action1Settings(
        base_url=base,
        client_id=_plain_value(get, "ACTION1_CLIENT_ID", 1, 256, no_space=False),
        client_secret=_plain_value(get, "ACTION1_CLIENT_SECRET", 1, 1024, no_space=False),
        org_id=org,
        verify=_ca("ACTION1_CA_BUNDLE", get("ACTION1_CA_BUNDLE")),
        include_patch_findings=include,
        proxy_url=_check_url("ACTION1_PROXY_URL", get("ACTION1_PROXY_URL"), allow_insecure, allow_http=True),
    )


def _sentinelone_settings(get, allow_insecure: bool) -> SentinelOneSettings:
    console = _check_url("S1_CONSOLE_URL", get("S1_CONSOLE_URL"), allow_insecure)
    if console is None:
        raise ConfigError("S1_CONSOLE_URL is required (for example https://example.sentinelone.net)")
    if urlsplit(console).path:
        raise ConfigError("S1_CONSOLE_URL must be the console host only, without a path")
    token = _plain_value(get, "S1_API_TOKEN", 20, 4096, no_space=True)
    sites: list[str] = []
    for part in (get("S1_SITE_IDS") or "").split(","):
        site = part.strip()
        if not SITE_ID_RE.match(site):
            raise ConfigError("S1_SITE_IDS must be a comma-separated list of 1..100 numeric site ids")
        if site not in sites:
            sites.append(site)
    if len(sites) > 100:
        raise ConfigError("S1_SITE_IDS must be a comma-separated list of 1..100 numeric site ids")
    return SentinelOneSettings(
        console_url=console,
        api_token=token,
        site_ids=tuple(sites),
        verify=_ca("S1_CA_BUNDLE", get("S1_CA_BUNDLE")),
        proxy_url=_check_url("S1_PROXY_URL", get("S1_PROXY_URL"), allow_insecure, allow_http=True),
    )


def load_config(
    environ: Mapping[str, str],
    env_file: str | None,
    *,
    mode_override: str | None,
    dry_run: bool,
    sample: bool,
    source: str = "wazuh",
) -> Config:
    values: dict[str, str] = {}
    if env_file is not None:
        values.update(parse_env_file(env_file))
    elif not sample and os.path.isfile(".env"):
        values.update(parse_env_file(".env"))
    values.update(environ)  # the environment wins over the file

    def get(name: str) -> str | None:
        v = values.get(name)
        return v if v is not None else None

    allow_insecure = is_truthy(get("PBC_ALLOW_INSECURE_TRANSPORT"))
    if allow_insecure:
        log.warning("PBC_ALLOW_INSECURE_TRANSPORT is set: plain http is allowed (development only)")

    vendor = source in VENDOR_SOURCES  # the Wazuh settings mean nothing to a vendor source: do not validate them
    mode = "auto" if vendor else (mode_override or get("WAZUH_MODE") or "auto").strip().lower()
    if mode not in MODES:
        raise ConfigError("WAZUH_MODE must be one of auto, indexer, api")

    pbc_url = _check_url("PBC_URL", get("PBC_URL"), allow_insecure)
    if pbc_url is None and not (dry_run or sample):
        raise ConfigError("PBC_URL is required")

    token = (get("PBC_SERVICE_TOKEN") or "").strip() or None
    if not (dry_run or sample):
        if token is None:
            raise ConfigError("PBC_SERVICE_TOKEN is required (environment or env file; there is no command-line option)")
        if not TOKEN_RE.match(token):
            raise ConfigError("PBC_SERVICE_TOKEN is not a valid service token (expected pbcvm_ plus 43 characters)")
    elif token is not None and not TOKEN_RE.match(token):
        token = None

    label = _clean_label(get("PBC_SOURCE_LABEL"))
    if label is None and not sample:
        raise ConfigError("PBC_SOURCE_LABEL is required (keep it stable: a new label is a new source)")

    index = DEFAULT_INDEX if vendor else (get("WAZUH_INDEXER_INDEX") or DEFAULT_INDEX).strip()
    if not INDEX_RE.match(index):
        raise ConfigError("WAZUH_INDEXER_INDEX contains characters outside A-Z a-z 0-9 . _ * -")

    # Vendor variables are needed only by their own source, and never for the bundled sample.
    action1 = _action1_settings(get, allow_insecure) if source == "action1" and not sample else None
    sentinelone = _sentinelone_settings(get, allow_insecure) if source == "sentinelone" and not sample else None

    return Config(
        pbc_url=pbc_url,
        pbc_token=token,
        pbc_verify=_ca("PBC_CA_BUNDLE", get("PBC_CA_BUNDLE")),
        wazuh_mode=mode,
        api_url=_check_url("WAZUH_API_URL", get("WAZUH_API_URL"), allow_insecure),
        api_user=get("WAZUH_API_USER"),
        api_password=get("WAZUH_API_PASSWORD"),
        indexer_url=_check_url("WAZUH_INDEXER_URL", get("WAZUH_INDEXER_URL"), allow_insecure),
        indexer_user=get("WAZUH_INDEXER_USER"),
        indexer_password=get("WAZUH_INDEXER_PASSWORD"),
        indexer_index=index,
        wazuh_verify=_ca("WAZUH_CA_BUNDLE", get("WAZUH_CA_BUNDLE")),
        source_label=label,
        max_hosts=_int_setting(get, "EXPORT_MAX_HOSTS_PER_REQUEST", 500, 1, 1000),
        max_findings=_int_setting(get, "EXPORT_MAX_FINDINGS_PER_REQUEST", 50000, 1, 50000),
        max_bytes=_int_setting(get, "EXPORT_MAX_BYTES", 33554432, 1048576, 104857600),
        timeout=_int_setting(get, "EXPORT_TIMEOUT_SECONDS", 60, 5, 600),
        allow_insecure=allow_insecure,
        action1=action1,
        sentinelone=sentinelone,
    )


_PATTERNS = (
    (re.compile(r"eyJ[\w-]+\.[\w-]+\.[\w-]*"), "[REDACTED-JWT]"),
    (re.compile(r"Bearer \S+"), "Bearer [REDACTED]"),
    (re.compile(r"ApiToken \S+"), "ApiToken [REDACTED]"),
    (re.compile(r"pbcvm_[A-Za-z0-9_-]+"), "pbcvm_[REDACTED]"),
    (re.compile(r"//[^/@\s]+@"), "//[REDACTED]@"),
)


def redact(text: str, secrets: Iterable[str] = ()) -> str:
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return text


class RedactingFilter(logging.Filter):
    def __init__(self, secrets: Iterable[str] = ()):
        super().__init__()
        self.secrets = list(secrets)

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage(), self.secrets)
        record.args = ()
        return True


def install_log_redaction(secrets: Iterable[str], handler: logging.Handler | None = None) -> RedactingFilter:
    """Adds a redacting filter to `handler`, or to every handler of the package logger. Returns the filter."""
    flt = RedactingFilter(secrets)
    if handler is not None:
        handler.addFilter(flt)
    else:
        for h in logging.getLogger("pbc_vm_exporter").handlers:
            h.addFilter(flt)
    return flt
