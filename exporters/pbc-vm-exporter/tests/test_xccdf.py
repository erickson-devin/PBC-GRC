import hashlib

import pytest

from conftest import FIXTURES
from pbc_vm_exporter.adapter import build_config_payloads, chunk_config_hosts
from pbc_vm_exporter.errors import ScanFileError
from pbc_vm_exporter.validate import validate_payload
from pbc_vm_exporter.xccdf import expand_inputs, read_xccdf, xccdf_id

X12 = FIXTURES / "xccdf12_results.xml"
X11 = FIXTURES / "xccdf11_results.xml"
ARF = FIXTURES / "arf_results.xml"


def one_host(path):
    hosts = read_xccdf([path])
    assert len(hosts) == 1
    return hosts[0]


def test_xccdf12_identity_and_results():  # X1
    host = one_host(X12)
    assert host["agent_id"] == "xccdf-" + hashlib.sha256(b"cfg-host-01").hexdigest()[:32]
    assert host["hostname"] == "cfg-host-01" and host["ip"] == "192.0.2.10" and host["mac"] == "00:00:5E:00:53:10"
    assert "findings" not in host
    (scan,) = host["configuration"]
    assert scan["benchmark"] == {"id": "benchmark_sample", "version": "1.0", "title": "Fixture baseline 1.2"}
    assert scan["profile"] == {"id": "profile_baseline", "title": "Sample baseline profile"}
    assert scan["scanner"] == {"name": "cpe:/a:example:scanner:1.0"}
    assert scan["started_at"] == "2026-10-01T10:00:00Z" and scan["scanned_at"] == "2026-10-01T10:05:00Z"
    assert scan["source_sha256"] == hashlib.sha256(X12.read_bytes()).hexdigest()
    results = scan["results"]
    assert [r["rule_id"] for r in results] == sorted(r["rule_id"] for r in results)
    assert {r["rule_id"]: r["result"] for r in results} == {
        "rule_accounts_password_minlen": "fail",
        "rule_audit_logging_enabled": "error",
        "rule_service_telnet_disabled": "notapplicable",
        "rule_sshd_disable_root_login": "pass",
    }
    by_id = {r["rule_id"]: r for r in results}
    assert by_id["rule_sshd_disable_root_login"]["title"] == "Disable SSH root login"
    assert by_id["rule_sshd_disable_root_login"]["cce"] == "CCE-27445-6"
    assert by_id["rule_accounts_password_minlen"]["cci"] == ["CCI-000205"]
    assert by_id["rule_service_telnet_disabled"]["severity"] == "high"


def test_arf_uses_the_asset_fqdn_and_skips_loopback():  # X2
    host = one_host(ARF)
    assert host["hostname"] == "cfg-host-02.example.test"
    assert host["ip"] == "192.0.2.11" and host["mac"] == "00:00:5E:00:53:11"
    assert host["agent_id"] == "xccdf-" + hashlib.sha256(b"cfg-host-02.example.test").hexdigest()[:32]
    (scan,) = host["configuration"]
    assert scan["benchmark"]["id"] == "benchmark_arf" and scan["scanned_at"] == "2026-10-02T08:03:00Z"
    assert {r["rule_id"]: r["result"] for r in scan["results"]} == {
        "rule_accounts_password_minlen": "fail", "rule_sshd_disable_root_login": "pass",
    }


def test_xccdf11_matches_xccdf12():  # X3
    a, b = one_host(X12), one_host(X11)
    assert a["agent_id"] == b["agent_id"]
    assert [(r["rule_id"], r["result"]) for r in a["configuration"][0]["results"]] == [
        (r["rule_id"], r["result"]) for r in b["configuration"][0]["results"]
    ]


def test_doctype_is_refused_without_naming_the_path():  # X4
    path = FIXTURES / "doctype.xml"
    with pytest.raises(ScanFileError) as caught:
        read_xccdf([path])
    assert caught.value.exit_code == 3
    assert "input 1" in str(caught.value) and str(path) not in str(caught.value) and "doctype.xml" not in str(caught.value)


@pytest.mark.parametrize("marker", [b"<!DOCTYPE x>", b"<!doctype x>", b"<!ENTITY a 'b'>", b"<!entity a 'b'>"])
def test_doctype_and_entity_any_case(tmp_path, marker):
    path = tmp_path / "a.xml"
    path.write_bytes(b'<?xml version="1.0"?>' + marker + b"<r/>")
    with pytest.raises(ScanFileError):
        read_xccdf([path])


def test_utf16_is_refused(tmp_path):
    path = tmp_path / "a.xml"
    path.write_bytes("<?xml version='1.0' encoding='utf-16'?><!DOCTYPE r><r/>".encode("utf-16"))
    with pytest.raises(ScanFileError):
        read_xccdf([path])


def test_oversized_input_is_refused(tmp_path, monkeypatch):
    path = tmp_path / "a.xml"
    path.write_bytes(X12.read_bytes())
    monkeypatch.setattr("pbc_vm_exporter.xccdf.MAX_INPUT_BYTES", 10)
    with pytest.raises(ScanFileError) as caught:
        read_xccdf([path])
    assert "larger than" in str(caught.value)


def test_not_well_formed_and_not_xccdf(tmp_path):
    bad = tmp_path / "bad.xml"
    bad.write_text("<a><b></a>", encoding="utf-8")
    with pytest.raises(ScanFileError) as caught:
        read_xccdf([bad])
    assert "bad.xml" not in str(caught.value)
    with pytest.raises(ScanFileError) as caught:
        read_xccdf([FIXTURES / "not_xccdf.xml"])
    assert str(caught.value) == "no XCCDF TestResult with results was found; nothing was sent"


def test_duplicate_idref_keeps_the_worst(tmp_path):  # X5
    text = X12.read_text(encoding="utf-8").replace(
        "</TestResult>",
        '<rule-result idref="rule_sshd_disable_root_login"><result>fail</result></rule-result></TestResult>',
    )
    path = tmp_path / "dup.xml"
    path.write_text(text, encoding="utf-8")
    results = one_host(path)["configuration"][0]["results"]
    matching = [r for r in results if r["rule_id"] == "rule_sshd_disable_root_login"]
    assert len(matching) == 1 and matching[0]["result"] == "fail"
    assert matching[0]["cce"] == "CCE-27445-6"  # the pass row's ident is kept


def test_naive_times_are_utc():  # X6
    scan = one_host(X11)["configuration"][0]
    assert scan["started_at"] == "2026-10-01T10:00:00Z" and scan["scanned_at"] == "2026-10-01T10:05:00Z"


def test_payload_validates_with_kind_scap():  # X7
    hosts = read_xccdf([X12, ARF])
    payloads, skipped = build_config_payloads(hosts, label="scap-test")
    assert skipped == [] and len(payloads) == 1
    p = payloads[0]
    assert p["source"] == {"kind": "SCAP", "label": "scap-test"}
    assert all("findings" not in h for h in p["hosts"])
    assert validate_payload(p) is None


def test_collected_at_is_the_same_for_every_chunk():  # X7
    hosts = read_xccdf([X12, ARF])
    payloads, _ = build_config_payloads(hosts, label="l", max_hosts=1)
    assert len(payloads) == 2 and payloads[0]["collected_at"] == payloads[1]["collected_at"]
    assert all(validate_payload(p) is None for p in payloads)


def host_with_results(agent_id, n):
    return {
        "agent_id": agent_id,
        "configuration": [{
            "benchmark": {"id": "b"}, "scanner": {"name": "s"}, "scanned_at": "2026-10-01T00:00:00Z",
            "results": [{"rule_id": f"r{i}", "result": "pass"} for i in range(n)],
        }],
    }


def test_chunks_never_split_a_host():  # X8
    hosts = [host_with_results("a", 60000), host_with_results("b", 60000)]
    chunks, skipped = chunk_config_hosts(hosts, max_hosts=500, max_results=100000, max_bytes=33554432)
    assert skipped == [] and [[h["agent_id"] for h in c] for c in chunks] == [["a"], ["b"]]
    chunks, skipped = chunk_config_hosts([host_with_results("a", 6)], max_hosts=500, max_results=5, max_bytes=33554432)
    assert chunks == [] and skipped == ["a"]


def test_two_inputs_for_one_host_merge_and_duplicates_collapse(tmp_path):
    other = tmp_path / "later.xml"
    other.write_text(X12.read_text(encoding="utf-8").replace("2026-10-01", "2026-10-08"), encoding="utf-8")
    hosts = read_xccdf([X12, X12, other])
    assert len(hosts) == 1
    assert [s["scanned_at"] for s in hosts[0]["configuration"]] == ["2026-10-01T10:05:00Z", "2026-10-08T10:05:00Z"]


def test_expand_inputs_directory_and_missing(tmp_path):
    (tmp_path / "b.xml").write_text("<a/>", encoding="utf-8")
    (tmp_path / "a.xml").write_text("<a/>", encoding="utf-8")
    (tmp_path / "c.txt").write_text("x", encoding="utf-8")
    assert [p.name for p in expand_inputs([str(tmp_path)])] == ["a.xml", "b.xml"]
    with pytest.raises(ScanFileError) as caught:
        expand_inputs([str(X12), str(tmp_path / "missing.xml")])
    assert "argument 2" in str(caught.value) and "missing" not in str(caught.value)


def test_xccdf_id_sanitising():
    assert xccdf_id("xccdf_org.ssgproject.content_rule_x") == "xccdf_org.ssgproject.content_rule_x"
    assert xccdf_id("a b/c") == "a_b_c"
    assert xccdf_id("-x") == "_-x"
    assert xccdf_id("") is None and xccdf_id(None) is None
    assert len(xccdf_id("a" * 400)) == 255
