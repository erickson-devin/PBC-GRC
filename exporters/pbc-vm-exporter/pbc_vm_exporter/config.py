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


def is_truthy(value: str | None) -> bool:
    return value is not None and value.strip().lower() in TRUTHY


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

    def secrets(self) -> list[str]:
        return [s for s in (self.pbc_token, self.api_password, self.indexer_password) if s]


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


def _check_url(name: str, value: str | None, allow_insecure: bool) -> str | None:
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
    elif parts.scheme == "http" and allow_insecure:
        pass
    elif parts.scheme == "http":
        raise ConfigError(f"{name} must use https (PBC_ALLOW_INSECURE_TRANSPORT is for development only)")
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


def load_config(
    environ: Mapping[str, str],
    env_file: str | None,
    *,
    mode_override: str | None,
    dry_run: bool,
    sample: bool,
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

    mode = (mode_override or get("WAZUH_MODE") or "auto").strip().lower()
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

    index = (get("WAZUH_INDEXER_INDEX") or DEFAULT_INDEX).strip()
    if not INDEX_RE.match(index):
        raise ConfigError("WAZUH_INDEXER_INDEX contains characters outside A-Z a-z 0-9 . _ * -")

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
    )


_PATTERNS = (
    (re.compile(r"eyJ[\w-]+\.[\w-]+\.[\w-]*"), "[REDACTED-JWT]"),
    (re.compile(r"Bearer \S+"), "Bearer [REDACTED]"),
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
