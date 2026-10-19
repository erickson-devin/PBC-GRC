"""Reads vulnerability state from the Wazuh manager API (Wazuh 4.7 and earlier).

Every field name and endpoint below is from knowledge of the Wazuh 4.x API, not from a running system: verify against
the running Wazuh before the first live push. A wrong guess is a one-line fix in API_FIELDS.
"""

import logging
from typing import Any

import requests

from .config import redact
from .errors import WazuhReadError
from .transport import make_session
from .wazuh_indexer import get_path

log = logging.getLogger(__name__)

# From knowledge; verify against the running Wazuh.
API_FIELDS = {
    "info":  {"version": "api_version", "hostname": "hostname"},                        # GET / -> data
    "agent": {"agent_id": "id", "agent_name": "name", "ip": "ip",
              "os_name": "os.name", "os_version": "os.version", "status": "status"},    # GET /agents
    "scan":  {"last_full_scan": "last_full_scan"},                                      # GET /vulnerability/{id}/last_scan
    "vuln":  {"vuln_id": "cve", "package_name": "name", "package_version": "version",
              "fixed_version": None, "severity": "severity", "score": "cvss3_score",
              "score_version": None, "detected_at": "detection_time", "published_at": "published",
              "refs": "external_references", "title": "title"},                         # GET /vulnerability/{id}
}

AGENT_SELECT = "id,name,ip,os.name,os.version,status"


class ApiReader:
    def __init__(
        self, url: str, user: str | None, password: str | None, verify: bool | str, timeout: int,
        *, session: Any = None, page_size: int = 500,
    ):
        self.url = url.rstrip("/")
        self.user = user or ""
        self.password = password or ""
        self.verify = verify
        self.timeout = timeout
        self.session = session if session is not None else make_session()
        self.page_size = page_size
        self.token: str | None = None

    def _send(self, method: str, url: str, what: str, **kwargs: Any):
        try:
            return getattr(self.session, method)(
                url, verify=self.verify, timeout=(10, self.timeout), allow_redirects=False, **kwargs
            )
        except requests.RequestException as err:
            raise WazuhReadError(
                f"wazuh api {what} failed: {type(err).__name__}: {redact(str(err), [self.password])}"
            ) from None

    @staticmethod
    def _json(resp: Any, what: str) -> dict:
        try:
            data = resp.json()
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise WazuhReadError(f"wazuh api {what} returned an unexpected response body")
        return data

    def authenticate(self) -> None:
        resp = self._send(
            "post", f"{self.url}/security/user/authenticate", "authentication", auth=(self.user, self.password)
        )
        if resp.status_code >= 300:
            raise WazuhReadError(f"wazuh api authentication returned HTTP {resp.status_code}")
        token = (self._json(resp, "authentication").get("data") or {}).get("token")
        if not isinstance(token, str) or not token:
            raise WazuhReadError("wazuh api authentication returned no token")
        self.token = token

    def _get(self, path: str, what: str, params: dict | None = None) -> dict:
        if self.token is None:
            self.authenticate()
        for attempt in (1, 2):
            resp = self._send(
                "get", f"{self.url}{path}", what, params=params, headers={"Authorization": f"Bearer {self.token}"}
            )
            if resp.status_code == 401 and attempt == 1:
                log.info("wazuh api token rejected; authenticating again")
                self.authenticate()
                continue
            if resp.status_code >= 300:
                raise WazuhReadError(f"wazuh api {what} returned HTTP {resp.status_code}")
            return self._json(resp, what)
        raise WazuhReadError(f"wazuh api {what} failed")  # unreachable

    def info(self) -> dict:
        data = self._get("/", "info").get("data")
        return data if isinstance(data, dict) else {}

    def _paged(self, path: str, what: str, extra: dict | None = None) -> list[dict]:
        items: list[dict] = []
        offset = 0
        while True:
            params = {"offset": offset, "limit": self.page_size, **(extra or {})}
            data = self._get(path, what, params).get("data") or {}
            page = data.get("affected_items") or []
            items.extend(i for i in page if isinstance(i, dict))
            total = data.get("total_affected_items")
            offset += len(page)
            if not page or not isinstance(total, int) or offset >= total:
                return items

    def list_agents(self) -> list[dict]:
        return self._paged("/agents", "agents", {"select": AGENT_SELECT})

    def fetch_hosts(self) -> list[dict]:
        hosts: list[dict] = []
        for agent in self.list_agents():
            fields = {k: get_path(agent, p) for k, p in API_FIELDS["agent"].items()}
            agent_id = fields["agent_id"]
            if agent_id is None:
                continue
            if fields["status"] == "never_connected":
                log.info("skipping agent %s: never connected", agent_id)
                continue
            scan = self._get(f"/vulnerability/{agent_id}/last_scan", f"last scan of agent {agent_id}").get("data") or {}
            scan_items = scan.get("affected_items")
            scan_doc = scan_items[0] if isinstance(scan_items, list) and scan_items else scan
            if get_path(scan_doc, API_FIELDS["scan"]["last_full_scan"]) is None:
                log.info("skipping agent %s: no completed vulnerability scan", agent_id)
                continue
            rows = []
            for item in self._paged(f"/vulnerability/{agent_id}", f"vulnerabilities of agent {agent_id}"):
                rows.append({k: get_path(item, p) for k, p in API_FIELDS["vuln"].items()})
            hosts.append({
                "agent_id": agent_id, "hostname": fields["agent_name"], "ip": fields["ip"], "mac": None,
                "os_name": fields["os_name"], "os_version": fields["os_version"], "rows": rows,
            })
        return hosts
