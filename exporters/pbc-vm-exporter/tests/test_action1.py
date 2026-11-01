import logging

import pytest
import requests

from conftest import FakeSession, load_fixture
from pbc_vm_exporter import action1
from pbc_vm_exporter.adapter import build_hosts
from pbc_vm_exporter.config import Action1Settings
from pbc_vm_exporter.errors import Action1ReadError
from pbc_vm_exporter.action1 import Action1Reader, group_action1

BASE = "https://app.example/api/3.0"
SECRET = "client-secret-" + "z" * 20


def settings(**over):
    values = dict(base_url=BASE, client_id="client-1", client_secret=SECRET, org_id="org-1", verify=True,
                  include_patch_findings=True, proxy_url=None)
    values.update(over)
    return Action1Settings(**values)


def routed(overrides=None, tokens=None):
    """Serves the fixtures by URL. `tokens` is a list that receives each token POST's form."""
    overrides = overrides or {}

    def handler(method, url, kwargs):
        if method == "POST":
            if tokens is not None:
                tokens.append(kwargs.get("data"))
            return (200, load_fixture("a1_token.json"))
        if url in overrides:
            return overrides[url]
        if url == f"{BASE}/endpoints/managed/org-1":
            return (200, load_fixture("a1_endpoints_page1.json"))
        if url == f"{BASE}/endpoints/managed/org-1?limit=2&from=2":
            return (200, load_fixture("a1_endpoints_page2.json"))
        for ep in ("ep-1", "ep-2", "ep-3"):
            if url == f"{BASE}/endpoints/managed/org-1/{ep}/missing-updates":
                return (200, load_fixture(f"a1_updates_{ep}.json"))
        raise AssertionError(f"unexpected request {url}")

    return handler


def reader(session, sleeps=None, **over):
    return Action1Reader(settings(**over), 30, session=session, sleep=sleeps if sleeps is not None else (lambda s: None))


def test_token_form_then_bearer_and_same_origin_paging():
    tokens = []
    session = FakeSession(handler=routed(tokens=tokens))
    hosts = reader(session).fetch_hosts()
    assert session.calls[0]["method"] == "POST" and session.calls[0]["url"] == f"{BASE}/oauth2/token"
    assert tokens == [{"client_id": "client-1", "client_secret": SECRET}]
    gets = [c for c in session.calls if c["method"] == "GET"]
    assert gets[0]["url"] == f"{BASE}/endpoints/managed/org-1" and gets[0]["params"] == {"limit": 100}
    assert gets[1]["url"] == f"{BASE}/endpoints/managed/org-1?limit=2&from=2" and gets[1]["params"] is None
    assert all(c["headers"]["Authorization"] == "Bearer tok-1" for c in gets)
    assert all(c["allow_redirects"] is False and c["verify"] is True for c in session.calls)
    assert len(gets) == 5  # two endpoint pages and three per-endpoint reads
    assert {h["hostname"] for h in hosts} == {"a1-win-01", "a1-win-03.example"}  # ep-2 has no findings


def test_other_origin_next_page_is_refused_without_a_request():
    page = dict(load_fixture("a1_endpoints_page1.json"), next_page="https://evil.example/api/3.0/endpoints")
    session = FakeSession(handler=routed({f"{BASE}/endpoints/managed/org-1": (200, page)}))
    with pytest.raises(Action1ReadError, match="another origin"):
        reader(session).fetch_hosts()
    assert [c["url"] for c in session.calls if c["method"] == "GET"] == [f"{BASE}/endpoints/managed/org-1"]


@pytest.mark.parametrize("link", [
    "http://app.example/api/3.0/endpoints", "https://app.example:8443/api/3.0/endpoints",
    "https://user:pw@app.example/api/3.0/endpoints", "//app.example/api/3.0/endpoints", "/api/3.0/endpoints",
])
def test_next_page_origin_must_match_scheme_host_and_port(link):
    page = dict(load_fixture("a1_endpoints_page1.json"), next_page=link)
    session = FakeSession(handler=routed({f"{BASE}/endpoints/managed/org-1": (200, page)}))
    with pytest.raises(Action1ReadError):
        reader(session).fetch_hosts()
    assert len([c for c in session.calls if c["method"] == "GET"]) == 1


def test_repeated_next_page_and_page_cap(monkeypatch):
    url = f"{BASE}/endpoints/managed/org-1"
    page = dict(load_fixture("a1_endpoints_page1.json"), next_page=f"{url}?from=2")
    session = FakeSession(handler=routed({url: (200, page), f"{url}?from=2": (200, page)}))
    with pytest.raises(Action1ReadError, match="repeated"):
        reader(session).fetch_hosts()
    monkeypatch.setattr(action1, "PAGE_CAP", 2)
    counter = iter(range(100))
    endless = FakeSession(
        handler=lambda m, u, k: (200, load_fixture("a1_token.json")) if m == "POST"
        else (200, {"items": [], "next_page": f"{BASE}/p{next(counter)}"})
    )
    with pytest.raises(Action1ReadError, match="exceeded 2 pages"):
        reader(endless).fetch_hosts()


def test_one_row_per_cve_with_the_update_as_the_package():
    raw = reader(FakeSession(handler=routed())).fetch_hosts()
    win = next(h for h in raw if h["hostname"] == "a1-win-01")
    cve_rows = [r for r in win["rows"] if r["vuln_id"].startswith("CVE-")]
    assert sorted(r["vuln_id"] for r in cve_rows) == ["CVE-2024-21351", "CVE-2024-21412"]
    for row in cve_rows:
        assert row["severity"] == "high"  # Important
        assert row["package_name"] == "2024-02 Cumulative Update for Windows 11 (KB5034765)"
        assert row["fixed_version"] == "KB5034765" and row["published_at"] == "2024-02-13"
        assert row["patch_id"] == "upd-0001" and row["cves"] == ["CVE-2024-21412", "CVE-2024-21351"]
    assert win["agent_id"] == "ep-1" and win["ip"] == "192.0.2.31" and win["mac"] == "00:00:5E:00:53:31"


def test_security_update_without_a_cve_is_one_kb_finding():
    raw = reader(FakeSession(handler=routed())).fetch_hosts()
    win = next(h for h in raw if h["hostname"] == "a1-win-01")
    kb = [r for r in win["rows"] if r["vuln_id"] == "KB5034441"]
    assert len(kb) == 1 and kb[0]["severity"] == "medium" and kb[0]["published_at"] == "2024-01-09"
    built, _ = build_hosts(raw)
    finding = next(f for h in built if h["hostname"] == "a1-win-01" for f in h["findings"] if f["vuln_id"] == "KB5034441")
    assert finding["severity"] == "MEDIUM" and "detected_at" not in finding


def test_non_security_updates_are_dropped_and_counted(caplog):
    caplog.set_level(logging.INFO)
    raw = reader(FakeSession(handler=routed())).fetch_hosts()
    assert all("driver" not in (r["package_name"] or "").lower() for h in raw for r in h["rows"])
    assert "1 non-security update(s) dropped" in caplog.text


def test_patch_findings_can_be_switched_off(caplog):
    caplog.set_level(logging.INFO)
    raw = reader(FakeSession(handler=routed()), include_patch_findings=False).fetch_hosts()
    ids = sorted(r["vuln_id"] for h in raw for r in h["rows"])
    assert ids == ["CVE-2023-31102", "CVE-2024-21351", "CVE-2024-21412"]
    assert "1 security update(s) without a CVE dropped" in caplog.text


@pytest.mark.parametrize("word,expected", [
    ("Critical", "CRITICAL"), ("Important", "HIGH"), ("Moderate", "MEDIUM"), ("Low", "LOW"),
    ("Unspecified", "UNKNOWN"), ("Surprising", "UNKNOWN"), (None, "UNKNOWN"),
])
def test_severity_words(word, expected):
    pairs = [({"id": "e"}, [{"id": "u", "name": "N", "severity": word, "security": True, "cve": ["CVE-2024-0001"]}])]
    built, _ = build_hosts(group_action1(pairs))
    assert built[0]["findings"][0]["severity"] == expected


def test_a_missing_security_flag_falls_back_to_the_cve_list():
    pairs = [({"id": "e"}, [
        {"id": "u1", "name": "A", "cve": "CVE-2024-0001, cve-2024-0002"},
        {"id": "u2", "name": "B"},
    ])]
    raw = group_action1(pairs)
    assert sorted(r["vuln_id"] for r in raw[0]["rows"]) == ["CVE-2024-0001", "CVE-2024-0002"]


def test_401_authenticates_again_once():
    tokens = []
    state = {"rejected": False}
    inner = routed(tokens=tokens)

    def handler(method, url, kwargs):
        if method == "GET" and not state["rejected"]:
            state["rejected"] = True
            return (401, {})
        return inner(method, url, kwargs)

    hosts = reader(FakeSession(handler=handler)).fetch_hosts()
    assert len(tokens) == 2 and len(hosts) == 2


def test_second_401_is_an_error_without_the_secret():
    def handler(method, url, kwargs):
        return (200, load_fixture("a1_token.json")) if method == "POST" else (401, {})

    session = FakeSession(handler=handler)
    with pytest.raises(Action1ReadError) as info:
        reader(session).fetch_hosts()
    assert "HTTP 401" in str(info.value) and SECRET not in str(info.value) and "tok-1" not in str(info.value)
    assert [c["method"] for c in session.calls] == ["POST", "GET", "POST", "GET"]


def test_authentication_failure_is_an_error_without_the_secret():
    session = FakeSession(script=[(401, {"error": "invalid_client"})])
    with pytest.raises(Action1ReadError, match="action1 authentication returned HTTP 401") as info:
        reader(session).fetch_hosts()
    assert SECRET not in str(info.value) and len(session.calls) == 1


def test_authentication_without_a_token_is_an_error():
    session = FakeSession(script=[(200, {"token_type": "Bearer"})])
    with pytest.raises(Action1ReadError, match="no token"):
        reader(session).fetch_hosts()


def test_a_failing_endpoint_fails_the_whole_read():
    session = FakeSession(handler=routed({f"{BASE}/endpoints/managed/org-1/ep-3/missing-updates": (500, {})}))
    with pytest.raises(Action1ReadError, match="HTTP 500"):
        reader(session).fetch_hosts()


def test_429_retries_once_after_retry_after():
    state = {"limited": False}
    inner = routed()

    def handler(method, url, kwargs):
        if method == "GET" and url.endswith("ep-1/missing-updates") and not state["limited"]:
            state["limited"] = True
            return (429, {}, {"Retry-After": "7"})
        return inner(method, url, kwargs)

    sleeps = []
    hosts = reader(FakeSession(handler=handler), sleeps.append).fetch_hosts()
    assert sleeps == [7.0] and len(hosts) == 2


def test_429_twice_is_an_error():
    def handler(method, url, kwargs):
        return (200, load_fixture("a1_token.json")) if method == "POST" else (429, {}, {"Retry-After": "120"})

    sleeps = []
    with pytest.raises(Action1ReadError, match="429"):
        reader(FakeSession(handler=handler), sleeps.append).fetch_hosts()
    assert sleeps == [60.0]


def test_network_error_names_the_type_only():
    session = FakeSession(script=[requests.ConnectionError(f"boom {BASE} {SECRET}")])
    with pytest.raises(Action1ReadError) as info:
        reader(session).fetch_hosts()
    assert "ConnectionError" in str(info.value) and SECRET not in str(info.value) and "app.example" not in str(info.value)


def test_zero_rows_means_no_host():
    def handler(method, url, kwargs):
        if method == "POST":
            return (200, load_fixture("a1_token.json"))
        if url.endswith("missing-updates"):
            return (200, load_fixture("a1_updates_ep-2.json"))
        return (200, load_fixture("a1_endpoints_page2.json") | {"prev_page": None})

    assert reader(FakeSession(handler=handler)).fetch_hosts() == []


def test_the_organization_id_is_quoted_into_the_path():
    session = FakeSession(handler=lambda m, u, k: (200, load_fixture("a1_token.json")) if m == "POST" else (200, {"items": []}))
    reader(session, org_id="org-1").fetch_hosts()
    assert [c["url"] for c in session.calls if c["method"] == "GET"] == [f"{BASE}/endpoints/managed/org-1"]


def test_logs_carry_counts_only(caplog):
    caplog.set_level(logging.DEBUG)
    reader(FakeSession(handler=routed())).fetch_hosts()
    for forbidden in ("a1-win-01", "a1-win-03", "ep-1", "ep-3", "192.0.2.", "00:00:5E", "org-1", SECRET, "tok-1"):
        assert forbidden not in caplog.text
    assert "read 3 endpoint(s), 4 missing update(s)" in caplog.text


def test_a_wrong_field_name_is_a_one_line_fix(monkeypatch):
    pairs = [({"id": "e", "device_name": "a1-win-09"}, [{"id": "u", "name": "N", "cve": ["CVE-2024-0001"]}])]
    assert group_action1(pairs)[0]["hostname"] is None
    monkeypatch.setitem(action1.A1_FIELDS["endpoint"], "hostname", "device_name")
    assert group_action1(pairs)[0]["hostname"] == "a1-win-09"
