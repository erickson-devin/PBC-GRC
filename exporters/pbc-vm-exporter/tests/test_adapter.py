import json
import re
from datetime import datetime, timezone

import pytest

from pbc_vm_exporter import EXPORTER_NAME, __version__
from pbc_vm_exporter.adapter import (
    build_hosts,
    build_payloads,
    chunk_hosts,
    clean_line,
    encode_payload,
    map_severity,
    normalize_agent_id,
    normalize_cvss,
    normalize_datetime,
    normalize_refs,
    row_to_finding,
    utc_now_rfc3339,
)
from pbc_vm_exporter.validate import utf16_len, validate_payload


def row(**kw):
    base = {"vuln_id": "CVE-2024-0001", "severity": "High", "package_name": "openssl", "package_version": "3.0.1"}
    base.update(kw)
    return base


def raw_host(agent_id="001", rows=None, **kw):
    return {"agent_id": agent_id, "hostname": "h", "rows": rows if rows is not None else [row()], **kw}


# ------------------------------------------------------------------------------------------------ severity

@pytest.mark.parametrize(
    "value,expected",
    [
        ("Critical", "CRITICAL"), ("HIGH", "HIGH"), (" medium ", "MEDIUM"), ("Low", "LOW"), ("Untriaged", "UNKNOWN"),
        ("Moderate", "UNKNOWN"), ("", "UNKNOWN"), (None, "UNKNOWN"), (5, "UNKNOWN"),
    ],
)
def test_map_severity(value, expected):
    assert map_severity(value) == expected


# ------------------------------------------------------------------------------------------------ datetimes

@pytest.mark.parametrize(
    "value,expected",
    [
        ("2024-06-10T12:34:56Z", "2024-06-10T12:34:56Z"),
        ("2024-06-10T12:34:56.789Z", "2024-06-10T12:34:56.789Z"),
        ("2024-06-10T12:34:56.123456789Z", "2024-06-10T12:34:56.123Z"),
        ("2024-06-10T14:34:56+02:00", "2024-06-10T12:34:56Z"),
        ("2024-06-10 12:34:56", "2024-06-10T12:34:56Z"),
        ("2024-06-10", "2024-06-10T00:00:00Z"),
        ("yesterday", None), ("", None), (None, None), ("2024-02-30T00:00:00Z", None), (1718022896, None),
    ],
)
def test_normalize_datetime(value, expected):
    assert normalize_datetime(value) == expected


def test_bad_dates_are_omitted_not_null():
    finding = row_to_finding(row(detected_at="nope", published_at="never"))
    assert "detected_at" not in finding and "published_at" not in finding


# ------------------------------------------------------------------------------------------------ refs

def test_refs_from_comma_string():
    assert normalize_refs("https://a.example/x, https://b.example/y") == ["https://a.example/x", "https://b.example/y"]


def test_refs_filter_schemes_and_spaces():
    items = ["ftp://x", "https://ok.example", "javascript:alert(1)", "https://has space"]
    assert normalize_refs(items) == ["https://ok.example"]


def test_refs_cap_and_dedupe():
    many = [f"https://e.example/{i}" for i in range(25)]
    assert normalize_refs(many) == many[:20]
    assert normalize_refs(["https://a.example", "https://b.example", "https://a.example"]) == [
        "https://a.example", "https://b.example",
    ]


def test_refs_length_and_non_ascii():
    assert normalize_refs(["https://e.example/" + "a" * 2031]) == []  # 2049 characters
    assert len("https://e.example/" + "a" * 2030) == 2048
    assert normalize_refs(["https://e.example/" + "a" * 2030]) != []
    assert normalize_refs(["https://例え.jp/"]) == []


# ------------------------------------------------------------------------------------------------ cvss

@pytest.mark.parametrize(
    "score,version,expected",
    [
        (7.5, "3.1", 7.5), (7.5, "2.0", None), ("9.8", None, 9.8), ("n/a", None, None), (11, None, None),
        (-1, None, None), (True, None, None), (float("nan"), None, None),
    ],
)
def test_normalize_cvss(score, version, expected):
    assert normalize_cvss(score, version) == expected


# ------------------------------------------------------------------------------------------------ finding fields

def test_package_shape():
    f = row_to_finding(row(package_name="openssl", package_version="3.0.1"))
    assert f["package"] == {"name": "openssl", "version": "3.0.1", "fixed_version": None}


def test_package_omitted_without_name_and_version_optional():
    assert "package" not in row_to_finding(row(package_name=""))
    assert "version" not in row_to_finding(row(package_version=None))["package"]


def test_package_name_cut_to_255_units():
    f = row_to_finding(row(package_name="p" * 300))
    assert utf16_len(f["package"]["name"]) == 255


def test_title():
    assert row_to_finding(row(title="Line1\nLine2"))["title"] == "Line1 Line2"
    assert "title" not in row_to_finding(row(title=None))
    assert utf16_len(row_to_finding(row(title="t" * 600))["title"]) == 512


def test_title_never_splits_a_surrogate_pair():
    f = row_to_finding(row(title="a" * 511 + "\U0001F600"))
    f["title"].encode("utf-8")  # raises on a lone surrogate
    assert utf16_len(f["title"]) <= 512
    assert clean_line("a" * 511 + "\U0001F600", 512) == "a" * 511


def test_vuln_id_kept_as_reported_or_row_dropped():
    assert row_to_finding(row(vuln_id="cve-2024-0001"))["vuln_id"] == "cve-2024-0001"
    hosts, stats = build_hosts([raw_host(rows=[row(vuln_id="bad id!")])])
    assert stats.dropped_rows == 1
    assert hosts[0]["findings"] == []


def test_finding_key_order():
    f = row_to_finding(row(title="t", score=7.5, score_version="3.1", detected_at="2024-06-10", published_at="2024-06-09", refs="https://a.example"))
    assert list(f) == ["vuln_id", "title", "severity", "cvss_v3", "package", "detected_at", "published_at", "refs"]


# ------------------------------------------------------------------------------------------------ hosts

def test_same_cve_in_two_packages_is_two_findings():
    hosts, _ = build_hosts([raw_host(rows=[row(package_name="a"), row(package_name="b")])])
    assert len(hosts[0]["findings"]) == 2


def test_identical_rows_collapse():
    hosts, _ = build_hosts([raw_host(rows=[row(), row()])])
    assert len(hosts[0]["findings"]) == 1


def test_hosts_merge_by_normalized_agent_id():
    hosts, _ = build_hosts([
        raw_host("001", rows=[row(vuln_id="CVE-2024-0001")]),
        raw_host(1, rows=[row(vuln_id="CVE-2024-0002")]),
    ])
    assert len(hosts) == 1
    assert [f["vuln_id"] for f in hosts[0]["findings"]] == ["CVE-2024-0001", "CVE-2024-0002"]


def test_normalize_agent_id():
    assert normalize_agent_id(1) == "001"
    assert normalize_agent_id(" 002 ") == "002"
    assert normalize_agent_id("abc") == "abc"
    assert normalize_agent_id("") is None
    hosts, stats = build_hosts([raw_host("")])
    assert hosts == [] and stats.dropped_hosts == 1


def test_hostname_cleaned_and_omitted_when_empty():
    assert build_hosts([raw_host(hostname="  web-01 \n")])[0][0]["hostname"] == "web-01"
    assert "hostname" not in build_hosts([raw_host(hostname="")])[0][0]


def test_host_over_5000_findings_is_skipped_whole():
    big = raw_host("001", rows=[row(vuln_id=f"CVE-2024-{i:04d}") for i in range(1, 5002)])
    hosts, stats = build_hosts([big, raw_host("002")])
    assert stats.skipped_hosts == ["001"]
    assert [h["agent_id"] for h in hosts] == ["002"]


def test_ip_and_mac_kept_only_when_valid():
    host = build_hosts([raw_host(ip="10.0.0.5", mac="aa:bb:cc:dd:ee:ff")])[0][0]
    assert host["ip"] == "10.0.0.5" and host["mac"] == "aa:bb:cc:dd:ee:ff"
    host = build_hosts([raw_host(ip="ten dot zero", mac="zz:zz")])[0][0]
    assert "ip" not in host and "mac" not in host


# ------------------------------------------------------------------------------------------------ chunking

def plain_hosts(n, findings=0):
    return [
        {"agent_id": f"a{i:05d}", "findings": [{"vuln_id": "CVE-2024-0001", "severity": "LOW"}] * findings}
        for i in range(n)
    ]


@pytest.mark.parametrize(
    "count,sizes", [(500, [500]), (501, [500, 1]), (1000, [500, 500]), (1001, [500, 500, 1])]
)
def test_chunks_by_host_count(count, sizes):
    chunks, skipped = chunk_hosts(plain_hosts(count), max_hosts=500, max_findings=50000, max_bytes=33554432)
    assert [len(c) for c in chunks] == sizes and skipped == []


def test_chunks_by_findings():
    chunks, _ = chunk_hosts(plain_hosts(11, 5000), max_hosts=500, max_findings=50000, max_bytes=33554432)
    assert [len(c) for c in chunks] == [10, 1]


def test_chunks_by_bytes():
    hosts = [
        {"agent_id": f"a{i}", "hostname": "h", "findings": [{"vuln_id": "CVE-2024-0001", "severity": "LOW", "title": "t" * 400}] * 3}
        for i in range(5)
    ]
    size = len(encode_payload(hosts[0])) + 1
    assert 1400 < size < 1535  # about 1500 bytes each
    chunks, skipped = chunk_hosts(hosts, max_hosts=500, max_findings=50000, max_bytes=4096)
    assert [len(c) for c in chunks] == [2, 2, 1] and skipped == []


def test_single_host_larger_than_the_byte_budget_is_skipped():
    big = {"agent_id": "big", "findings": [{"vuln_id": "CVE-2024-0001", "severity": "LOW", "title": "t" * 500}] * 20}
    chunks, skipped = chunk_hosts([big, *plain_hosts(1)], max_hosts=500, max_findings=50000, max_bytes=4096)
    assert skipped == ["big"] and [len(c) for c in chunks] == [1]


def test_every_chunk_is_valid_and_hosts_are_never_split():
    raw = [raw_host(f"{i:03d}", rows=[row(vuln_id=f"CVE-2024-{j:04d}") for j in range(1, 4)]) for i in range(1, 8)]
    now = datetime(2026, 10, 18, 12, 0, 0, tzinfo=timezone.utc)
    payloads, _ = build_payloads(raw, label="wazuh-prod", now=now, max_hosts=3)
    assert len(payloads) == 3
    for p in payloads:
        assert validate_payload(json.loads(encode_payload(p))) is None
    assert len({json.dumps([p["source"], p["exporter"], p["collected_at"]]) for p in payloads}) == 1
    ids = [h["agent_id"] for p in payloads for h in p["hosts"]]
    assert sorted(ids) == sorted({f"{i:03d}" for i in range(1, 8)}) and len(ids) == len(set(ids))


# ------------------------------------------------------------------------------------------------ envelope

def test_exporter_envelope():
    payloads, _ = build_payloads([raw_host()], label="wazuh-prod")
    assert payloads[0]["exporter"] == {"name": "pbc-vm-exporter", "version": __version__}
    assert EXPORTER_NAME == "pbc-vm-exporter"
    assert re.fullmatch(r"[A-Za-z0-9.+_-]{1,32}", __version__)
    assert payloads[0]["source"] == {"kind": "WAZUH", "label": "wazuh-prod"}
    assert payloads[0]["schema_version"] == 1


def test_utc_now():
    assert utc_now_rfc3339(datetime(2026, 10, 18, 12, 0, 0, tzinfo=timezone.utc)) == "2026-10-18T12:00:00Z"
    assert re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", utc_now_rfc3339())


def test_zero_hosts_gives_no_payloads():
    payloads, stats = build_payloads([], label="wazuh-prod")
    assert payloads == [] and stats.skipped_hosts == []


def test_same_input_gives_identical_bytes():
    now = datetime(2026, 10, 18, 12, 0, 0, tzinfo=timezone.utc)
    raw = [raw_host("002"), raw_host("001", rows=[row(vuln_id="CVE-2024-0002"), row()])]
    a, _ = build_payloads(raw, label="l", now=now)
    b, _ = build_payloads(list(reversed(raw)), label="l", now=now)
    assert [encode_payload(p) for p in a] == [encode_payload(p) for p in b]
