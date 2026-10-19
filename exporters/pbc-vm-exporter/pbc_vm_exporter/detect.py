"""Chooses between the indexer reader (Wazuh 4.8+) and the manager API reader (4.7 and earlier)."""

import re
from typing import Any

from .errors import ConfigError
from .wazuh_api import API_FIELDS

_VERSION = re.compile(r"^v?([0-9]+)\.([0-9]+)")


def mode_for_version(v: str | None) -> str:
    m = _VERSION.match(v.strip()) if isinstance(v, str) else None
    if not m:
        raise ConfigError("cannot detect the Wazuh version; set WAZUH_MODE to indexer or api")
    major, minor = int(m.group(1)), int(m.group(2))
    if major > 4 or (major == 4 and minor >= 8):
        return "indexer"
    if major == 4:
        return "api"
    raise ConfigError("cannot detect a supported mode for this Wazuh version (3.x); set WAZUH_MODE")


def resolve_mode(cfg: Any, api_reader: Any) -> tuple[str, str | None]:
    """(mode, manager hostname). An explicit mode makes no HTTP call; auto reads GET / for the version."""
    if cfg.wazuh_mode in ("indexer", "api"):
        return cfg.wazuh_mode, None
    if api_reader is None:
        raise ConfigError("WAZUH_MODE=auto needs WAZUH_API_URL, WAZUH_API_USER and WAZUH_API_PASSWORD")
    api_reader.authenticate()  # raises WazuhReadError when the API is unreachable
    info = api_reader.info()
    mode = mode_for_version(info.get(API_FIELDS["info"]["version"]))
    return mode, info.get(API_FIELDS["info"]["hostname"])
