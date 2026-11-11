"""Reads vulnerability documents from the Wazuh indexer (Wazuh 4.8 and later).

Every field name below is from knowledge of the Wazuh 4.8+ vulnerability state index, not from a running system:
verify against the running Wazuh before the first live push. A wrong guess is a one-line fix in INDEXER_FIELDS.

Host inventory (hardware, system, packages, hotfixes, interfaces, networks) comes from the wazuh-states-inventory-*
indices of Wazuh 4.14 (field names checked against a real 4.14 manager); see fetch_inventory.

Limitation: only hosts that have vulnerability documents are returned. A fully patched host has no documents, so it is
never reported and its last findings are not closed by this exporter (see the README, Limitations).
"""

import logging
from typing import Any

import requests

from .config import redact
from .diagnose import classify
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

INVENTORY_KINDS = ("hardware", "system", "packages", "hotfixes", "interfaces", "networks")
INVENTORY_INDICES = {kind: f"wazuh-states-inventory-{kind}-*" for kind in INVENTORY_KINDS}
MAX_SOFTWARE_PER_HOST = 10000

# Wazuh 4.14 inventory state indices (field names checked against a real 4.14.10 manager). Only these fields are read.
_AGENT_FIELDS = ["agent.id", "agent.name", "agent.host.ip"]
INVENTORY_SOURCE_FIELDS: dict[str, list[str]] = {
    "hardware": _AGENT_FIELDS + [
        "host.cpu.name", "host.cpu.cores", "host.cpu.speed", "host.memory.total", "host.serial_number",
    ],
    "system": _AGENT_FIELDS + [
        "host.architecture", "host.os.name", "host.os.version", "host.os.platform", "host.os.kernel.release",
    ],
    "packages": _AGENT_FIELDS + [
        "package.name", "package.version", "package.vendor", "package.architecture", "package.type",
        "package.installed",
    ],
    "hotfixes": _AGENT_FIELDS + ["package.hotfix.name"],
    "interfaces": _AGENT_FIELDS + ["host.mac", "interface.name", "interface.state"],
    "networks": _AGENT_FIELDS + ["interface.name", "network.ip"],
}

_ZERO_MAC = frozenset("0:-.")

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


def _text(value: Any) -> str | None:
    """A stripped non-empty string, or None. A list yields its first usable string (agent.host.ip can be an array)."""
    if isinstance(value, list):
        for item in value:
            text = _text(item)
            if text is not None:
                return text
        return None
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _usable_mac(mac: str | None) -> bool:
    return mac is not None and not set(mac) <= _ZERO_MAC


def _choose_mac(ip: str | None, interfaces: list[dict], networks: list[tuple[str | None, str | None]]) -> str | None:
    """The MAC of the interface that carries the agent's reported address; else the first interface that is up."""
    if ip is not None:
        names = {name for name, net_ip in networks if net_ip == ip and name is not None}
        for iface in sorted(interfaces, key=lambda i: i["name"] or ""):
            if iface["name"] in names and _usable_mac(iface["mac"]):
                return iface["mac"]
    for iface in sorted(interfaces, key=lambda i: i["name"] or ""):
        if iface["state"] == "up" and _usable_mac(iface["mac"]):
            return iface["mac"]
    return None


def group_inventory(docs: dict[str, list]) -> dict[str, dict]:
    """Groups the inventory documents (kind -> _source list) per agent into the canonical raw inventory shape.

    Per agent: agent_name, ip, mac, os_name/os_version/os_platform/os_kernel, hardware (dict or None),
    software (list or None) and software_overflow. software is only set when the agent has package documents;
    an agent over the per-host limit gets software_overflow and no software list (a partial list is never sent).
    """
    agents: dict[str, dict] = {}

    def state(source: Any) -> dict | None:
        agent = get_path(source, "agent.id") if isinstance(source, dict) else None
        if agent is None or str(agent).strip() == "":
            return None
        entry = agents.get(str(agent))
        if entry is None:
            entry = agents[str(agent)] = {
                "agent_name": None, "ip": None, "os_name": None, "os_version": None, "os_platform": None,
                "os_kernel": None, "hardware": {}, "packages": None, "hotfixes": [], "overflow": False,
                "interfaces": [], "networks": [],
            }
        if entry["agent_name"] is None:
            entry["agent_name"] = _text(get_path(source, "agent.name"))
        if entry["ip"] is None:
            entry["ip"] = _text(get_path(source, "agent.host.ip"))
        return entry

    def keep(entry: dict, key: str, value: Any) -> None:
        if value is not None and value != "" and key not in entry["hardware"]:
            entry["hardware"][key] = value

    skipped = 0
    for kind in INVENTORY_KINDS:
        for source in docs.get(kind) or []:
            entry = state(source)
            if entry is None:
                skipped += 1
                continue
            if kind == "hardware":
                keep(entry, "cpu_name", _text(get_path(source, "host.cpu.name")))
                keep(entry, "cpu_cores", get_path(source, "host.cpu.cores"))
                keep(entry, "cpu_mhz", get_path(source, "host.cpu.speed"))
                keep(entry, "memory_bytes", get_path(source, "host.memory.total"))
                keep(entry, "serial_number", _text(get_path(source, "host.serial_number")))
            elif kind == "system":
                keep(entry, "architecture", _text(get_path(source, "host.architecture")))
                for key, path in (
                    ("os_name", "host.os.name"), ("os_version", "host.os.version"),
                    ("os_platform", "host.os.platform"), ("os_kernel", "host.os.kernel.release"),
                ):
                    if entry[key] is None:
                        entry[key] = _text(get_path(source, path))
            elif kind == "packages":
                if entry["packages"] is None:
                    entry["packages"] = {}
                item = {
                    "name": get_path(source, "package.name"), "version": get_path(source, "package.version"),
                    "vendor": get_path(source, "package.vendor"),
                    "architecture": get_path(source, "package.architecture"), "type": get_path(source, "package.type"),
                    "installed": get_path(source, "package.installed"),
                }
                key = (str(item["name"]), str(item["version"] or ""), str(item["architecture"] or ""))
                if key not in entry["packages"]:
                    entry["packages"][key] = item
            elif kind == "hotfixes":
                name = _text(get_path(source, "package.hotfix.name"))
                if name is not None and name not in entry["hotfixes"]:
                    entry["hotfixes"].append(name)
            elif kind == "interfaces":
                entry["interfaces"].append({
                    "name": _text(get_path(source, "interface.name")), "mac": _text(get_path(source, "host.mac")),
                    "state": (_text(get_path(source, "interface.state")) or "").lower(),
                })
            else:
                entry["networks"].append((_text(get_path(source, "interface.name")), _text(get_path(source, "network.ip"))))
    if skipped:
        log.warning("skipping %d inventory document(s) without an agent id", skipped)

    out: dict[str, dict] = {}
    for agent, entry in agents.items():
        software: list[dict] | None = None
        overflow = False
        if entry["packages"] is not None:
            software = list(entry["packages"].values())
            software.extend({"name": name, "type": "hotfix"} for name in entry["hotfixes"])
            if len(software) > MAX_SOFTWARE_PER_HOST:
                software, overflow = None, True
        out[agent] = {
            "agent_name": entry["agent_name"], "ip": entry["ip"],
            "mac": _choose_mac(entry["ip"], entry["interfaces"], entry["networks"]),
            "os_name": entry["os_name"], "os_version": entry["os_version"], "os_platform": entry["os_platform"],
            "os_kernel": entry["os_kernel"], "hardware": entry["hardware"] or None, "software": software,
            "software_overflow": overflow,
        }
    return out


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
            message = f"indexer {what} failed: {type(err).__name__}: {redact(str(err), [self.password or ''])}"
            _code, hint = classify(err, "indexer", self.url)
            raise WazuhReadError(message + (f"; hint: {hint}" if hint else "")) from None
        if resp.status_code >= 300:
            message = f"indexer {what} returned HTTP {resp.status_code}"
            _code, hint = classify(resp.status_code, "indexer", self.url)
            raise WazuhReadError(message + (f"; hint: {hint}" if hint else ""))
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

    def _scroll(self, index: str, body: dict, *, lenient: bool = False) -> list[dict]:
        """Every document of `index` matching `body`, read with a scroll that is always cleared afterwards.
        `lenient` makes a missing index an empty result instead of an HTTP 404."""
        query = "scroll=2m" + ("&ignore_unavailable=true&allow_no_indices=true" if lenient else "")
        sources: list[dict] = []
        scroll_id: str | None = None
        try:
            resp = self._call("post", f"{self.url}/{index}/_search?{query}", "search", json=body)
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
        return sources

    def fetch_hosts(self) -> list[dict]:
        body = {"size": self.page_size, "sort": ["_doc"], "query": {"match_all": {}}}
        return group_documents(self._scroll(self.index, body))

    def fetch_inventory(self) -> dict[str, dict]:
        """Hardware, system, packages, hotfixes and network inventory per agent id. A missing or empty index is no
        inventory; a read error is a WazuhReadError (the caller decides whether to go on without inventory)."""
        docs: dict[str, list] = {}
        for kind in INVENTORY_KINDS:
            body = {
                "size": self.page_size, "sort": ["_doc"], "query": {"match_all": {}},
                "_source": INVENTORY_SOURCE_FIELDS[kind],
            }
            docs[kind] = self._scroll(INVENTORY_INDICES[kind], body, lenient=True)
        return group_inventory(docs)

    def count_inventory_hosts(self) -> int | None:
        """Number of system inventory documents (one per agent), or None when the response is not understood."""
        resp = self._call(
            "post", f"{self.url}/{INVENTORY_INDICES['system']}/_search?ignore_unavailable=true&allow_no_indices=true",
            "search", json={"size": 0, "track_total_hits": True},
        )
        try:
            total = resp.json()["hits"]["total"]
        except (ValueError, KeyError, TypeError, AttributeError):
            return None
        count = total.get("value") if isinstance(total, dict) else total
        return count if isinstance(count, int) and not isinstance(count, bool) else None
