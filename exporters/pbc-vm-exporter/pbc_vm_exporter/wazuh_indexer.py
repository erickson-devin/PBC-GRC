"""Reads vulnerability documents from the Wazuh indexer (Wazuh 4.8 and later).

Every field name below is from knowledge of the Wazuh 4.8+ vulnerability state index, not from a running system:
verify against the running Wazuh before the first live push. A wrong guess is a one-line fix in INDEXER_FIELDS.

Limitation: only hosts that have vulnerability documents are returned. A fully patched host has no documents, so it is
never reported and its last findings are not closed by this exporter (see the README, Limitations).
"""

import logging
from typing import Any

import requests

from .config import redact
from .errors import WazuhReadError
from .transport import make_session

log = logging.getLogger(__name__)

DEFAULT_INDEX = "wazuh-states-vulnerabilities-*"

# canonical key -> dotted path in _source; None = not available. From knowledge; verify against the running Wazuh.
INDEXER_FIELDS: dict[str, str | None] = {
    "agent_id": "agent.id", "agent_name": "agent.name",
    "os_name": "host.os.name", "os_version": "host.os.version",
    "ip": None, "mac": None,
    "package_name": "package.name", "package_version": "package.version",
    "fixed_version": None,    # no clean fixed-version field known in 4.8 docs
    "vuln_id": "vulnerability.id", "severity": "vulnerability.severity",
    "score": "vulnerability.score.base", "score_version": "vulnerability.score.version",
    "detected_at": "vulnerability.detected_at", "published_at": "vulnerability.published_at",
    "refs": "vulnerability.reference",   # comma-separated string
    "title": None,                       # description is a paragraph, not a title
}

HOST_KEYS = ("agent_id", "agent_name", "ip", "mac", "os_name", "os_version")
ROW_KEYS = (
    "vuln_id", "severity", "score", "score_version", "package_name", "package_version", "fixed_version",
    "detected_at", "published_at", "refs", "title",
)


def get_path(doc: Any, dotted: str | None) -> Any:
    """Follows a dotted path through nested dicts; None when any segment is missing."""
    if dotted is None:
        return None
    cur = doc
    for seg in dotted.split("."):
        if not isinstance(cur, dict) or seg not in cur:
            return None
        cur = cur[seg]
    return cur


def doc_to_row(source: dict) -> dict:
    """The canonical flat row for one indexer document."""
    return {key: get_path(source, path) for key, path in INDEXER_FIELDS.items()}


def group_documents(sources: list[dict]) -> list[dict]:
    """Groups documents per agent into the canonical raw host shape the adapter consumes."""
    hosts: dict[str, dict] = {}
    for source in sources:
        row = doc_to_row(source) if isinstance(source, dict) else {}
        agent = row.get("agent_id")
        if agent is None or str(agent).strip() == "":
            log.warning("skipping an indexer document without an agent id")
            continue
        key = str(agent)
        host = hosts.get(key)
        if host is None:
            host = {
                "agent_id": agent, "hostname": row.get("agent_name"), "ip": row.get("ip"), "mac": row.get("mac"),
                "os_name": row.get("os_name"), "os_version": row.get("os_version"), "rows": [],
            }
            hosts[key] = host
        host["rows"].append({k: row.get(k) for k in ROW_KEYS})
    return list(hosts.values())


class IndexerReader:
    def __init__(
        self, url: str, user: str | None, password: str | None, verify: bool | str, timeout: int,
        *, index: str = DEFAULT_INDEX, session: Any = None, page_size: int = 1000,
    ):
        self.url = url.rstrip("/")
        self.auth = (user or "", password or "")
        self.password = password
        self.verify = verify
        self.timeout = timeout
        self.index = index
        self.session = session if session is not None else make_session()
        self.page_size = page_size

    def _call(self, method: str, url: str, what: str, **kwargs: Any):
        try:
            resp = getattr(self.session, method)(
                url, auth=self.auth, verify=self.verify, timeout=(10, self.timeout), allow_redirects=False, **kwargs
            )
        except requests.RequestException as err:
            raise WazuhReadError(
                f"indexer {what} failed: {type(err).__name__}: {redact(str(err), [self.password or ''])}"
            ) from None
        if resp.status_code >= 300:
            raise WazuhReadError(f"indexer {what} returned HTTP {resp.status_code}")
        return resp

    @staticmethod
    def _page(resp: Any) -> tuple[list[dict], str | None]:
        try:
            data = resp.json()
            hits = data["hits"]["hits"]
            scroll_id = data.get("_scroll_id")
        except (ValueError, KeyError, TypeError, AttributeError):
            raise WazuhReadError("indexer returned an unexpected response body") from None
        if not isinstance(hits, list):
            raise WazuhReadError("indexer returned an unexpected response body")
        return [h.get("_source") for h in hits if isinstance(h, dict)], scroll_id

    def fetch_hosts(self) -> list[dict]:
        sources: list[dict] = []
        scroll_id: str | None = None
        try:
            body = {"size": self.page_size, "sort": ["_doc"], "query": {"match_all": {}}}
            resp = self._call("post", f"{self.url}/{self.index}/_search?scroll=2m", "search", json=body)
            page, scroll_id = self._page(resp)
            while page:
                sources.extend(s for s in page if s is not None)
                if scroll_id is None:
                    break
                resp = self._call(
                    "post", f"{self.url}/_search/scroll", "scroll", json={"scroll": "2m", "scroll_id": scroll_id}
                )
                page, next_id = self._page(resp)
                scroll_id = next_id or scroll_id
        finally:
            if scroll_id is not None:
                try:
                    self.session.delete(
                        f"{self.url}/_search/scroll", json={"scroll_id": [scroll_id]}, auth=self.auth,
                        verify=self.verify, timeout=(10, self.timeout), allow_redirects=False,
                    )
                except Exception:  # best effort: the scroll context expires on its own
                    pass
        return group_documents(sources)
