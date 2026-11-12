"""Wazuh host inventory (hardware, software, MAC, address): reading, mapping, validation, sending and `check`.

Every value is fake. Logging stays counts-only: agent ids, hostnames, package names and serials never appear in a log.
"""

import copy
import io
import json
import logging

import pytest
import requests

from conftest import FakeResponse, FakeSession, SERVER_SCHEMA, TOKEN, load_fixture
from pbc_vm_exporter import cli
from pbc_vm_exporter.adapter import build_hosts, build_payloads, chunk_hosts
from pbc_vm_exporter.cli import attach_inventory, main, should_send_inventory
from pbc_vm_exporter.client import INVENTORY_HINT, IngestClient
from pbc_vm_exporter.config import load_config
from pbc_vm_exporter.errors import ConfigError, RejectedError, WazuhReadError
from pbc_vm_exporter.validate import validate_payload
from pbc_vm_exporter.wazuh_indexer import INVENTORY_KINDS, IndexerReader, group_inventory

URL = "https://wazuh:9200"
ENV = {"PBC_URL": "https://grc.local", "PBC_SERVICE_TOKEN": TOKEN, "PBC_SOURCE_LABEL": "wazuh-prod", "WAZUH_MODE": "indexer"}
INDEXER_ENV = {**ENV, "WAZUH_INDEXER_URL": URL, "WAZUH_INDEXER_USER": "reader", "WAZUH_INDEXER_PASSWORD": "pw-secret!"}
NAMES = ("inv-web-01", "inv-db-01", "fixture-lib", "FIX-SN-0001", "KB1000001", "192.0.2.21")


def fixture_docs() -> dict:
    return {kind: load_fixture(f"inventory_{kind}.json") for kind in INVENTORY_KINDS}


def run(argv, environ):
    out, err = io.StringIO(), io.StringIO()
    code = main(argv, environ=environ, stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


def index_handler(docs, missing=(), failing=None):
    """A fake indexer: one scroll page per inventory index, then an empty page."""

    def handler(method, url, kwargs):
        if method == "DELETE":
            return 200, {}
        if "/_search/scroll" in url:
            return 200, {"hits": {"hits": []}, "_scroll_id": "s1"}
        for kind in INVENTORY_KINDS:
            if f"/wazuh-states-inventory-{kind}-*/_search" in url:
                if failing == kind:
                    return 403, {"error": "forbidden"}
                found = [] if kind in missing else docs[kind]
                return 200, {"hits": {"hits": [{"_source": d} for d in found]}, "_scroll_id": "s1"}
        raise AssertionError(f"unexpected request {method} {url}")

    return handler


def reader_for(handler):
    session = FakeSession(handler=handler)
    return IndexerReader(URL, "reader", "pw-secret!", True, 60, session=session), session


# ------------------------------------------------------------------------------------------------ reading (P1-P7)

def test_p1_fetch_inventory_reads_the_six_indices_and_groups_per_agent():
    reader, session = reader_for(index_handler(fixture_docs()))
    inventory = reader.fetch_inventory()
    assert sorted(inventory) == ["001", "002"]
    web = inventory["001"]
    assert web["agent_name"] == "inv-web-01" and web["ip"] == "192.0.2.21"
    assert (web["os_name"], web["os_version"], web["os_platform"], web["os_kernel"]) == (
        "Ubuntu", "22.04.4 LTS", "ubuntu", "5.15.0-fixture")
    assert web["hardware"] == {
        "cpu_name": "Fixture Octa-Core", "cpu_cores": 8, "cpu_mhz": 3400, "memory_bytes": 17179869184,
        "serial_number": "FIX-SN-0001", "architecture": "x86_64",
    }
    searched = [c["url"] for c in session.calls if c["method"] == "POST" and "_search/scroll" not in c["url"]]
    assert len(searched) == len(INVENTORY_KINDS)
    assert all("ignore_unavailable=true" in url for url in searched)
    for call in session.calls:
        if call["method"] == "POST" and "_search/scroll" not in call["url"]:
            assert "_source" in call["json"]  # only the fields that are used are read


def test_p2_hotfixes_become_software_items_of_type_hotfix_and_are_deduplicated():
    inventory = group_inventory(fixture_docs())
    items = inventory["002"]["software"]
    hotfixes = [i for i in items if i.get("type") == "hotfix"]
    assert sorted(i["name"] for i in hotfixes) == ["KB1000001", "KB1000002"]
    assert len(items) == 3


def test_p3_duplicate_packages_keep_the_first():
    items = group_inventory(fixture_docs())["001"]["software"]
    assert [(i["name"], i["version"]) for i in items] == [("fixture-lib", "1.0"), ("fixture-tool", "2.1")]
    assert items[0]["vendor"] == "Fixture Vendor"


def test_p4_over_ten_thousand_packages_is_an_overflow_and_nothing_is_truncated(caplog):
    docs = fixture_docs()
    agent = docs["packages"][0]["agent"]
    docs["packages"] = [{"agent": agent, "package": {"name": f"pkg-{i}", "version": "1"}} for i in range(10001)]
    inventory = group_inventory(docs)
    assert inventory["001"]["software"] is None and inventory["001"]["software_overflow"] is True
    with caplog.at_level(logging.DEBUG, logger="pbc_vm_exporter"):
        hosts, stats = build_hosts([{"agent_id": "001", "rows": [], "inventory": inventory["001"]}])
    assert stats.software_overflow_hosts == 1
    assert "software" not in hosts[0] and hosts[0]["findings"] == []
    assert "hardware" in hosts[0]
    for name in ("001", "pkg-1"):
        assert name not in caplog.text


def test_p5_mac_is_the_interface_that_carries_the_agent_address_else_the_first_up_one():
    inventory = group_inventory(fixture_docs())
    # 001: the network document ties eth1 to the agent address, so eth1 wins over the first up interface (eth0)
    assert inventory["001"]["mac"] == "02:00:00:00:21:02"
    # 002: no network document carries the agent address; ens3 is down, so the first up interface (ens4) is chosen
    assert inventory["002"]["mac"] == "02:00:00:00:22:02"
    docs = fixture_docs()
    docs["interfaces"] = [d for d in docs["interfaces"] if d["interface"]["name"] == "lo"]
    assert group_inventory(docs)["001"]["mac"] is None  # an all-zero address is never chosen


def test_p6_ip_is_the_agent_host_ip_from_any_inventory_document():
    docs = fixture_docs()
    docs["hardware"][0]["agent"]["host"]["ip"] = ["192.0.2.30", "192.0.2.31"]
    assert group_inventory(docs)["001"]["ip"] == "192.0.2.30"
    docs = {"interfaces": [{"agent": {"id": "007", "host": {"ip": "192.0.2.77"}}, "host": {"mac": "02:00:00:00:00:07"},
                            "interface": {"name": "eth0", "state": "up"}}]}
    inventory = group_inventory(docs)
    assert inventory["007"]["ip"] == "192.0.2.77" and inventory["007"]["hardware"] is None
    assert inventory["007"]["software"] is None  # no package documents: the software is unknown, not empty


def test_p7_a_missing_or_empty_index_is_no_inventory_and_a_403_is_a_read_error():
    reader, _ = reader_for(index_handler(fixture_docs(), missing=INVENTORY_KINDS))
    assert reader.fetch_inventory() == {}
    reader, _ = reader_for(index_handler(fixture_docs(), failing="packages"))
    with pytest.raises(WazuhReadError, match="HTTP 403"):
        reader.fetch_inventory()


# ------------------------------------------------------------------------------------------------ mapping (P8-P9)

def test_p8_inventory_fills_the_vulnerability_host_and_an_inventory_only_host_has_no_findings_key():
    inventory = group_inventory(fixture_docs())
    raw = [{
        "agent_id": "001", "hostname": "inv-web-01", "os_name": "Ubuntu Server", "os_version": None,
        "rows": [{"vuln_id": "CVE-2024-0001", "severity": "High"}],
    }]
    hosts, _ = build_hosts(attach_inventory(raw, inventory))
    by_id = {h["agent_id"]: h for h in hosts}
    web = by_id["001"]
    assert web["ip"] == "192.0.2.21" and web["mac"] == "02:00:00:00:21:02"
    # the vulnerability document's OS name wins; the missing version, platform and kernel come from the inventory
    assert web["os"] == {"name": "Ubuntu Server", "version": "22.04.4 LTS", "platform": "ubuntu", "kernel": "5.15.0-fixture"}
    assert len(web["findings"]) == 1 and web["hardware"]["cpu_cores"] == 8
    assert [s["name"] for s in web["software"]] == ["fixture-lib", "fixture-tool"]
    db = by_id["002"]
    assert "findings" not in db and db["hostname"] == "inv-db-01"
    assert db["os"]["name"] == "Microsoft Windows 11 Pro"
    assert [s["name"] for s in db["software"]] == ["Fixture Suite", "KB1000001", "KB1000002"]
    assert "installed_at" not in db["software"][0]  # "not a date" is dropped, the item stays
    payloads, _ = build_payloads(attach_inventory(raw, inventory), label="wazuh-prod")
    assert validate_payload(payloads[0]) is None


def test_p8b_the_raw_hosts_are_not_changed_and_an_inventory_without_anything_sendable_is_skipped():
    inventory = group_inventory(fixture_docs())
    raw = [{"agent_id": "001", "rows": []}]
    before = copy.deepcopy(raw)
    attach_inventory(raw, inventory)
    assert raw == before
    only_ip = {"agent_id": "5", "ip": "192.0.2.5", "hardware": None, "software": None, "software_overflow": False}
    hosts, _ = build_hosts([{"agent_id": "005", "rows": [], "inventory": only_ip, "inventory_only": True}])
    assert hosts == []


def test_p9_chunking_budgets_software_and_never_splits_a_host():
    def host(i, n):
        return {"agent_id": f"{i:03d}", "findings": [], "software": [{"name": f"p{k}"} for k in range(n)]}

    hosts = [host(1, 100), host(2, 100), host(3, 100), host(4, 100), host(5, 100)]
    chunks, skipped = chunk_hosts(hosts, max_hosts=500, max_findings=50000, max_bytes=33554432, max_software=250)
    assert [[h["agent_id"] for h in c] for c in chunks] == [["001", "002"], ["003", "004"], ["005"]] and skipped == []
    chunks, skipped = chunk_hosts([host(1, 10), host(2, 300)], max_hosts=500, max_findings=50000, max_bytes=33554432,
                                  max_software=250)
    assert [[h["agent_id"] for h in c] for c in chunks] == [["001"]] and skipped == ["002"]


# ------------------------------------------------------------------------------------------------ validation (P10)

def base_payload():
    payloads, _ = build_payloads([{"agent_id": "001", "rows": []}], label="wazuh-prod")
    return payloads[0]


def test_p10_integer_fields_and_the_inventory_host_rule():
    p = base_payload()
    p["hosts"][0]["hardware"] = {"cpu_cores": 4.0, "memory_bytes": 8589934592}
    assert validate_payload(p) is None  # JSON has one number type: 4.0 is the integer 4
    for bad, message in (
        (1.5, "$.hosts[0].hardware.cpu_cores: expected integer"),
        (True, "$.hosts[0].hardware.cpu_cores: expected integer"),
        ("4", "$.hosts[0].hardware.cpu_cores: expected integer"),
        (4097, "$.hosts[0].hardware.cpu_cores: must be at most 4096"),
        (-1, "$.hosts[0].hardware.cpu_cores: must be at least 0"),
    ):
        p["hosts"][0]["hardware"] = {"cpu_cores": bad}
        assert validate_payload(p) == message
    p["hosts"][0]["hardware"] = {"cpu_name": "x", "extra": 1}
    assert validate_payload(p) == "$.hosts[0].hardware.extra: unknown field"
    inventory_only = {**base_payload(), "hosts": [{"agent_id": "001", "software": [{"name": "a"}]}]}
    assert validate_payload(inventory_only) is None
    bare = {**base_payload(), "hosts": [{"agent_id": "001"}]}
    assert validate_payload(bare) == (
        "$.hosts[0].findings: required (a host reports findings, configuration results, inventory or a combination)")
    p = base_payload()
    p["hosts"][0]["software"] = [{"name": "a"}] * 10001
    assert validate_payload(p) == "$.hosts[0].software: at most 10000 items"
    many = {**base_payload(), "hosts": [{"agent_id": f"{i:03d}", "software": [{"name": "a"}] * 10000} for i in range(21)]}
    assert validate_payload(many) == "$.hosts: at most 200000 software items in total"
    assert validate_payload({**many, "hosts": many["hosts"][:20]}) is None


# ------------------------------------------------------------------------------------------------ settings (P11-P12)

def test_p11_should_send_inventory_and_the_setting_parsing():
    assert should_send_inventory("true", []) is True
    assert should_send_inventory("false", ["whoami", "inventory"]) is False
    assert should_send_inventory("auto", ["whoami", "inventory"]) is True
    assert should_send_inventory("auto", ["whoami"]) is False
    assert should_send_inventory("auto", []) is False
    assert should_send_inventory("auto", None) is True  # a dry run has no server to ask

    def setting(value):
        env = dict(ENV) if value is None else {**ENV, "PBC_SEND_INVENTORY": value}
        return load_config(env, None, mode_override=None, dry_run=False, sample=False).send_inventory

    assert [setting(v) for v in (None, "", "auto", " AUTO ")] == ["auto"] * 4
    assert [setting(v) for v in ("true", "1", "yes", "on")] == ["true"] * 4
    assert [setting(v) for v in ("false", "0", "no", "OFF")] == ["false"] * 4
    with pytest.raises(ConfigError, match="PBC_SEND_INVENTORY must be auto, true or false"):
        setting("maybe")


def test_p12_whoami_features_is_a_list_and_every_failure_is_empty():
    def client(item):
        return IngestClient("https://grc.local", TOKEN, True, 60, session=FakeSession([item]))

    assert client((200, {"features": ["whoami", "inventory"]})).features() == ["whoami", "inventory"]
    assert client((200, {"features": ["whoami", 3, None]})).features() == ["whoami"]
    assert client((404, {"error": "not found"})).features() == []
    assert client((401, {"error": "bad token"})).features() == []
    assert client((200, {"features": "inventory"})).features() == []
    assert client((200, {})).features() == []
    assert client(requests.ConnectionError("boom")).features() == []
    session = FakeSession([(200, {"features": ["inventory"]})])
    IngestClient("https://grc.local", TOKEN, True, 60, session=session).features()
    assert session.calls[0]["url"] == "https://grc.local/api/v1/vm/whoami"
    assert session.calls[0]["headers"]["Authorization"] == f"Bearer {TOKEN}"


def test_p12b_a_400_about_hardware_or_software_names_the_setting():
    session = FakeSession([(400, {"error": "$.hosts[0].hardware: unknown field"})])
    with pytest.raises(RejectedError) as caught:
        IngestClient("https://grc.local", TOKEN, True, 60, session=session).post_payload(b"{}")
    assert INVENTORY_HINT in str(caught.value) and "PBC_SEND_INVENTORY=false" in str(caught.value)


# ------------------------------------------------------------------------------------------------ the run (P13-P15)

RAW = [{"agent_id": "001", "hostname": "inv-web-01",
        "rows": [{"vuln_id": "CVE-2024-0001", "severity": "High", "package_name": "openssl", "package_version": "3.0.1"}]}]


class FakeIngest:
    """Records what a run sends and answers whoami with the configured features."""

    features_list: list[str] = []
    sent: list[bytes] = []
    metas: list[dict] = []
    asked = 0

    def __init__(self, url, token, verify, timeout, **k):
        pass

    def features(self):
        type(self).asked += 1
        return list(type(self).features_list)

    def send_all(self, bodies, metas):
        type(self).sent.extend(bodies)
        type(self).metas.extend(metas)
        return []


@pytest.fixture
def ingest(monkeypatch):
    FakeIngest.features_list, FakeIngest.sent, FakeIngest.metas, FakeIngest.asked = [], [], [], 0
    monkeypatch.setattr(cli, "IngestClient", FakeIngest)
    monkeypatch.setattr(cli, "read_hosts", lambda cfg: RAW)
    return FakeIngest


def sent_payload():
    assert len(FakeIngest.sent) == 1
    return json.loads(FakeIngest.sent[0])


def test_p13_no_inventory_read_when_the_server_does_not_support_it(monkeypatch, ingest, caplog):
    ingest.features_list = ["whoami"]
    monkeypatch.setattr(cli, "read_inventory", lambda cfg: (_ for _ in ()).throw(AssertionError("inventory read")))
    with caplog.at_level(logging.INFO, logger="pbc_vm_exporter"):
        code, _, _ = run([], INDEXER_ENV)
    assert code == 0 and ingest.asked == 1
    host = sent_payload()["hosts"][0]
    assert "hardware" not in host and "software" not in host and "software" not in ingest.metas[0]
    assert "does not advertise host inventory" in caplog.text


def test_p13b_auto_with_support_true_and_false_and_api_mode(monkeypatch, ingest, caplog):
    monkeypatch.setattr(cli, "read_inventory", lambda cfg: group_inventory(fixture_docs()))
    ingest.features_list = ["whoami", "inventory"]
    assert run([], INDEXER_ENV)[0] == 0 and ingest.asked == 1
    payload = sent_payload()
    assert validate_payload(payload) is None
    assert sorted(h["agent_id"] for h in payload["hosts"]) == ["001", "002"]
    assert "findings" not in [h for h in payload["hosts"] if h["agent_id"] == "002"][0]
    assert ingest.metas[0]["software"] == 5 and ingest.metas[0]["findings"] == 1
    # false: never asks, never reads
    FakeIngest.sent.clear()
    monkeypatch.setattr(cli, "read_inventory", lambda cfg: (_ for _ in ()).throw(AssertionError("inventory read")))
    assert run([], {**INDEXER_ENV, "PBC_SEND_INVENTORY": "false"})[0] == 0 and ingest.asked == 1
    assert "hardware" not in sent_payload()["hosts"][0]
    # true: no whoami call (the operator decided), inventory read
    FakeIngest.sent.clear()
    monkeypatch.setattr(cli, "read_inventory", lambda cfg: group_inventory(fixture_docs()))
    assert run([], {**INDEXER_ENV, "PBC_SEND_INVENTORY": "true"})[0] == 0 and ingest.asked == 1
    assert "hardware" in sent_payload()["hosts"][0]
    # api mode: one info line, no inventory
    FakeIngest.sent.clear()
    with caplog.at_level(logging.INFO, logger="pbc_vm_exporter"):
        assert run([], {**ENV, "WAZUH_MODE": "api", "PBC_SEND_INVENTORY": "true"})[0] == 0
    assert "skipped in api mode" in caplog.text and "hardware" not in sent_payload()["hosts"][0]


def test_p14_a_failed_inventory_read_still_pushes_the_vulnerabilities(monkeypatch, ingest, caplog):
    ingest.features_list = ["whoami", "inventory"]

    def forbidden(cfg):
        raise WazuhReadError("indexer search returned HTTP 403")

    monkeypatch.setattr(cli, "read_inventory", forbidden)
    with caplog.at_level(logging.INFO, logger="pbc_vm_exporter"):
        code, out, err = run([], INDEXER_ENV)
    assert code == 0
    host = sent_payload()["hosts"][0]
    assert host["agent_id"] == "001" and len(host["findings"]) == 1 and "hardware" not in host
    assert "inventory could not be read" in caplog.text
    for name in NAMES + ("403",):
        assert name not in caplog.text and name not in err


def test_p14b_logging_of_a_successful_inventory_run_is_counts_only(monkeypatch, ingest, caplog):
    ingest.features_list = ["inventory"]
    monkeypatch.setattr(cli, "read_inventory", lambda cfg: group_inventory(fixture_docs()))
    with caplog.at_level(logging.DEBUG, logger="pbc_vm_exporter"):
        assert run([], INDEXER_ENV)[0] == 0
    assert "inventory: 2 host(s) with hardware, 2 host(s) with software (5 items), 1 inventory-only host(s)" in caplog.text
    for name in NAMES + ("001", "002"):
        assert name not in caplog.text


def test_p15_dry_run_sample_includes_the_inventory_unless_it_is_switched_off():
    code, out, _ = run(["--dry-run", "--sample"], {})
    assert code == 0
    doc = json.loads(out)
    hosts = [h for c in doc["chunks"] for h in c["payload"]["hosts"]]
    assert any("hardware" in h for h in hosts) and any("software" in h for h in hosts)
    assert [h["agent_id"] for h in hosts if "findings" not in h] == ["090"]
    assert doc["chunks"][0]["software"] == sum(len(h.get("software", [])) for h in hosts)
    for chunk in doc["chunks"]:
        assert validate_payload(chunk["payload"]) is None
    code, out, _ = run(["--dry-run", "--sample"], {"PBC_SEND_INVENTORY": "false"})
    hosts = [h for c in json.loads(out)["chunks"] for h in c["payload"]["hosts"]]
    assert code == 0 and not any("hardware" in h or "software" in h for h in hosts)
    assert all("findings" in h for h in hosts)


def test_p15b_the_dry_run_of_a_real_indexer_reads_the_inventory_without_asking_the_server(monkeypatch, ingest):
    monkeypatch.setattr(cli, "read_inventory", lambda cfg: group_inventory(fixture_docs()))
    code, out, _ = run(["--dry-run"], INDEXER_ENV)
    assert code == 0 and ingest.asked == 0
    assert any("hardware" in h for c in json.loads(out)["chunks"] for h in c["payload"]["hosts"])


# ------------------------------------------------------------------------------------------------ check

CHECK_WHOAMI = {
    "token": {"name": "wazuh-prod", "prefix": "pbcvm_AbCd", "expires_at": None},
    "scopes": ["vm:ingest"],
    "contract_sha256": __import__("hashlib").sha256(SERVER_SCHEMA.read_bytes()).hexdigest(),
    "limits": {"max_bytes": 33554432},
}


def check_session(monkeypatch, features, system_total=3):
    def handler(method, url, kwargs):
        if url.endswith("/api/v1/vm/whoami"):
            return 200, {**CHECK_WHOAMI, "features": features}
        if "/wazuh-states-inventory-system-*/_search" in url:
            return 200, {"hits": {"total": {"value": system_total, "relation": "eq"}, "hits": []}}
        if "/_search" in url:
            return 200, {"hits": {"total": {"value": 42, "relation": "eq"}, "hits": []}}
        raise AssertionError(f"unexpected request {method} {url}")

    session = FakeSession(handler=handler)
    monkeypatch.setattr(cli, "make_session", lambda *a, **k: session)
    return session


def test_p16_check_reports_inventory_support_and_the_inventory_indices(monkeypatch):
    check_session(monkeypatch, ["whoami", "inventory"])
    code, out, err = run(["check"], INDEXER_ENV)
    assert code == 0, out + err
    assert "[PASS] 4. PBC-GRC accepts inventory" in out
    assert "[PASS] 7. Wazuh inventory indices: 3 system documents" in out
    check_session(monkeypatch, ["whoami", "inventory"], system_total=0)
    code, out, _ = run(["check"], INDEXER_ENV)
    assert code == 0 and "[NOTE]" in out and "wazuh-states-inventory-system-* has 0 documents" in out
    check_session(monkeypatch, ["whoami"])
    code, out, _ = run(["check"], INDEXER_ENV)
    assert code == 0 and "[NOTE] 4. PBC-GRC accepts inventory: the server does not advertise it" in out
    assert "Wazuh inventory indices" not in out
    check_session(monkeypatch, ["whoami"])
    code, out, _ = run(["check"], {**INDEXER_ENV, "PBC_SEND_INVENTORY": "false"})
    assert code == 0 and "accepts inventory" not in out and "Wazuh inventory indices" not in out
