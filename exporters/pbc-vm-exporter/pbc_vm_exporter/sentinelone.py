"""Reads vulnerability state from the SentinelOne management console API (v2.1).

From vendor documentation, not verified against a live tenant; a wrong guess is a one-line fix here.
Every endpoint path and field name is in S1_PATHS and S1_FIELDS below. Reading vulnerabilities needs a SentinelOne
Vulnerability Management licence and an API token whose role may read agents and application risks.

Hosts: an agent is identified by its uuid (stable per install). Risk rows join to agents on the risk's endpoint id.
Only hosts with at least one finding are returned (a host with none is not reported; see the README, Limitations).
Everything is read before anything is returned: any error raises SentinelOneReadError and no partial host escapes.
Logs and errors carry counts only: never a hostname, an agent or site id, or an address.
"""

import json
import logging
import time
from pathlib import Path
from typing import Any, Callable

from .config import SentinelOneSettings
from .errors import SentinelOneReadError
from .transport import make_session
from .vendor_http import PAGE_CAP, json_object, send
from .wazuh_indexer import ROW_KEYS, get_path

log = logging.getLogger(__name__)

# From vendor documentation, not verified against a live tenant; a wrong guess is a one-line fix here.
S1_PATHS = {
    "base": "/web/api/v2.1",
    "agents": "/agents",
    "risks": "/application-management/risks",
}

# From vendor documentation, not verified against a live tenant; a wrong guess is a one-line fix here.
S1_FIELDS = {
    "page": {"items": "data", "next_cursor": "pagination.nextCursor"},
    "agent": {"id": "id", "uuid": "uuid", "hostname": "computerName", "os_name": "osName", "os_version": "osRevision",
              "ip": "lastIpToMgmt", "interfaces": "networkInterfaces", "decommissioned": "isDecommissioned"},
    "interface": {"inet": "inet", "physical": "physical"},
    "risk": {"endpoint_id": "endpointId", "vuln_id": "cveId", "severity": "severity", "score": "nvdBaseScore",
             "score_version": None, "package_name": "applicationName", "package_version": "applicationVersion",
             "fixed_version": None, "detected_at": "detectionDate", "published_at": "publishedDate", "refs": None,
             "title": None},
}

# SentinelOne severity word (lower case) -> the word the adapter understands. An unknown word grades UNKNOWN there.
S1_SEVERITY = {"critical": "critical", "high": "high", "medium": "medium", "low": "low", "none": "untriaged"}

EXPIRED_HINT = (
    "SentinelOne rejected the API token (HTTP 401); it may have expired: generate a new token and update S1_API_TOKEN"
)
PAGE_LIMIT = 1000


def _text(value: Any) -> str | None:
    if isinstance(value, bool) or value is None:
        return None
    text = str(value).strip()
    return text or None


def _management_mac(agent: dict, ip: str | None) -> str | None:
    """The MAC of the interface that holds the management IP (and only that one); None when it cannot be told."""
    if ip is None:
        return None
    interfaces = get_path(agent, S1_FIELDS["agent"]["interfaces"])
    if not isinstance(interfaces, list):
        return None
    for interface in interfaces:
        if not isinstance(interface, dict):
            continue
        inet = get_path(interface, S1_FIELDS["interface"]["inet"])
        if isinstance(inet, str):
            inet = [inet]
        if isinstance(inet, list) and ip in [_text(i) for i in inet]:
            return _text(get_path(interface, S1_FIELDS["interface"]["physical"]))
    return None


def group_sentinelone(agents: list[dict], risks: list[dict]) -> list[dict]:
    """Joins risk rows to agents into the canonical raw host shape (the adapter's input). Pure; logs counts only."""
    hosts: dict[str, dict] = {}  # keyed by the vendor's agent id (the join key), not by uuid
    af = S1_FIELDS["agent"]
    decommissioned = no_uuid = 0
    for agent in agents:
        if not isinstance(agent, dict):
            continue
        if get_path(agent, af["decommissioned"]) is True:
            decommissioned += 1
            continue
        key = _text(get_path(agent, af["id"]))
        uuid = _text(get_path(agent, af["uuid"]))
        if key is None:
            continue
        if uuid is None:
            no_uuid += 1
            continue
        ip = _text(get_path(agent, af["ip"]))
        hosts[key] = {
            "agent_id": uuid, "hostname": get_path(agent, af["hostname"]), "ip": ip, "mac": _management_mac(agent, ip),
            "os_name": get_path(agent, af["os_name"]), "os_version": get_path(agent, af["os_version"]), "rows": [],
        }
    unknown = 0
    rf = S1_FIELDS["risk"]
    for risk in risks:
        if not isinstance(risk, dict):
            continue
        host = hosts.get(_text(get_path(risk, rf["endpoint_id"])) or "")
        if host is None:
            unknown += 1
            continue
        row = {k: get_path(risk, rf[k]) for k in ROW_KEYS}
        row["severity"] = S1_SEVERITY.get(str(row["severity"]).strip().lower(), "untriaged")
        host["rows"].append(row)
    if decommissioned or no_uuid or unknown:
        log.info(
            "sentinelone: %d decommissioned agent(s) excluded, %d agent(s) without a uuid skipped, "
            "%d risk row(s) dropped (unknown endpoint)", decommissioned, no_uuid, unknown,
        )
    return [h for h in hosts.values() if h["rows"]]


def load_sentinelone_sample(path: Path) -> tuple[list[dict], list[dict]]:
    """The bundled sample: vendor-shaped agents and risk rows (the two lists the live reader collects)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["agents"], data["risks"]


class SentinelOneReader:
    def __init__(
        self, settings: SentinelOneSettings, timeout: int, *, session: Any = None,
        sleep: Callable[[float], None] = time.sleep, page_size: int = PAGE_LIMIT,
    ):
        self.base = f"{settings.console_url.rstrip('/')}{S1_PATHS['base']}"
        self.token = settings.api_token
        self.site_ids = ",".join(settings.site_ids)
        self.verify = settings.verify
        self.timeout = timeout
        self.session = session if session is not None else make_session(settings.proxy_url)
        self.sleep = sleep
        self.page_size = page_size

    def _get(self, path: str, what: str, params: dict) -> dict:
        resp = send(
            self.session, "get", f"{self.base}{path}", f"sentinelone {what}", SentinelOneReadError,
            verify=self.verify, timeout=self.timeout, sleep=self.sleep, params=params,
            headers={"Authorization": f"ApiToken {self.token}", "Accept": "application/json"},
        )
        if resp.status_code == 401:
            raise SentinelOneReadError(EXPIRED_HINT)
        if resp.status_code == 403:
            raise SentinelOneReadError(
                f"sentinelone {what} returned HTTP 403: the token's role may lack permission, or the "
                "Vulnerability Management licence is missing"
            )
        if resp.status_code >= 300:
            raise SentinelOneReadError(f"sentinelone {what} returned HTTP {resp.status_code}")
        return json_object(resp, f"sentinelone {what}", SentinelOneReadError)

    def _paged(self, path: str, what: str) -> list[dict]:
        items: list[dict] = []
        seen: set[str] = set()
        cursor: str | None = None
        for _ in range(PAGE_CAP):
            params: dict[str, Any] = {"siteIds": self.site_ids, "limit": self.page_size}
            if cursor is not None:
                params["cursor"] = cursor
            data = self._get(path, what, params)
            page = get_path(data, S1_FIELDS["page"]["items"])
            if not isinstance(page, list):
                raise SentinelOneReadError(f"sentinelone {what} returned an unexpected response body")
            items.extend(i for i in page if isinstance(i, dict))
            nxt = get_path(data, S1_FIELDS["page"]["next_cursor"])
            if not isinstance(nxt, str) or not nxt:
                return items
            if nxt in seen:
                raise SentinelOneReadError(f"sentinelone {what} repeated a page cursor")
            seen.add(nxt)
            cursor = nxt
        raise SentinelOneReadError(f"sentinelone {what} exceeded {PAGE_CAP} pages")

    def fetch_hosts(self) -> list[dict]:
        agents = self._paged(S1_PATHS["agents"], "agents")
        risks = self._paged(S1_PATHS["risks"], "risks")
        log.info("sentinelone: read %d agent(s) and %d risk row(s)", len(agents), len(risks))
        return group_sentinelone(agents, risks)
