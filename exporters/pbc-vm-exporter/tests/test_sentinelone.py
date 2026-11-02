import logging

import pytest
import requests

from conftest import FakeSession, load_fixture
from pbc_vm_exporter import sentinelone
from pbc_vm_exporter.adapter import build_hosts
from pbc_vm_exporter.config import SentinelOneSettings
from pbc_vm_exporter.errors import SentinelOneReadError
from pbc_vm_exporter.sentinelone import SentinelOneReader, group_sentinelone

TOKEN = "s1-token-" + "x" * 30
BASE = "https://console.example/web/api/v2.1"


def settings(**over):
    values = dict(console_url="https://console.example", api_token=TOKEN, site_ids=("111", "222"), verify=True,
                  proxy_url=None)
    values.update(over)
    return SentinelOneSettings(**values)


def routed(overrides=None):
    """A handler serving the fixtures by path and cursor; `overrides` maps (path, cursor) -> a scripted item."""
    overrides = overrides or {}

    def handler(method, url, kwargs):
        cursor = (kwargs.get("params") or {}).get("cursor")
        path = url.removeprefix(BASE)
        if (path, cursor) in overrides:
            return overrides[(path, cursor)]
        if path == "/agents":
            return (200, load_fixture("s1_agents_page1.json" if cursor is None else "s1_agents_page2.json"))
        if path == "/application-management/risks":
            return (200, load_fixture("s1_risks_page1.json" if cursor is None else "s1_risks_page2.json"))
        raise AssertionError(f"unexpected request {url}")

    return handler


def reader(session, sleeps=None, **over):
    return SentinelOneReader(settings(**over), 30, session=session, sleep=sleeps if sleeps is not None else (lambda s: None))


def test_request_shape_and_paging():
    session = FakeSession(handler=routed())
    hosts = reader(session).fetch_hosts()
    assert [c["url"].removeprefix(BASE) for c in session.calls] == [
        "/agents", "/agents", "/application-management/risks", "/application-management/risks"
    ]
    first = session.calls[0]
    assert first["headers"]["Authorization"] == f"ApiToken {TOKEN}"
    assert first["params"]["siteIds"] == "111,222" and first["params"]["limit"] == 1000 and "cursor" not in first["params"]
    assert session.calls[1]["params"]["cursor"] == "agents-cursor-2"
    assert all(c["allow_redirects"] is False and c["verify"] is True for c in session.calls)
    assert len(hosts) == 2


def test_ca_bundle_is_passed_as_verify(tmp_path):
    session = FakeSession(handler=routed())
    reader(session, verify="/etc/ca.pem").fetch_hosts()
    assert {c["verify"] for c in session.calls} == {"/etc/ca.pem"}


def test_mapping_of_the_management_interface_and_identity():
    hosts = {h["hostname"]: h for h in reader(FakeSession(handler=routed())).fetch_hosts()}
    win = hosts["s1-win-01"]
    assert win["agent_id"] == "0f7e1c2a-5b3d-4c8e-9a61-2d4f6b8c0a11"  # the uuid, not the vendor's numeric id
    assert win["ip"] == "192.0.2.21"
    assert win["mac"].lower() == "00:00:5e:00:53:21"  # the interface holding the management IP, not the VPN one
    assert (win["os_name"], win["os_version"]) == ("Windows 11 Pro", "22631")
    by_id = {r["vuln_id"]: r for r in win["rows"]}
    assert by_id["CVE-2023-4863"]["score"] == 7.5 and by_id["CVE-2023-4863"]["severity"] == "high"
    assert by_id["CVE-2024-3094"]["package_name"] == "xz-utils" and by_id["CVE-2024-3094"]["fixed_version"] is None
    assert by_id["CVE-2024-3094"]["published_at"] == "2024-03-29T17:15:00Z"


def test_severity_none_becomes_unknown_in_the_payload():
    raw = reader(FakeSession(handler=routed())).fetch_hosts()
    built, _ = build_hosts(raw)
    linux = next(h for h in built if h["hostname"] == "s1-lin-02.example")
    assert [f["severity"] for f in linux["findings"]] == ["UNKNOWN"]
    assert "cvss_v3" not in linux["findings"][0]
    win = next(h for h in built if h["hostname"] == "s1-win-01")
    assert {f["vuln_id"]: f["cvss_v3"] for f in win["findings"]}["CVE-2023-4863"] == 7.5


def test_decommissioned_unknown_endpoint_and_clean_hosts_are_not_reported(caplog):
    caplog.set_level(logging.INFO)
    hosts = reader(FakeSession(handler=routed())).fetch_hosts()
    names = {h["hostname"] for h in hosts}
    assert names == {"s1-win-01", "s1-lin-02.example"}  # s1-old-03 decommissioned, s1-clean-04 has no rows
    # the unknown endpoint's row and the decommissioned agent's row are both dropped, and counted
    assert "1 decommissioned agent(s) excluded" in caplog.text and "2 risk row(s) dropped (unknown endpoint)" in caplog.text


def test_repeated_cursor_is_an_error():
    page = {"data": [], "pagination": {"nextCursor": "same"}}
    session = FakeSession(handler=lambda m, u, k: (200, page))
    with pytest.raises(SentinelOneReadError, match="repeated a page cursor"):
        reader(session).fetch_hosts()
    assert len(session.calls) == 2


def test_page_cap(monkeypatch):
    monkeypatch.setattr(sentinelone, "PAGE_CAP", 3)
    counter = iter(range(100))
    session = FakeSession(handler=lambda m, u, k: (200, {"data": [], "pagination": {"nextCursor": f"c{next(counter)}"}}))
    with pytest.raises(SentinelOneReadError, match="exceeded 3 pages"):
        reader(session).fetch_hosts()
    assert len(session.calls) == 3


def test_401_stops_at_once_with_an_expiry_hint_and_no_token():
    session = FakeSession(script=[(401, {"errors": [{"detail": "expired"}]})])
    with pytest.raises(SentinelOneReadError) as info:
        reader(session).fetch_hosts()
    assert len(session.calls) == 1
    assert "expired" in str(info.value) and "S1_API_TOKEN" in str(info.value) and TOKEN not in str(info.value)


def test_403_is_an_error():
    session = FakeSession(script=[(403, {})])
    with pytest.raises(SentinelOneReadError, match="HTTP 403"):
        reader(session).fetch_hosts()


def test_429_waits_retry_after_once_then_succeeds():
    seen = {"limited": False}

    def handler(method, url, kwargs):
        if not seen["limited"]:
            seen["limited"] = True
            return (429, {}, {"Retry-After": "5"})
        return routed()(method, url, kwargs)

    sleeps = []
    hosts = reader(FakeSession(handler=handler), sleeps.append).fetch_hosts()
    assert sleeps == [5.0] and len(hosts) == 2


def test_429_twice_is_an_error_and_retry_after_is_capped():
    sleeps = []
    session = FakeSession(script=[(429, {}, {"Retry-After": "9999"}), (429, {}, {"Retry-After": "1"})])
    with pytest.raises(SentinelOneReadError, match="429"):
        reader(session, sleeps.append).fetch_hosts()
    assert sleeps == [60.0] and len(session.calls) == 2


def test_failure_midway_returns_no_hosts():
    session = FakeSession(handler=routed({("/application-management/risks", "risks-cursor-2"): (500, {})}))
    with pytest.raises(SentinelOneReadError, match="HTTP 500"):
        reader(session).fetch_hosts()


def test_network_error_names_the_type_only():
    session = FakeSession(script=[requests.ConnectionError(f"boom {BASE} {TOKEN}")])
    with pytest.raises(SentinelOneReadError) as info:
        reader(session).fetch_hosts()
    assert "ConnectionError" in str(info.value) and TOKEN not in str(info.value) and "console.example" not in str(info.value)


def test_unexpected_body_is_an_error():
    session = FakeSession(script=[(200, {"nodata": 1})])
    with pytest.raises(SentinelOneReadError, match="unexpected response body"):
        reader(session).fetch_hosts()


def test_logs_carry_counts_only(caplog):
    caplog.set_level(logging.DEBUG)
    reader(FakeSession(handler=routed())).fetch_hosts()
    for forbidden in ("s1-win-01", "s1-lin-02", "0f7e1c2a", "192.0.2.", "00:00:5E", "111", "222", "1900000000", TOKEN):
        assert forbidden not in caplog.text
    assert "read 4 agent(s) and 5 risk row(s)" in caplog.text


def test_a_wrong_field_name_is_a_one_line_fix(monkeypatch):
    agents = load_fixture("s1_agents_page1.json")["data"] + load_fixture("s1_agents_page2.json")["data"]
    risks = load_fixture("s1_risks_page1.json")["data"]
    for agent in agents:
        agent["hostName"] = agent.pop("computerName")
    assert group_sentinelone(agents, risks)[0]["hostname"] is None
    monkeypatch.setitem(sentinelone.S1_FIELDS["agent"], "hostname", "hostName")
    assert group_sentinelone(agents, risks)[0]["hostname"] == "s1-win-01"


def test_agent_without_a_management_ip_gets_no_mac():
    agents = load_fixture("s1_agents_page1.json")["data"]
    agents[0]["lastIpToMgmt"] = None
    host = group_sentinelone(agents, load_fixture("s1_risks_page1.json")["data"])[0]
    assert host["mac"] is None and host["ip"] is None


def test_the_proxy_reaches_the_vendor_session_only():
    from pbc_vm_exporter.transport import make_session

    session = make_session("http://proxy.example:3128")
    assert session.trust_env is False
    assert session.proxies["https"] == "http://proxy.example:3128"
    assert make_session().proxies == {}
