"""Reads Wazuh SCA (Security Configuration Assessment) results from the manager API into configuration-only hosts
(source kind SCAP), the same shape the XCCDF reader produces.

Every endpoint and field name below is assumed from the Wazuh 4.x documentation and has NOT been verified against a
live manager: check them against the running Wazuh before the first live push. A wrong guess is a one-line fix in
SCA_FIELDS.

Hosts: an agent is identified by its Wazuh agent id; the host name is the agent NAME, so the host matches the asset the
vulnerability run created. Each SCA policy of an agent becomes one scan; an agent with no policy is not reported. Agents
that never connected are skipped. Everything is read before anything is returned: any error raises WazuhReadError and no
partial host escapes. Logs and errors carry counts only: never a host name, an address or an agent id (and the request
URL, which holds the agent id, is never put in an error).
"""

import json
import logging
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests

from .adapter import clean_line
from .errors import WazuhReadError
from .wazuh_api import API_FIELDS, ApiReader
from .wazuh_indexer import get_path
from .xccdf import MAX_RESULTS_PER_SCAN, MAX_SCANS_PER_HOST, _RANK, _time, _usable_ip, xccdf_id

log = logging.getLogger(__name__)

# Assumed from the Wazuh 4.x documentation; verify against the running Wazuh.
SCA_FIELDS = {
    "policy": {"policy_id": "policy_id", "name": "name", "start_scan": "start_scan", "end_scan": "end_scan",
               "total_checks": "total_checks"},                                  # GET /sca/{agent_id}
    "check":  {"id": "id", "title": "title", "result": "result", "status": "status",
               "compliance": "compliance"},                                      # GET /sca/{agent_id}/checks/{policy_id}
}

SCANNER_NAME = "Wazuh SCA"
_RESULT_MAP = {"passed": "pass", "failed": "fail", "not applicable": "notapplicable"}


def map_result(result: Any, status: Any) -> str:
    """Wazuh check result -> contract result. An empty result with status "not applicable" is not applicable; anything
    else Wazuh says (invalid, a new word) is an error so it is never counted as a pass."""
    word = result.strip().lower() if isinstance(result, str) else ""
    if not word:
        if isinstance(status, str) and status.strip().lower() == "not applicable":
            return "notapplicable"
        return "error"
    return _RESULT_MAP.get(word, "error")


def load_sca_sample(path: Path) -> list[dict]:
    """The bundled sample: configuration-only hosts exactly as `ScaReader.fetch_hosts` returns them."""
    return json.loads(path.read_text(encoding="utf-8"))


class ScaReader(ApiReader):
    def _send(self, method: str, url: str, what: str, **kwargs: Any):
        try:
            return getattr(self.session, method)(
                url, verify=self.verify, timeout=(10, self.timeout), allow_redirects=False, **kwargs
            )
        except requests.RequestException as err:
            # Only the exception class: its text holds the URL, and the URL holds an agent id.
            raise WazuhReadError(f"wazuh api {what} failed: {type(err).__name__}") from None

    def _scan(self, agent_id: str, policy: dict) -> dict | None:
        """One policy -> one scan; None when the policy carries no usable time (counted by the caller)."""
        f = SCA_FIELDS["policy"]
        total = get_path(policy, f["total_checks"])
        if isinstance(total, int) and not isinstance(total, bool) and total > MAX_RESULTS_PER_SCAN:
            raise WazuhReadError(f"an SCA policy has more than {MAX_RESULTS_PER_SCAN} checks; nothing was sent")
        policy_id = get_path(policy, f["policy_id"])
        benchmark_id = xccdf_id(str(policy_id)) if policy_id is not None else None
        if benchmark_id is None:
            return None
        start = _time(get_path(policy, f["start_scan"]))
        end = _time(get_path(policy, f["end_scan"]))
        scanned_at = end or start
        if scanned_at is None:
            return None
        benchmark: dict[str, str] = {"id": benchmark_id}
        title = clean_line(get_path(policy, f["name"]), 255)
        if title:
            benchmark["title"] = title
        scan: dict[str, Any] = {"benchmark": benchmark, "scanner": {"name": SCANNER_NAME}}
        if start and end:
            scan["started_at"] = start
        scan["scanned_at"] = scanned_at

        c = SCA_FIELDS["check"]
        best: dict[str, dict] = {}
        for item in self._paged(f"/sca/{quote(agent_id, safe='')}/checks/{quote(str(policy_id), safe='')}", "SCA checks"):
            raw_id = get_path(item, c["id"])
            rule_id = xccdf_id(str(raw_id)) if raw_id is not None else None
            if rule_id is None:
                continue
            result = map_result(get_path(item, c["result"]), get_path(item, c["status"]))
            check_title = get_path(item, c["title"])
            cur = best.get(rule_id)
            if cur is None:
                best[rule_id] = {"result": result, "title": check_title}
            elif _RANK.get(result, 5) < _RANK.get(cur["result"], 5):  # the worst outcome wins
                best[rule_id] = {"result": result, "title": check_title or cur["title"]}
            else:
                cur["title"] = cur["title"] or check_title
        if len(best) > MAX_RESULTS_PER_SCAN:
            raise WazuhReadError(f"an SCA policy has more than {MAX_RESULTS_PER_SCAN} distinct checks; nothing was sent")
        results: list[dict] = []
        for rule_id in sorted(best):
            row: dict[str, Any] = {"rule_id": rule_id, "result": best[rule_id]["result"]}
            title_text = clean_line(best[rule_id]["title"], 512)
            if title_text is not None:
                row["title"] = title_text
            results.append(row)
        scan["results"] = results
        return scan

    def fetch_hosts(self) -> list[dict]:
        agent_fields = API_FIELDS["agent"]
        hosts: list[dict] = []
        never = no_policy = bad_policy = 0
        agents = self.list_agents()
        for agent in agents:
            agent_id = get_path(agent, agent_fields["agent_id"])
            if not isinstance(agent_id, str) or not agent_id.strip():
                continue
            if get_path(agent, agent_fields["status"]) == "never_connected":
                never += 1
                continue
            scans: list[dict] = []
            for policy in self._paged(f"/sca/{quote(agent_id, safe='')}", "SCA policies"):
                scan = self._scan(agent_id, policy)
                if scan is None:
                    bad_policy += 1
                else:
                    scans.append(scan)
            if not scans:
                no_policy += 1
                continue
            if len(scans) > MAX_SCANS_PER_HOST:
                raise WazuhReadError(f"a host has more than {MAX_SCANS_PER_HOST} SCA policies; nothing was sent")
            scans.sort(key=lambda s: (s["scanned_at"], s["benchmark"]["id"]))
            host: dict[str, Any] = {"agent_id": agent_id}
            name = clean_line(get_path(agent, agent_fields["agent_name"]), 255)
            if name is not None:
                host["hostname"] = name
            raw_ip = get_path(agent, agent_fields["ip"])
            ip = _usable_ip(raw_ip) if isinstance(raw_ip, str) else None
            if ip is not None:
                host["ip"] = ip
            os_info: dict[str, str] = {}
            for key, limit in (("name", 128), ("version", 64)):
                text = clean_line(get_path(agent, agent_fields[f"os_{key}"]), limit)
                if text is not None:
                    os_info[key] = text
            if os_info:
                host["os"] = os_info
            host["configuration"] = scans
            hosts.append(host)
        log.info(
            "wazuh sca: %d agent(s) read, %d never connected, %d without SCA policies, %d policy(ies) skipped "
            "(no usable id or time), %d host(s) with results",
            len(agents), never, no_policy, bad_policy, len(hosts),
        )
        if not hosts:
            raise WazuhReadError("Wazuh returned zero hosts with SCA results; nothing was sent")
        return hosts
