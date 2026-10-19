import pytest
import requests

from conftest import FakeResponse, FakeSession, load_fixture
from pbc_vm_exporter import wazuh_indexer
from pbc_vm_exporter.errors import WazuhReadError
from pbc_vm_exporter.wazuh_api import ApiReader
from pbc_vm_exporter.wazuh_indexer import INDEXER_FIELDS, IndexerReader, doc_to_row, get_path

URL = "https://wazuh:9200"
INDEX = "wazuh-states-vulnerabilities-*"


def indexer(script, verify="/ca.pem", password="pw-secret!"):
    session = FakeSession(script)
    return IndexerReader(URL, "reader", password, verify, 60, session=session), session


def pages():
    return [
        (200, load_fixture("indexer_page1.json")),
        (200, load_fixture("indexer_page2.json")),
        (200, load_fixture("indexer_page3_empty.json")),
        (200, {}),
    ]


# ------------------------------------------------------------------------------------------------ indexer

def test_indexer_pages_are_grouped_per_agent():
    reader, _ = indexer(pages())
    hosts = reader.fetch_hosts()
    assert [(h["agent_id"], len(h["rows"])) for h in hosts] == [("001", 2), ("002", 1)]
    assert hosts[0]["hostname"] == "web-01" and hosts[0]["os_name"] == "Ubuntu"


def test_indexer_call_sequence_and_auth():
    reader, session = indexer(pages())
    reader.fetch_hosts()
    seq = [(c["method"], c["url"]) for c in session.calls]
    assert seq == [
        ("POST", f"{URL}/{INDEX}/_search?scroll=2m"),
        ("POST", f"{URL}/_search/scroll"),
        ("POST", f"{URL}/_search/scroll"),
        ("DELETE", f"{URL}/_search/scroll"),
    ]
    assert session.calls[1]["json"] == {"scroll": "2m", "scroll_id": "S1"}
    assert session.calls[2]["json"] == {"scroll": "2m", "scroll_id": "S2"}
    assert session.calls[3]["json"] == {"scroll_id": ["S3"]}
    assert all(c["auth"] == ("reader", "pw-secret!") and c["verify"] == "/ca.pem" for c in session.calls)
    assert session.calls[0]["json"]["sort"] == ["_doc"]


def test_doc_to_row():
    source = load_fixture("indexer_page1.json")["hits"]["hits"][0]["_source"]
    row = doc_to_row(source)
    assert row["vuln_id"] == "CVE-2024-12345"
    assert row["score_version"] == "3.1"
    assert row["refs"] == "https://example.com/a, http://example.com/b"


def test_one_line_fix_property(monkeypatch):
    monkeypatch.setitem(INDEXER_FIELDS, "vuln_id", "vulnerability.cve")
    assert doc_to_row({"vulnerability": {"cve": "CVE-2025-0001"}})["vuln_id"] == "CVE-2025-0001"


def test_missing_paths_are_none():
    assert get_path({"a": {"b": 1}}, "a.c.d") is None
    assert get_path({"a": 1}, "a.b") is None
    assert get_path({}, None) is None
    assert doc_to_row({})["vuln_id"] is None


def test_indexer_http_error_does_not_leak_the_password():
    reader, _ = indexer([(401, {"error": "bad credentials pw-secret!"})])
    with pytest.raises(WazuhReadError) as info:
        reader.fetch_hosts()
    assert info.value.exit_code == 3 and "pw-secret!" not in str(info.value)


def test_indexer_connection_error_does_not_leak_the_password():
    reader, _ = indexer([requests.ConnectionError("cannot reach https://reader:pw-secret!@wazuh")])
    with pytest.raises(WazuhReadError) as info:
        reader.fetch_hosts()
    assert "pw-secret!" not in str(info.value)


def test_scroll_is_cleared_even_when_a_page_fails():
    reader, session = indexer([(200, load_fixture("indexer_page1.json")), requests.ConnectionError("x"), (200, {})])
    with pytest.raises(WazuhReadError):
        reader.fetch_hosts()
    assert session.calls[-1]["method"] == "DELETE"
    assert session.calls[-1]["json"] == {"scroll_id": ["S1"]}


def test_delete_failure_is_ignored():
    script = pages()[:3] + [requests.ConnectionError("x")]
    reader, _ = indexer(script)
    assert len(reader.fetch_hosts()) == 2


def test_module_exposes_the_default_index():
    assert wazuh_indexer.DEFAULT_INDEX == INDEX


# ------------------------------------------------------------------------------------------------ api

def api_handler(vuln_status=None):
    state = {"auths": 0, "vuln_calls": 0}

    def handler(method, url, kwargs):
        path = url.removeprefix("https://wazuh:55000")
        params = kwargs.get("params") or {}
        if method == "POST" and path == "/security/user/authenticate":
            state["auths"] += 1
            return (200, {"data": {"token": f"jwt{state['auths']}"}})
        if path == "/agents":
            return (200, load_fixture("api_agents_page1.json" if params.get("offset") == 0 else "api_agents_page2.json"))
        if path == "/vulnerability/001/last_scan":
            return (200, load_fixture("api_last_scan_001.json"))
        if path == "/vulnerability/002/last_scan":
            return (200, load_fixture("api_last_scan_never.json"))
        if path == "/vulnerability/001":
            state["vuln_calls"] += 1
            if vuln_status is not None and state["vuln_calls"] in vuln_status:
                return (401, {"error": "expired"})
            return (200, load_fixture("api_vuln_001_page1.json" if params.get("offset") == 0 else "api_vuln_001_page2.json"))
        raise AssertionError(f"unexpected call {method} {url}")

    return handler, state


def api_reader(handler):
    session = FakeSession(handler=handler)
    return ApiReader("https://wazuh:55000", "wazuh-wui", "api-secret", "/ca.pem", 60, session=session, page_size=2), session


def test_api_authentication_and_bearer():
    handler, _ = api_handler()
    reader, session = api_reader(handler)
    reader.fetch_hosts()
    auth = session.calls[0]
    assert auth["method"] == "POST" and auth["auth"] == ("wazuh-wui", "api-secret")
    gets = [c for c in session.calls if c["method"] == "GET"]
    assert gets and all(c["headers"]["Authorization"] == "Bearer jwt1" for c in gets)
    assert all(c["verify"] == "/ca.pem" for c in session.calls)


def test_api_agents_are_paged():
    handler, _ = api_handler()
    reader, _ = api_reader(handler)
    assert [a["id"] for a in reader.list_agents()] == ["001", "002", "003"]


def test_api_skips_never_connected_and_never_scanned_agents():
    handler, _ = api_handler()
    reader, session = api_reader(handler)
    hosts = reader.fetch_hosts()
    assert [h["agent_id"] for h in hosts] == ["001"]  # 002 has no completed scan, 003 never connected
    assert not any(c["url"].endswith("/vulnerability/003/last_scan") for c in session.calls)


def test_api_rows_are_combined_across_pages():
    handler, _ = api_handler()
    reader, _ = api_reader(handler)
    host = reader.fetch_hosts()[0]
    assert [r["vuln_id"] for r in host["rows"]] == ["CVE-2024-12345", "CVE-2023-38545"]
    assert host["rows"][0]["score"] == 7.5 and host["rows"][0]["score_version"] is None
    assert host["hostname"] == "web-01" and host["os_name"] == "Ubuntu"


def test_scanned_agent_with_no_rows_is_a_clean_host():
    def handler(method, url, kwargs):
        path = url.removeprefix("https://wazuh:55000")
        if method == "POST":
            return (200, {"data": {"token": "jwt1"}})
        if path == "/agents":
            return (200, {"data": {"affected_items": [{"id": "001", "name": "web-01", "status": "active"}], "total_affected_items": 1}})
        if path == "/vulnerability/001/last_scan":
            return (200, load_fixture("api_last_scan_001.json"))
        return (200, {"data": {"affected_items": [], "total_affected_items": 0}})

    reader, _ = api_reader(handler)
    hosts = reader.fetch_hosts()
    assert len(hosts) == 1 and hosts[0]["rows"] == []


def test_api_reauthenticates_once_on_401():
    handler, state = api_handler(vuln_status={1})
    reader, _ = api_reader(handler)
    hosts = reader.fetch_hosts()
    assert len(hosts) == 1 and state["auths"] == 2


def test_api_second_401_fails():
    handler, state = api_handler(vuln_status={1, 2})
    reader, _ = api_reader(handler)
    with pytest.raises(WazuhReadError):
        reader.fetch_hosts()
    assert state["auths"] == 2


def test_api_errors_do_not_leak_the_password():
    reader, _ = api_reader(lambda m, u, k: requests.ConnectionError("failed api-secret"))
    with pytest.raises(WazuhReadError) as info:
        reader.authenticate()
    assert "api-secret" not in str(info.value)


def test_fake_response_is_used_for_info():
    session = FakeSession([FakeResponse(200, {"data": {"token": "t"}}), FakeResponse(200, load_fixture("api_info_4_7.json"))])
    reader = ApiReader("https://wazuh:55000", "u", "p", True, 60, session=session)
    assert reader.info()["api_version"] == "4.7.2"
