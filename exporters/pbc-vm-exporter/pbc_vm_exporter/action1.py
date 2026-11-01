"""Reads missing updates (patches) from the Action1 cloud API as vulnerability findings.

From vendor documentation, not verified against a live tenant; a wrong guess is a one-line fix here.
Every endpoint path and field name is in A1_PATHS and A1_FIELDS below; the confidence in them is low to medium.

Findings: one per CVE a missing security update fixes. A security update that names no CVE becomes one finding keyed by
its KB / update id (ACTION1_INCLUDE_PATCH_FINDINGS, on by default). Updates that are not security updates are dropped
and counted. Only hosts with at least one finding are returned (see the README, Limitations).

Everything is read before anything is returned: any error raises Action1ReadError and no partial host escapes. A
`next_page` link is followed only when its scheme, host and port equal ACTION1_BASE_URL's, so the bearer token cannot be
sent anywhere else. Logs and errors carry counts only: never a hostname, an endpoint or organization id, or an address.
"""

import json
import logging
import re
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlsplit

from .config import Action1Settings
from .errors import Action1ReadError
from .transport import make_session
from .vendor_http import PAGE_CAP, json_object, send
from .wazuh_indexer import get_path

log = logging.getLogger(__name__)

# From vendor documentation, not verified against a live tenant; a wrong guess is a one-line fix here.
A1_PATHS = {
    "token": "/oauth2/token",                                              # POST, form client_id / client_secret
    "endpoints": "/endpoints/managed/{org}",                               # GET, paged
    "updates": "/endpoints/managed/{org}/{endpoint}/missing-updates",      # GET, paged, per endpoint
}

# From vendor documentation, not verified against a live tenant; a wrong guess is a one-line fix here.
A1_FIELDS = {
    "token": {"access_token": "access_token"},
    "page": {"items": "items", "next_page": "next_page"},
    "endpoint": {"id": "id", "hostname": "name", "ip": "address", "mac": "MAC", "os_name": "OS", "os_version": None},
    "update": {"id": "id", "name": "name", "version": "version", "installed_version": None, "severity": "severity",
               "release_date": "release_date", "security": "security", "cves": "cve", "kb": "kb",
               "category": "category"},
}

# Action1 severity word (lower case) -> the word the adapter understands.
A1_SEVERITY = {"critical": "critical", "important": "high", "moderate": "medium", "low": "low",
               "unspecified": "untriaged"}

_CVE = re.compile(r"CVE-[0-9]{4}-[0-9]{4,7}", re.IGNORECASE)
_TRUE_WORDS = ("true", "yes", "1", "security")
PAGE_LIMIT = 100


def _text(value: Any) -> str | None:
    if isinstance(value, bool) or value is None:
        return None
    text = str(value).strip()
    return text or None


def _cve_ids(value: Any) -> list[str]:
    """CVE ids from a list or a comma / space separated string; anything else in it is ignored."""
    parts = re.split(r"[,\s;]+", value) if isinstance(value, str) else value if isinstance(value, list) else []
    out: list[str] = []
    for part in parts:
        if isinstance(part, str) and _CVE.fullmatch(part.strip()):
            cve = part.strip().upper()
            if cve not in out:
                out.append(cve)
    return out


def _is_security(flag: Any, has_cves: bool) -> bool:
    if isinstance(flag, bool):
        return flag
    if isinstance(flag, str) and flag.strip():
        return flag.strip().lower() in _TRUE_WORDS
    return has_cves  # no usable flag: an update that names CVEs is a security update


def update_rows(update: dict, *, include_patch_findings: bool = True) -> tuple[list[dict], int, int]:
    """Rows for one missing update, plus how many updates were dropped as non-security / without a CVE."""
    uf = A1_FIELDS["update"]
    cves = _cve_ids(get_path(update, uf["cves"]))
    if not _is_security(get_path(update, uf["security"]), bool(cves)):
        return [], 1, 0
    name = _text(get_path(update, uf["name"]))
    release = get_path(update, uf["release_date"])
    base = {
        "severity": A1_SEVERITY.get(str(get_path(update, uf["severity"])).strip().lower(), "untriaged"),
        "score": None, "score_version": None,
        "package_name": name, "package_version": _text(get_path(update, uf["installed_version"])),
        "fixed_version": _text(get_path(update, uf["version"])),
        "detected_at": None, "published_at": release, "refs": None, "title": None,
        # kept for a later phase; the adapter ignores them
        "patch_id": _text(get_path(update, uf["id"])), "released_at": release,
        "category": _text(get_path(update, uf["category"])), "cves": cves,
    }
    if cves:
        return [dict(base, vuln_id=cve) for cve in cves], 0, 0
    if not include_patch_findings:
        return [], 0, 1
    patch = _text(get_path(update, uf["kb"])) or base["patch_id"]
    return [dict(base, vuln_id=patch, title=name)], 0, 0


def group_action1(pairs: list[tuple[dict, list[dict]]], include_patch_findings: bool = True) -> list[dict]:
    """(endpoint, missing updates) pairs -> the canonical raw hosts (the adapter's input). Pure; logs counts only."""
    ef = A1_FIELDS["endpoint"]
    hosts: list[dict] = []
    not_security = no_cve = 0
    for endpoint, updates in pairs:
        agent_id = _text(get_path(endpoint, ef["id"]))
        if agent_id is None:
            continue
        rows: list[dict] = []
        for update in updates:
            if not isinstance(update, dict):
                continue
            found, dropped_non_security, dropped_no_cve = update_rows(
                update, include_patch_findings=include_patch_findings
            )
            rows.extend(found)
            not_security += dropped_non_security
            no_cve += dropped_no_cve
        if not rows:
            continue
        hosts.append({
            "agent_id": agent_id, "hostname": get_path(endpoint, ef["hostname"]), "ip": get_path(endpoint, ef["ip"]),
            "mac": get_path(endpoint, ef["mac"]), "os_name": get_path(endpoint, ef["os_name"]),
            "os_version": get_path(endpoint, ef["os_version"]), "rows": rows,
        })
    if not_security or no_cve:
        log.info("action1: %d non-security update(s) dropped, %d security update(s) without a CVE dropped",
                 not_security, no_cve)
    return hosts


def load_action1_sample(path: Path) -> list[tuple[dict, list[dict]]]:
    """The bundled sample: vendor-shaped endpoints, each with its missing updates under `missing_updates`."""
    data = json.loads(path.read_text(encoding="utf-8"))
    return [(e, e.get("missing_updates") or []) for e in data["endpoints"]]


def _origin(url: str) -> tuple[str, str, int] | None:
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port or {"https": 443, "http": 80}.get(parts.scheme)
    except ValueError:
        return None
    if parts.username is not None or parts.password is not None or not host or port is None:
        return None
    return parts.scheme, host.lower(), port


class Action1Reader:
    def __init__(
        self, settings: Action1Settings, timeout: int, *, session: Any = None,
        sleep: Callable[[float], None] = time.sleep, page_size: int = PAGE_LIMIT,
    ):
        self.base = settings.base_url.rstrip("/")
        self.client_id = settings.client_id
        self.client_secret = settings.client_secret
        self.org = settings.org_id
        self.verify = settings.verify
        self.include_patch_findings = settings.include_patch_findings
        self.timeout = timeout
        self.session = session if session is not None else make_session(settings.proxy_url)
        self.sleep = sleep
        self.page_size = page_size
        self.token: str | None = None

    def _send(self, method: str, url: str, what: str, **kwargs: Any):
        return send(
            self.session, method, url, f"action1 {what}", Action1ReadError,
            verify=self.verify, timeout=self.timeout, sleep=self.sleep, **kwargs,
        )

    def authenticate(self) -> None:
        resp = self._send(
            "post", f"{self.base}{A1_PATHS['token']}", "authentication",
            data={"client_id": self.client_id, "client_secret": self.client_secret},
        )
        if resp.status_code >= 300:
            raise Action1ReadError(f"action1 authentication returned HTTP {resp.status_code}")
        token = get_path(json_object(resp, "action1 authentication", Action1ReadError), A1_FIELDS["token"]["access_token"])
        if not isinstance(token, str) or not token.strip():
            raise Action1ReadError("action1 authentication returned no token")
        self.token = token.strip()

    def _get(self, url: str, what: str, params: dict | None = None) -> dict:
        if self.token is None:
            self.authenticate()
        for attempt in (1, 2):
            resp = self._send(
                "get", url, what, params=params,
                headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json"},
            )
            if resp.status_code == 401 and attempt == 1:
                log.info("action1 token rejected; authenticating again")
                self.authenticate()
                continue
            if resp.status_code >= 300:
                raise Action1ReadError(f"action1 {what} returned HTTP {resp.status_code}")
            return json_object(resp, f"action1 {what}", Action1ReadError)
        raise Action1ReadError(f"action1 {what} failed")  # unreachable

    def _paged(self, path: str, what: str) -> list[dict]:
        base_origin = _origin(self.base)
        url = f"{self.base}{path}"
        params: dict | None = {"limit": self.page_size}
        items: list[dict] = []
        seen: set[str] = set()
        for _ in range(PAGE_CAP):
            data = self._get(url, what, params)
            page = get_path(data, A1_FIELDS["page"]["items"])
            if not isinstance(page, list):
                raise Action1ReadError(f"action1 {what} returned an unexpected response body")
            items.extend(i for i in page if isinstance(i, dict))
            nxt = get_path(data, A1_FIELDS["page"]["next_page"])
            if not isinstance(nxt, str) or not nxt.strip():
                return items
            nxt = nxt.strip()
            if _origin(nxt) != base_origin:
                raise Action1ReadError(f"action1 {what} returned a next page link to another origin; refused")
            if nxt in seen:
                raise Action1ReadError(f"action1 {what} repeated a next page link")
            seen.add(nxt)
            url, params = nxt, None  # the link carries its own query
        raise Action1ReadError(f"action1 {what} exceeded {PAGE_CAP} pages")

    def fetch_hosts(self) -> list[dict]:
        endpoints = self._paged(A1_PATHS["endpoints"].format(org=quote(self.org, safe="")), "endpoints")
        pairs: list[tuple[dict, list[dict]]] = []
        for endpoint in endpoints:
            endpoint_id = _text(get_path(endpoint, A1_FIELDS["endpoint"]["id"]))
            if endpoint_id is None:
                continue
            path = A1_PATHS["updates"].format(org=quote(self.org, safe=""), endpoint=quote(endpoint_id, safe=""))
            pairs.append((endpoint, self._paged(path, "missing updates")))
        log.info("action1: read %d endpoint(s), %d missing update(s)", len(pairs), sum(len(u) for _, u in pairs))
        return group_action1(pairs, self.include_patch_findings)
