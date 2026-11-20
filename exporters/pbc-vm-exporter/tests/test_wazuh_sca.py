import logging
from urllib.parse import unquote

import pytest
import requests

from conftest import FakeSession, load_fixture
from pbc_vm_exporter import wazuh_sca
from pbc_vm_exporter.adapter import build_config_payloads
from pbc_vm_exporter.errors import WazuhReadError
from pbc_vm_exporter.validate import validate_payload
from pbc_vm_exporter.wazuh_sca import SCA_FIELDS, ScaReader, map_result

BASE = "https://wazuh:55000"
PAGE = {"affected_items": [], "total_affected_items": 0}


def sca_handler(*, policies=None, checks_a=None, checks_b=None, state=None, agents=None):
    state = state if state is not None else {}
    state.setdefault("auths", 0)
    state.setdefault("calls", [])

    def handler(method, url, kwargs):
        path = unquote(url.removeprefix(BASE))
        params = kwargs.get("params") or {}
        state["calls"].append((path, params.get("offset")))
        if method == "POST" and path == "/security/user/authenticate":
            state["auths"] += 1
            return (200, {"data": {"token": f"jwt{state['auths']}"}})
        if path == "/agents":
            return (200, agents or load_fixture("sca_agents.json"))
        if path == "/sca/001":
            return (200, policies or load_fixture("sca_policies_001.json"))
        if path == "/sca/002":
            return (200, {"data": PAGE})
        if path == "/sca/001/checks/cis_ubuntu22-04":
            if checks_a is not None:
                return (200, checks_a)
            return (200, load_fixture("sca_checks_a_page1.json" if params.get("offset") == 0 else "sca_checks_a_page2.json"))
        if path == "/sca/001/checks/cis apache 2.4":
            return (200, checks_b or load_fixture("sca_checks_b.json"))
        raise AssertionError(f"unexpected call {method} {path}")

    return handler, state


def reader(handler, password="api-secret"):
    session = FakeSession(handler=handler)
    return ScaReader(BASE, "wazuh-wui", password, "/ca.pem", 60, session=session, page_size=2), session


def host_001(**kw):
    handler, state = sca_handler(**kw)
    r, session = reader(handler)
    hosts = r.fetch_hosts()
    assert len(hosts) == 1
    return hosts[0], state, session


def test_mapping_and_host_fields():
    host, _, _ = host_001()
    assert host["agent_id"] == "001" and host["hostname"] == "web-01" and host["ip"] == "10.0.0.5"
    assert host["os"] == {"name": "Ubuntu", "version": "22.04"}
    assert "findings" not in host
    a, b = host["configuration"]
    assert a["benchmark"] == {"id": "cis_ubuntu22-04", "title": "CIS Ubuntu Linux 22.04 LTS Benchmark"}
    assert a["scanner"] == {"name": "Wazuh SCA"}
    assert [(r["rule_id"], r["result"]) for r in a["results"]] == [
        ("28500", "pass"), ("28501", "fail"), ("28502", "notapplicable"), ("28503", "notapplicable"),
    ]
    assert a["results"][1]["title"] == "Ensure SSH root login is disabled."
    assert b["benchmark"]["id"] == "cis_apache_2.4"  # made safe for the contract
    assert {r["rule_id"]: r["result"] for r in b["results"]} == {"9001": "fail", "9002": "error"}


def test_times_are_normalised_to_utc():
    host, _, _ = host_001()
    a, b = host["configuration"]
    assert a["started_at"] == "2026-10-01T02:00:00Z" and a["scanned_at"] == "2026-10-01T02:03:30Z"
    assert b["started_at"] == "2026-10-02T02:00:00Z" and b["scanned_at"] == "2026-10-02T02:10:00Z"


def test_policy_with_one_time_or_none():
    policies = {"data": {"affected_items": [
        {"policy_id": "cis_ubuntu22-04", "name": "A", "start_scan": "2026-10-01 02:00:00", "total_checks": 4},
        {"policy_id": "cis apache 2.4", "name": "B", "total_checks": 2},
    ], "total_affected_items": 2}}
    host, _, _ = host_001(policies=policies)
    (scan,) = host["configuration"]  # the second policy has no time at all: skipped
    assert scan["scanned_at"] == "2026-10-01T02:00:00Z" and "started_at" not in scan


def test_paging_offsets():
    _, state, session = host_001()
    offsets = [off for path, off in state["calls"] if path == "/sca/001/checks/cis_ubuntu22-04"]
    assert offsets == [0, 2]
    assert [c["params"]["limit"] for c in session.calls if c["url"].endswith("/checks/cis_ubuntu22-04")] == [2, 2]


def test_agents_without_policies_and_never_connected_are_skipped():
    _, state, _ = host_001()
    paths = [p for p, _ in state["calls"]]
    assert "/sca/002" in paths  # asked, had no policy, dropped
    assert not any(p.startswith("/sca/003") for p in paths)  # never connected: no call


def test_total_checks_over_the_cap_is_refused_before_any_checks_call():
    policies = load_fixture("sca_policies_001.json")
    policies["data"]["affected_items"][0]["total_checks"] = 5001
    handler, state = sca_handler(policies=policies)
    r, _ = reader(handler)
    with pytest.raises(WazuhReadError):
        r.fetch_hosts()
    assert not any("/checks/" in p for p, _ in state["calls"])


def test_pages_that_yield_more_than_the_cap_are_refused(monkeypatch):
    monkeypatch.setattr(wazuh_sca, "MAX_RESULTS_PER_SCAN", 3)
    policies = load_fixture("sca_policies_001.json")
    policies["data"]["affected_items"][0]["total_checks"] = 3  # Wazuh under-reports; the pages carry 4
    handler, _ = sca_handler(policies=policies)
    r, _ = reader(handler)
    with pytest.raises(WazuhReadError):
        r.fetch_hosts()


def test_more_than_twenty_policies_on_a_host_is_refused():
    items = [{"policy_id": f"p{i}", "name": "P", "end_scan": "2026-10-01 02:00:00", "total_checks": 1} for i in range(21)]
    policies = {"data": {"affected_items": items, "total_affected_items": 21}}

    def handler(method, url, kwargs):
        path = unquote(url.removeprefix(BASE))
        if method == "POST":
            return (200, {"data": {"token": "t"}})
        if path == "/agents":
            return (200, {"data": {"affected_items": [{"id": "001", "name": "web-01", "status": "active"}], "total_affected_items": 1}})
        if path == "/sca/001":
            return (200, policies)
        return (200, {"data": {"affected_items": [{"id": 1, "result": "passed"}], "total_affected_items": 1}})

    r, _ = reader(handler)
    with pytest.raises(WazuhReadError):
        r.fetch_hosts()


def test_duplicate_check_ids_fold_to_the_worst_result():
    checks = {"data": {"affected_items": [
        {"id": 5, "title": "Dup", "result": "passed"}, {"id": 5, "title": "Dup", "result": "failed"},
        {"id": 5, "title": "Dup", "result": "passed"}, {"id": 6, "title": "Other", "result": "passed"},
    ], "total_affected_items": 4}}
    host, _, _ = host_001(checks_a=checks)
    results = {r["rule_id"]: r["result"] for r in host["configuration"][0]["results"]}
    assert results == {"5": "fail", "6": "pass"}


def test_result_mapping():
    assert map_result("Passed", None) == "pass" and map_result(" failed ", None) == "fail"
    assert map_result("Not Applicable", None) == "notapplicable"
    assert map_result("invalid", None) == "error" and map_result(None, None) == "error"
    assert map_result("", "Not applicable") == "notapplicable" and map_result("", "Applicable") == "error"


def test_field_names_are_in_one_place():
    assert set(SCA_FIELDS) == {"policy", "check"}
    assert set(SCA_FIELDS["policy"]) == {"policy_id", "name", "start_scan", "end_scan", "total_checks"}
    assert set(SCA_FIELDS["check"]) == {"id", "title", "result", "status", "compliance"}


def test_zero_hosts_is_refused():
    def handler(method, url, kwargs):
        if method == "POST":
            return (200, {"data": {"token": "t"}})
        if url.endswith("/agents"):
            return (200, {"data": {"affected_items": [{"id": "003", "name": "n", "status": "never_connected"}], "total_affected_items": 1}})
        raise AssertionError(url)

    r, _ = reader(handler)
    with pytest.raises(WazuhReadError, match="nothing was sent"):
        r.fetch_hosts()


def test_payload_is_a_valid_scap_payload():
    host, _, _ = host_001()
    payloads, skipped = build_config_payloads([host], label="wazuh-sca-prod")
    assert skipped == [] and len(payloads) == 1
    assert payloads[0]["source"] == {"kind": "SCAP", "label": "wazuh-sca-prod"}
    assert validate_payload(payloads[0]) is None


def test_errors_and_logs_carry_no_agent_id_host_name_or_address(caplog):
    leaky = requests.ConnectionError("HTTPSConnectionPool: Max retries for url /sca/001/checks/cis_ubuntu22-04 (web-01 10.0.0.5)")

    def handler(method, url, kwargs):
        path = url.removeprefix(BASE)
        if method == "POST":
            return (200, {"data": {"token": "t"}})
        if path == "/agents":
            return (200, load_fixture("sca_agents.json"))
        if path == "/sca/001":
            return leaky
        raise AssertionError(path)

    r, _ = reader(handler)
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(WazuhReadError) as info:
            r.fetch_hosts()
    text = str(info.value) + "\n" + caplog.text
    for needle in ("001", "web-01", "10.0.0.5", "/sca/", "cis_ubuntu"):
        assert needle not in text
    assert "ConnectionError" in str(info.value)


def test_successful_run_logs_counts_only(caplog):
    with caplog.at_level(logging.DEBUG):
        host_001()
    for needle in ("001", "web-01", "bare-02", "10.0.0.5", "cis_ubuntu"):
        assert needle not in caplog.text
    assert "wazuh sca:" in caplog.text


def test_one_reauthentication_on_401():
    state = {"auths": 0, "calls": [], "rejected": False}
    inner, _ = sca_handler(state=state)

    def handler(method, url, kwargs):
        if url.endswith("/sca/001") and not state["rejected"]:
            state["rejected"] = True
            return (401, {"error": "expired"})
        return inner(method, url, kwargs)

    r, _ = reader(handler)
    assert len(r.fetch_hosts()) == 1 and state["auths"] == 2
