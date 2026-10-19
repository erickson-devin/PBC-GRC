import copy

import pytest

from conftest import valid_payload
from pbc_vm_exporter.validate import (
    assert_supported_keywords,
    format_json_path,
    load_contract,
    validate_payload,
)

F0 = "$.hosts[0].findings[0]"


def mutated(fn):
    p = valid_payload()
    fn(p)
    return p


def err(fn):
    return validate_payload(mutated(fn))


def set_finding(**kw):
    def fn(p):
        p["hosts"][0]["findings"][0].update(kw)
    return fn


def hosts_with(counts):
    return {
        **valid_payload(),
        "hosts": [
            {"agent_id": f"agent-{i}", "findings": [{"vuln_id": "CVE-2024-0001", "severity": "LOW"}] * n}
            for i, n in enumerate(counts)
        ],
    }


# ------------------------------------------------------------------------------------------------ accepted

def test_valid_payload_is_accepted():
    assert validate_payload(valid_payload()) is None


def test_empty_hosts_accepted():
    assert err(lambda p: p.update(hosts=[])) is None


def test_schema_version_1_accepted():
    assert err(lambda p: p.update(schema_version=1)) is None


# ------------------------------------------------------------------------------------------------ rejected at a path

def test_schema_version_2_rejected():
    assert err(lambda p: p.update(schema_version=2)).startswith("$.schema_version:")


def test_schema_version_true_rejected():
    assert err(lambda p: p.update(schema_version=True)).startswith("$.schema_version:")


def test_root_must_be_an_object():
    assert validate_payload([]).startswith("$:")
    assert validate_payload(None).startswith("$:")


@pytest.mark.parametrize("key", ["source", "exporter", "collected_at", "hosts"])
def test_missing_top_level_key(key):
    assert err(lambda p: p.pop(key)).startswith(f"$.{key}:")


def test_missing_required_message_is_exact():
    assert err(lambda p: p.pop("source")) == "$.source: required"


def test_missing_vuln_id_path():
    assert err(lambda p: p["hosts"][0]["findings"][0].pop("vuln_id")).startswith(f"{F0}.vuln_id:")


# ------------------------------------------------------------------------------------------------ unknown fields

def test_unknown_fields_exact_messages():
    assert err(lambda p: p.update(extra=1)) == "$.extra: unknown field"
    assert err(lambda p: p.update({"vendor-field": 1})) == '$["vendor-field"]: unknown field'
    assert err(lambda p: p["hosts"][0]["findings"][0]["package"].update(x=1)) == f"{F0}.package.x: unknown field"
    assert err(lambda p: p["hosts"][0]["os"].update(x=1)) == "$.hosts[0].os.x: unknown field"


# ------------------------------------------------------------------------------------------------ enums

def test_enums():
    assert err(lambda p: p["source"].update(kind="QUALYS")).startswith("$.source.kind:")
    assert err(set_finding(severity="SEVERE")).startswith(f"{F0}.severity:")


# ------------------------------------------------------------------------------------------------ label

@pytest.mark.parametrize(
    "label,ok",
    [("", False), ("a" * 128, True), ("a" * 129, False), ("a\nb", False), ("\U0001F600" * 64, True)],
)
def test_label(label, ok):
    result = err(lambda p: p["source"].update(label=label))
    assert (result is None) == ok, result


def test_label_trailing_newline_is_rejected():
    # Python's `$` would let this through; the validator turns it into \Z.
    assert err(lambda p: p["source"].update(label="a\n")).startswith("$.source.label:")


def test_label_counts_utf16_units():
    assert err(lambda p: p["source"].update(label="\U0001F600" * 65)).startswith("$.source.label:")


# ------------------------------------------------------------------------------------------------ other fields

def test_exporter_fields():
    assert err(lambda p: p["exporter"].update(name="bad name")).startswith("$.exporter.name:")
    assert err(lambda p: p["exporter"].update(version="v" * 33)).startswith("$.exporter.version:")


def test_host_fields_each_rejected_at_their_own_path():
    assert err(lambda p: p["hosts"][0].update(ip="ten dot zero")).startswith("$.hosts[0].ip:")
    assert err(lambda p: p["hosts"][0].update(mac="zz:zz")).startswith("$.hosts[0].mac:")
    assert err(lambda p: p["hosts"][0].update(hostname="h" * 256)).startswith("$.hosts[0].hostname:")


def test_vuln_id():
    assert err(set_finding(vuln_id="not a cve!")).startswith(f"{F0}.vuln_id:")
    assert err(set_finding(vuln_id="cve-2024-1234")) is None
    assert err(set_finding(vuln_id="CVE-2024-123")) is None  # second branch of the pattern, same as the server


@pytest.mark.parametrize("value", [11, -0.1, True, "7.5"])
def test_cvss_rejected(value):
    assert err(set_finding(cvss_v3=value)).startswith(f"{F0}.cvss_v3:")


@pytest.mark.parametrize("value", [None, 10])
def test_cvss_accepted(value):
    assert err(set_finding(cvss_v3=value)) is None


def test_refs():
    assert err(set_finding(refs=["ftp://example.com/x"])).startswith(f"{F0}.refs[0]:")
    assert err(set_finding(refs=["https://example.com/x"] * 21)).startswith(f"{F0}.refs:")
    assert err(set_finding(refs=["https://example.com/x"] * 20)) is None
    assert err(set_finding(refs=["https://a b"])).startswith(f"{F0}.refs[0]:")


# ------------------------------------------------------------------------------------------------ collected_at

@pytest.mark.parametrize(
    "value",
    [
        "yesterday", "2026-10-18", "2026-10-18T12:00:00", "2026-13-45T99:00:00Z", "2026-02-30T00:00:00Z",
        "2026-10-18t12:00:00z", "２０２６-10-18T12:00:00Z",
    ],
)
def test_collected_at_invalid(value):
    assert err(lambda p: p.update(collected_at=value)) == "$.collected_at: not a valid date-time"


def test_collected_at_valid_forms():
    assert err(lambda p: p.update(collected_at="2026-10-18T12:00:00+02:00")) is None
    assert err(lambda p: p.update(collected_at="2026-10-18T12:00:00.123456789Z")) is None


def test_collected_at_too_long():
    assert err(lambda p: p.update(collected_at="2026-10-18T12:00:00Z" + " " * 21)).startswith("$.collected_at:")


def test_published_at():
    assert err(set_finding(published_at="someday")) == f"{F0}.published_at: not a valid date-time"
    assert err(set_finding(published_at=None)) is None


# ------------------------------------------------------------------------------------------------ counts

def test_host_count():
    assert validate_payload(hosts_with([0] * 1001)).startswith("$.hosts:")
    assert validate_payload(hosts_with([0] * 1000)) is None


def test_findings_per_host():
    assert validate_payload(hosts_with([5001])).startswith("$.hosts[0].findings:")
    assert validate_payload(hosts_with([5000])) is None


def test_total_findings():
    assert validate_payload(hosts_with([5000] * 10 + [1])) == "$.hosts: at most 50000 findings in total"
    assert validate_payload(hosts_with([5000] * 10)) is None


# ------------------------------------------------------------------------------------------------ duplicates and order

def test_duplicate_agent_id():
    p = valid_payload()
    base = p["hosts"][0]
    p["hosts"] = [
        {**copy.deepcopy(base), "agent_id": "a"},
        {**copy.deepcopy(base), "agent_id": "b"},
        {**copy.deepcopy(base), "agent_id": "a"},
    ]
    assert validate_payload(p) == "$.hosts[2].agent_id: duplicate agent_id (also at $.hosts[0])"


def test_first_error_follows_shape_order():
    p = {"source": valid_payload()["source"], "exporter": {"name": "!", "version": "1"}, "collected_at": "bad", "hosts": "nope"}
    assert validate_payload(p).startswith("$.exporter.name:")


# ------------------------------------------------------------------------------------------------ helpers

@pytest.mark.parametrize(
    "path,expected",
    [
        ([], "$"),
        (["hosts", 3, "findings", 0, "vuln_id"], "$.hosts[3].findings[0].vuln_id"),
        (["a-b"], '$["a-b"]'),
        (["1x"], '$["1x"]'),
        (['q"t'], '$["q\\"t"]'),
    ],
)
def test_format_json_path(path, expected):
    assert format_json_path(path) == expected


def test_keyword_audit_passes_on_the_vendored_schema():
    assert_supported_keywords(load_contract())


def test_keyword_audit_fails_closed_on_a_new_keyword():
    schema = load_contract()
    schema["properties"]["hosts"]["minItems"] = 1
    with pytest.raises(ValueError):
        assert_supported_keywords(schema)
