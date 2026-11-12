"""`pbc-vm-exporter init`: asks for the settings and creates the env file (Wazuh source).

The file is created owner-only (0600 on POSIX) and is never overwritten. Secrets are read without echo, are never printed,
and there is no command-line option for them. The text mirrors the in-app setup (src/data/telemetry/exporterSetup.ts).
"""

import argparse
import getpass
import os
from typing import Callable, TextIO
from urllib.parse import urlsplit

from .config import CONTROL_RE, TOKEN_RE, RedactingFilter, _ca, _check_url, _clean_label
from .errors import ConfigError

DEFAULT_ENV_PATH = "pbc-vm-exporter.env"
DEFAULT_LABEL = "wazuh-prod"
MAX_TRIES = 3


def _ask(prompt: str) -> str:
    return input(prompt)


def _ask_secret(prompt: str) -> str:
    return getpass.getpass(prompt)


def _is_windows() -> bool:
    return os.name == "nt"


def build_init_parser() -> argparse.ArgumentParser:
    from .cli import _Parser  # late: cli imports this module

    parser = _Parser(
        prog="pbc-vm-exporter init",
        description="Asks for the PBC-GRC and Wazuh settings and creates the env file (owner-only, never overwritten). "
        "Tokens and passwords are typed at a prompt without echo; there is no option for them.",
        allow_abbrev=False,
    )
    parser.add_argument("--env-file", metavar="PATH", default=DEFAULT_ENV_PATH, help=f"file to create (default {DEFAULT_ENV_PATH})")
    parser.add_argument("--mode", choices=("indexer", "api"), default="indexer", help="Wazuh reader to configure (default indexer)")
    return parser


def _prompt(read: Callable[[str], str], prompt: str) -> str:
    try:
        return read(prompt)
    except EOFError:
        raise ConfigError("input ended; nothing was written") from None


def _ask_valid(read: Callable[[str], str], prompt: str, name: str, check: Callable[[str], str], stderr: TextIO) -> str:
    """Asks until `check` accepts the answer (3 tries). The message names the variable, never the value."""
    for _ in range(MAX_TRIES):
        raw = _prompt(read, prompt)
        try:
            return check(raw)
        except ConfigError as err:
            stderr.write(f"error: {err}\n")
    raise ConfigError(f"{name}: too many invalid answers; nothing was written")


def _ask_pbc_url(stderr: TextIO) -> tuple[str, bool]:
    """(PBC_URL, plain http allowed). An http URL is only accepted after an explicit yes (development only)."""
    for _ in range(MAX_TRIES):
        raw = _prompt(_ask, "PBC-GRC URL (https): ")
        try:
            value = _check_url("PBC_URL", raw, False)
            if value is None:
                raise ConfigError("PBC_URL is required")
            return value, False
        except ConfigError as err:
            try:
                is_http = urlsplit(raw.strip()).scheme == "http"
            except ValueError:
                is_http = False
            if not is_http:
                stderr.write(f"error: {err}\n")
                continue
        try:
            value = _check_url("PBC_URL", raw, True)  # credentials, query and fragment are refused without asking
        except ConfigError as err:
            stderr.write(f"error: {err}\n")
            continue
        answer = _prompt(_ask, "Plain http is for development only. Allow it? [y/N]: ")
        if value is not None and answer.strip().lower() in ("y", "yes"):
            return value, True
        stderr.write("error: PBC_URL: enter an https URL\n")
    raise ConfigError("PBC_URL: too many invalid answers; nothing was written")


def _url(name: str) -> Callable[[str], str]:
    def check(raw: str) -> str:
        value = _check_url(name, raw, False)
        if value is None:
            raise ConfigError(f"{name} is required")
        return value

    return check


def _plain(name: str) -> Callable[[str], str]:
    def check(raw: str) -> str:
        value = raw.strip()
        if not value:
            raise ConfigError(f"{name} is required")
        if CONTROL_RE.search(value):
            raise ConfigError(f"{name} must not contain control characters")
        return value

    return check


def _ca_path(name: str) -> Callable[[str], str]:
    def check(raw: str) -> str:
        if CONTROL_RE.search(raw):
            raise ConfigError(f"{name} must not contain control characters")
        try:
            result = _ca(name, raw)
        except ConfigError:
            raise ConfigError(f"{name}: file not found") from None
        return result if isinstance(result, str) else ""

    return check


def _label(raw: str) -> str:
    return _clean_label(raw) or DEFAULT_LABEL


def _token(raw: str) -> str:
    value = raw.strip()
    if value and not TOKEN_RE.match(value):
        raise ConfigError("PBC_SERVICE_TOKEN is not a valid service token (expected pbcvm_ plus 43 characters)")
    return value


def _secret(name: str) -> Callable[[str], str]:
    def check(raw: str) -> str:
        if not raw:
            raise ConfigError(f"{name} is required")
        if CONTROL_RE.search(raw):
            raise ConfigError(f"{name} must not contain control characters")
        return raw

    return check


def _fmt(value: str) -> str:
    """The value as written: quoted when the env parser would otherwise strip or alter it."""
    if value != value.strip() or (len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"')):
        return f'"{value}"'
    return value


def build_env_text(values: dict[str, str], mode: str) -> str:
    """Same lines, order and comments as buildExporterEnv (exporterSetup.ts) for a Wazuh source, with the values filled in."""

    def val(key: str) -> str:
        return _fmt(values.get(key, ""))

    def optional(key: str, example: str) -> str:
        return f"{key}={val(key)}" if values.get(key) else f"# {key}={example}"

    common = [
        "# Wazuh certificates: point this at the CA that signed them (the Wazuh root CA is /etc/wazuh-indexer/certs/root-ca.pem on the Wazuh host).",
        optional("WAZUH_CA_BUNDLE", "/path/to/root-ca.pem"),
    ]
    if mode == "api":
        wazuh = [
            "# api mode reads the Wazuh manager API (port 55000, Wazuh 4.7 and earlier). The indexer is port 9200.",
            "WAZUH_MODE=api",
            f"WAZUH_API_URL={val('WAZUH_API_URL')}",
            "# A Wazuh manager API (RBAC) user.",
            f"WAZUH_API_USER={val('WAZUH_API_USER')}",
            f"WAZUH_API_PASSWORD={val('WAZUH_API_PASSWORD')}",
            *common,
        ]
    else:
        wazuh = [
            "# 9200 is the Wazuh indexer, which the exporter reads. 55000 is the Wazuh manager API.",
            "# WAZUH_MODE=auto would also need WAZUH_API_URL, WAZUH_API_USER and WAZUH_API_PASSWORD.",
            "WAZUH_MODE=indexer",
            f"WAZUH_INDEXER_URL={val('WAZUH_INDEXER_URL')}",
            "# An indexer user from the OpenSearch security plugin (not a Wazuh manager API user) with read on "
            "wazuh-states-vulnerabilities-* and wazuh-states-inventory-*.",
            f"WAZUH_INDEXER_USER={val('WAZUH_INDEXER_USER')}",
            f"WAZUH_INDEXER_PASSWORD={val('WAZUH_INDEXER_PASSWORD')}",
            *common,
            "# WAZUH_INDEXER_INDEX=wazuh-states-vulnerabilities-*",
        ]
    insecure = (
        [
            "# Development only: allows the plain http PBC_URL above (PBC-GRC must also set VM_ALLOW_INSECURE_TOKENS=true).",
            "PBC_ALLOW_INSECURE_TRANSPORT=true",
        ]
        if values.get("PBC_ALLOW_INSECURE_TRANSPORT") == "true"
        else []
    )
    lines = [
        "# pbc-vm-exporter settings. Keep this file readable only by the exporter account (chmod 600).",
        "# Quotes around a value are optional and are stripped. Comments go on their own line, never after a value.",
        "",
        "# The address this exporter host uses to reach PBC-GRC (https).",
        f"PBC_URL={val('PBC_URL')}",
        *insecure,
        "# Paste the token you copied; it is shown once.",
        f"PBC_SERVICE_TOKEN={val('PBC_SERVICE_TOKEN')}",
        "# A stable name for this source: a new label is a new source.",
        f"PBC_SOURCE_LABEL={val('PBC_SOURCE_LABEL')}",
        "# PBC-GRC certificate from a private CA: point this at the CA file.",
        optional("PBC_CA_BUNDLE", "/path/to/pbc-root-ca.pem"),
        "",
        *wazuh,
    ]
    return "\n".join(lines) + "\n"


def run_init(args: argparse.Namespace, stdout: TextIO, stderr: TextIO, flt: RedactingFilter) -> int:
    path = args.env_file
    exists = f"error: {path} already exists; init never overwrites a file\n"
    if os.path.exists(path):
        stderr.write(exists)
        return 2
    mode = args.mode
    values: dict[str, str] = {}
    values["PBC_URL"], plain_http = _ask_pbc_url(stderr)
    if plain_http:
        values["PBC_ALLOW_INSECURE_TRANSPORT"] = "true"
    values["PBC_SOURCE_LABEL"] = _ask_valid(
        _ask, f"Source label [{DEFAULT_LABEL}]: ", "PBC_SOURCE_LABEL", _label, stderr
    )
    values["PBC_CA_BUNDLE"] = _ask_valid(
        _ask, "PBC-GRC CA bundle file (optional, Enter to skip): ", "PBC_CA_BUNDLE", _ca_path("PBC_CA_BUNDLE"), stderr
    )
    token = _ask_valid(
        _ask_secret, "PBC-GRC service token (hidden, Enter to fill in later): ", "PBC_SERVICE_TOKEN", _token, stderr
    )
    if token:
        flt.secrets.append(token)
    values["PBC_SERVICE_TOKEN"] = token
    prefix = "WAZUH_INDEXER" if mode == "indexer" else "WAZUH_API"
    where = "Wazuh indexer URL (port 9200)" if mode == "indexer" else "Wazuh manager API URL (port 55000)"
    values[f"{prefix}_URL"] = _ask_valid(_ask, f"{where}: ", f"{prefix}_URL", _url(f"{prefix}_URL"), stderr)
    values[f"{prefix}_USER"] = _ask_valid(_ask, f"{prefix}_USER: ", f"{prefix}_USER", _plain(f"{prefix}_USER"), stderr)
    password = _ask_valid(
        _ask_secret, f"{prefix}_PASSWORD (hidden): ", f"{prefix}_PASSWORD", _secret(f"{prefix}_PASSWORD"), stderr
    )
    flt.secrets.append(password)
    values[f"{prefix}_PASSWORD"] = password
    values["WAZUH_CA_BUNDLE"] = _ask_valid(
        _ask, "Wazuh CA bundle file (optional, Enter to skip): ", "WAZUH_CA_BUNDLE", _ca_path("WAZUH_CA_BUNDLE"), stderr
    )
    text = build_env_text(values, mode)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        stderr.write(exists)
        return 2
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
    except BaseException:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    stdout.write(f"wrote {path} (readable by its owner only)\n")
    if plain_http:
        stdout.write("note: PBC-GRC must also run with VM_ALLOW_INSECURE_TOKENS=true to accept the token over plain http\n")
    stdout.write(f"next: pbc-vm-exporter check --env-file {path}\n")
    if _is_windows():
        stderr.write(
            f"warning: Windows does not apply mode 0600: restrict {path} to the exporter account:\n"
            f'  PowerShell:     icacls "{path}" /inheritance:r /grant:r "$($env:USERNAME):F"\n'
            f'  Command Prompt: icacls "{path}" /inheritance:r /grant:r "%USERNAME%:F"\n'
        )
    return 0
