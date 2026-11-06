import hashlib
import io
import json
import subprocess
import sys

import pytest

from conftest import EXPORTER_DIR, FIXTURES, SERVER_SCHEMA, TOKEN
from pbc_vm_exporter import cli
from pbc_vm_exporter.adapter import encode_payload
from pbc_vm_exporter.cli import build_parser, main
from pbc_vm_exporter.errors import RejectedError, TransportError, WazuhReadError
from pbc_vm_exporter.validate import validate_payload

ENV = {"PBC_URL": "https://grc.local", "PBC_SERVICE_TOKEN": TOKEN, "PBC_SOURCE_LABEL": "wazuh-prod", "WAZUH_MODE": "indexer"}


def run(argv, environ=None):
    out, err = io.StringIO(), io.StringIO()
    code = main(argv, environ={} if environ is None else environ, stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


RAW = [{
    "agent_id": "001", "hostname": "web-01",
    "rows": [{"vuln_id": "CVE-2024-0001", "severity": "High", "package_name": "openssl", "package_version": "3.0.1"}],
}]


# ------------------------------------------------------------------------------------------------ dry run and sample

def test_dry_run_sample_prints_valid_chunks():
    code, out, _ = run(["--dry-run", "--sample"])
    assert code == 0
    doc = json.loads(out)
    assert doc["chunks"]
    for chunk in doc["chunks"]:
        assert validate_payload(chunk["payload"]) is None
        assert hashlib.sha256(encode_payload(chunk["payload"])).hexdigest() == chunk["sha256"]
        assert chunk["bytes"] == len(encode_payload(chunk["payload"]))
    assert doc["contract_sha256"] == hashlib.sha256(SERVER_SCHEMA.read_bytes()).hexdigest()
    assert doc["dropped_rows"] == 1 and doc["skipped_hosts"] == []


def test_print_contract_sha256():
    code, out, _ = run(["--print-contract-sha256"])
    assert code == 0 and out.strip() == hashlib.sha256(SERVER_SCHEMA.read_bytes()).hexdigest()


def test_sample_requires_dry_run():
    code, _, err = run(["--sample"])
    assert code == 2 and "--dry-run" in err


# ------------------------------------------------------------------------------------------------ config errors

def test_missing_token_is_exit_2_without_a_traceback():
    code, _, err = run([], {"PBC_URL": "https://g", "PBC_SOURCE_LABEL": "x"})
    assert code == 2 and "Traceback" not in err and "PBC_SERVICE_TOKEN" in err


def test_missing_label_is_exit_2():
    code, _, err = run([], {"PBC_URL": "https://g", "PBC_SERVICE_TOKEN": TOKEN})
    assert code == 2 and "PBC_SOURCE_LABEL" in err


def test_bad_mode_and_missing_env_file():
    assert run(["--mode", "bogus"])[0] == 2
    assert run(["--env-file", "nope.env"])[0] == 2


# ------------------------------------------------------------------------------------------------ no token on the command line

def test_no_option_accepts_a_secret():
    for action in build_parser()._actions:
        for option in action.option_strings:
            assert not any(word in option.lower() for word in ("token", "password", "secret")), option


def test_token_flag_is_refused_and_never_echoed():
    code, out, err = run(["--token", TOKEN])
    assert code == 2
    assert TOKEN not in err and TOKEN not in out and "pbcvm_" not in err
    code, _, err = run([f"--token={TOKEN}"])
    assert code == 2 and TOKEN not in err


# ------------------------------------------------------------------------------------------------ exit codes

def test_reader_failure_is_exit_3(monkeypatch):
    def boom(cfg):
        raise WazuhReadError("indexer search returned HTTP 401")
    monkeypatch.setattr(cli, "read_hosts", boom)
    assert run([], ENV)[0] == 3


def test_zero_hosts_is_exit_3_and_posts_nothing(monkeypatch):
    monkeypatch.setattr(cli, "read_hosts", lambda cfg: [])

    class NoClient:
        def __init__(self, *a, **k):
            raise AssertionError("must not construct a client")

    monkeypatch.setattr(cli, "IngestClient", NoClient)
    code, _, err = run([], ENV)
    assert code == 3 and "zero hosts" in err


def test_invalid_payload_is_exit_4_and_posts_nothing(monkeypatch):
    posts = []
    monkeypatch.setattr(cli, "read_hosts", lambda cfg: RAW)
    real = cli.build_payloads

    def bad(*a, **k):
        payloads, stats = real(*a, **k)
        payloads[0]["hosts"][0]["findings"][0]["severity"] = "SEVERE"
        return payloads, stats

    class Recorder:
        def __init__(self, *a, **k):
            pass

        def send_all(self, bodies, metas):
            posts.append(bodies)

    monkeypatch.setattr(cli, "build_payloads", bad)
    monkeypatch.setattr(cli, "IngestClient", Recorder)
    code, _, err = run([], ENV)
    assert code == 4 and posts == [] and "severity" in err


@pytest.mark.parametrize("error,code", [(RejectedError("rejected"), 5), (TransportError("transport"), 6)])
def test_client_errors_map_to_exit_codes(monkeypatch, error, code):
    monkeypatch.setattr(cli, "read_hosts", lambda cfg: RAW)

    class Failing:
        def __init__(self, *a, **k):
            pass

        def send_all(self, bodies, metas):
            raise error

    monkeypatch.setattr(cli, "IngestClient", Failing)
    assert run([], ENV)[0] == code


def test_success_is_exit_0_and_sends_the_validated_bytes(monkeypatch):
    sent = []
    monkeypatch.setattr(cli, "read_hosts", lambda cfg: RAW)

    class Ok:
        def __init__(self, url, token, verify, timeout, **k):
            assert url == "https://grc.local" and token == TOKEN

        def send_all(self, bodies, metas):
            sent.extend(bodies)
            return []

    monkeypatch.setattr(cli, "IngestClient", Ok)
    assert run([], ENV)[0] == 0
    assert len(sent) == 1 and validate_payload(json.loads(sent[0])) is None


def test_partial_export_is_exit_7_and_names_the_skipped_agents(monkeypatch):
    big = {"agent_id": "999", "rows": [
        {"vuln_id": f"CVE-2024-{i:04d}", "severity": "Low"} for i in range(1, 5002)
    ]}
    monkeypatch.setattr(cli, "read_hosts", lambda cfg: RAW + [big])
    monkeypatch.setattr(cli, "IngestClient", lambda *a, **k: type("C", (), {"send_all": lambda self, b, m: []})())
    code, _, err = run([], ENV)
    assert code == 7 and "999" in err


def test_unexpected_error_is_exit_1_one_line(monkeypatch):
    def boom(cfg):
        raise RuntimeError(f"surprise {TOKEN}\nsecond line")
    monkeypatch.setattr(cli, "read_hosts", boom)
    code, _, err = run([], ENV)
    assert code == 1 and TOKEN not in err and "Traceback" not in err


def test_keyboard_interrupt_is_exit_130(monkeypatch):
    def boom(cfg):
        raise KeyboardInterrupt
    monkeypatch.setattr(cli, "read_hosts", boom)
    assert run([], ENV)[0] == 130


def test_dry_run_with_a_real_label_never_posts(monkeypatch):
    monkeypatch.setattr(cli, "read_hosts", lambda cfg: RAW)
    monkeypatch.setattr(cli, "IngestClient", lambda *a, **k: (_ for _ in ()).throw(AssertionError("posted")))
    code, out, _ = run(["--dry-run"], {k: v for k, v in ENV.items() if k != "PBC_SERVICE_TOKEN"})
    assert code == 0 and json.loads(out)["chunks"][0]["payload"]["source"]["label"] == "wazuh-prod"


# ------------------------------------------------------------------------------------------------ process level

def test_module_runs_as_a_process():
    result = subprocess.run(
        [sys.executable, "-m", "pbc_vm_exporter", "--dry-run", "--sample"],
        cwd=str(EXPORTER_DIR), capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["chunks"]


# ------------------------------------------------------------------------------------------------ xccdf source

X1 = str(FIXTURES / "xccdf12_results.xml")
SCAP_ENV = {"PBC_SOURCE_LABEL": "scap-test"}


def test_xccdf_dry_run_prints_a_scap_payload_and_no_names_on_stderr():
    code, out, err = run(["--dry-run", "--source", "xccdf", "--input", X1], SCAP_ENV)
    assert code == 0
    doc = json.loads(out)
    (chunk,) = doc["chunks"]
    assert chunk["payload"]["source"] == {"kind": "SCAP", "label": "scap-test"}
    assert validate_payload(chunk["payload"]) is None and chunk["results"] == 4 and chunk["findings"] == 0
    assert hashlib.sha256(encode_payload(chunk["payload"])).hexdigest() == chunk["sha256"]
    for needle in ("cfg-host-01", "192.0.2.10", "xccdf-", "xccdf12_results"):
        assert needle not in err
    assert "input 1" in err


def test_xccdf_sample_dry_run():
    code, out, _ = run(["--dry-run", "--sample", "--source", "xccdf"])
    assert code == 0
    payload = json.loads(out)["chunks"][0]["payload"]
    assert payload["source"]["kind"] == "SCAP" and payload["source"]["label"] == "sample-scap"
    assert validate_payload(payload) is None


def test_xccdf_not_xccdf_is_exit_3():
    code, _, err = run(["--dry-run", "--source", "xccdf", "--input", str(FIXTURES / "not_xccdf.xml")], SCAP_ENV)
    assert code == 3 and "nothing was sent" in err and "not_xccdf" not in err


def test_xccdf_doctype_is_exit_3_without_the_path():
    code, _, err = run(["--dry-run", "--source", "xccdf", "--input", str(FIXTURES / "doctype.xml")], SCAP_ENV)
    assert code == 3 and "input 1" in err and "doctype.xml" not in err


def test_xccdf_sample_without_dry_run_is_exit_2():
    code, _, err = run(["--sample", "--source", "xccdf"])
    assert code == 2 and "--dry-run" in err


def test_xccdf_usage_errors():
    assert run(["--dry-run", "--source", "xccdf"], SCAP_ENV)[0] == 2
    assert run(["--dry-run", "--sample", "--source", "xccdf", "--input", X1])[0] == 2
    assert run(["--dry-run", "--input", X1], SCAP_ENV)[0] == 2


def test_xccdf_posts_the_validated_bytes_and_logs_no_names(monkeypatch):
    sent = []

    class Ok:
        def __init__(self, url, token, verify, timeout, **k):
            pass

        def send_all(self, bodies, metas):
            sent.extend(bodies)
            return []

    monkeypatch.setattr(cli, "IngestClient", Ok)
    code, _, err = run(["--source", "xccdf", "--input", X1], {**ENV, **SCAP_ENV})
    assert code == 0 and len(sent) == 1 and validate_payload(json.loads(sent[0])) is None
    assert "cfg-host-01" not in err


def test_xccdf_sample_process_dry_run():
    result = subprocess.run(
        [sys.executable, "-m", "pbc_vm_exporter", "--dry-run", "--sample", "--source", "xccdf"],
        cwd=str(EXPORTER_DIR), capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["chunks"][0]["payload"]["source"]["kind"] == "SCAP"


# ------------------------------------------------------------------------------------------------ vendor sources

from pbc_vm_exporter.action1 import group_action1, load_action1_sample  # noqa: E402
from pbc_vm_exporter.adapter import build_hosts  # noqa: E402
from pbc_vm_exporter.errors import Action1ReadError, SentinelOneReadError  # noqa: E402
from pbc_vm_exporter.sentinelone import group_sentinelone, load_sentinelone_sample  # noqa: E402

A1_ENV = {
    "PBC_SOURCE_LABEL": "a1-test", "ACTION1_BASE_URL": "https://app.example/api/3.0", "ACTION1_CLIENT_ID": "client-1",
    "ACTION1_CLIENT_SECRET": "client-secret-" + "z" * 20, "ACTION1_ORG_ID": "org-1",
}
S1_ENV = {
    "PBC_SOURCE_LABEL": "s1-test", "S1_CONSOLE_URL": "https://console.example", "S1_API_TOKEN": "s1-token-" + "x" * 30,
    "S1_SITE_IDS": "111",
}


def sample_hosts(source):
    if source == "action1":
        return build_hosts(group_action1(load_action1_sample(cli.ACTION1_SAMPLE_PATH)))[0]
    return build_hosts(group_sentinelone(*load_sentinelone_sample(cli.SENTINELONE_SAMPLE_PATH)))[0]


@pytest.mark.parametrize("source,kind", [("action1", "ACTION1"), ("sentinelone", "SENTINELONE")])
def test_vendor_sample_dry_run(source, kind):
    code, out, err = run(["--dry-run", "--sample", "--source", source])
    assert code == 0
    doc = json.loads(out)
    expected = sample_hosts(source)
    assert doc["skipped_hosts"] == 0
    total = 0
    for chunk in doc["chunks"]:
        assert validate_payload(chunk["payload"]) is None
        assert chunk["payload"]["source"] == {"kind": kind, "label": f"sample-{source}"}
        assert hashlib.sha256(encode_payload(chunk["payload"])).hexdigest() == chunk["sha256"]
        total += chunk["findings"]
    assert total == sum(len(h["findings"]) for h in expected) and total > 0
    for host in expected:
        assert host["hostname"] not in err and host["agent_id"] not in err


@pytest.mark.parametrize("source", ["action1", "sentinelone"])
def test_vendor_usage_errors(source):
    code, _, err = run(["--sample", "--source", source])
    assert code == 2 and "--dry-run" in err
    code, _, err = run(["--dry-run", "--sample", "--source", source, "--input", "x.xml"])
    assert code == 2 and "--input" in err
    code, _, err = run(["--dry-run", "--sample", "--source", source, "--mode", "api"])
    assert code == 2 and "--mode applies to --source wazuh only" in err


def test_action1_read_error_is_exit_3(monkeypatch):
    def boom(cfg):
        raise Action1ReadError("action1 authentication returned HTTP 401")
    monkeypatch.setattr(cli, "read_action1_hosts", boom)
    code, _, err = run(["--source", "action1"], {**A1_ENV, "PBC_URL": "https://grc.local", "PBC_SERVICE_TOKEN": TOKEN})
    assert code == 3 and "HTTP 401" in err and A1_ENV["ACTION1_CLIENT_SECRET"] not in err


def test_sentinelone_zero_hosts_is_exit_3_and_posts_nothing(monkeypatch):
    monkeypatch.setattr(cli, "read_sentinelone_hosts", lambda cfg: [])
    monkeypatch.setattr(cli, "IngestClient", lambda *a, **k: (_ for _ in ()).throw(AssertionError("posted")))
    code, _, err = run(["--source", "sentinelone"], {**S1_ENV, "PBC_URL": "https://grc.local", "PBC_SERVICE_TOKEN": TOKEN})
    assert code == 3 and "zero hosts" in err


def test_sentinelone_missing_variable_is_exit_2():
    code, _, err = run(["--dry-run", "--source", "sentinelone"], {"PBC_SOURCE_LABEL": "s1-test"})
    assert code == 2 and "S1_CONSOLE_URL" in err


def test_vendor_dry_run_with_real_hosts_uses_the_configured_label(monkeypatch):
    monkeypatch.setattr(cli, "read_action1_hosts", lambda cfg: RAW)
    code, out, _ = run(["--dry-run", "--source", "action1"], A1_ENV)
    payload = json.loads(out)["chunks"][0]["payload"]
    assert code == 0 and payload["source"] == {"kind": "ACTION1", "label": "a1-test"}


def test_sentinelone_partial_export_is_exit_7_and_names_a_count_only(monkeypatch):
    big = {"agent_id": "agent-secret-id", "rows": [
        {"vuln_id": f"CVE-2024-{i:04d}", "severity": "Low"} for i in range(1, 5002)
    ]}
    monkeypatch.setattr(cli, "read_sentinelone_hosts", lambda cfg: RAW + [big])
    sent = []
    monkeypatch.setattr(
        cli, "IngestClient", lambda *a, **k: type("C", (), {"send_all": lambda self, b, m: sent.extend(b) or []})()
    )
    code, _, err = run(["--source", "sentinelone"], {**S1_ENV, "PBC_URL": "https://grc.local", "PBC_SERVICE_TOKEN": TOKEN})
    assert code == 7 and "1 host(s) skipped" in err and "agent-secret-id" not in err
    assert json.loads(sent[0])["source"]["kind"] == "SENTINELONE"


def test_sentinelone_read_error_is_exit_3(monkeypatch):
    def boom(cfg):
        raise SentinelOneReadError("sentinelone agents returned HTTP 500")
    monkeypatch.setattr(cli, "read_sentinelone_hosts", boom)
    assert run(["--dry-run", "--source", "sentinelone"], S1_ENV)[0] == 3


@pytest.mark.parametrize("source", ["action1", "sentinelone"])
def test_vendor_sample_process_dry_run(source):
    result = subprocess.run(
        [sys.executable, "-m", "pbc_vm_exporter", "--dry-run", "--sample", "--source", source],
        cwd=str(EXPORTER_DIR), capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["chunks"][0]["payload"]["source"]["kind"] == source.upper()


# ------------------------------------------------------------------------------------------------ --version and check

def test_version_flag(capsys):
    from pbc_vm_exporter import __version__
    code, _, _ = run(["--version"])
    assert code == 0
    assert capsys.readouterr().out.strip() == f"pbc-vm-exporter {__version__}"


def test_positional_arguments_are_still_refused():
    code, _, err = run(["bogus"])
    assert code == 2 and "positional" in err
    code, _, err = run(["check", "bogus"])
    assert code == 2 and "positional" in err


CHECK_ENV = {**ENV, "WAZUH_INDEXER_URL": "https://wazuh:9200", "WAZUH_INDEXER_USER": "reader", "WAZUH_INDEXER_PASSWORD": "pw-secret!"}
WHOAMI = {
    "token": {"name": "wazuh-prod", "prefix": "pbcvm_AbCd", "expires_at": None},
    "scopes": ["vm:ingest"],
    "contract_sha256": hashlib.sha256(SERVER_SCHEMA.read_bytes()).hexdigest(),
    "limits": {"max_bytes": 33554432},
    "features": ["whoami"],
}
INDEXER_OK = {"hits": {"total": {"value": 42, "relation": "eq"}, "hits": []}}


def fake_check_session(monkeypatch, whoami=(200, WHOAMI), indexer=(200, INDEXER_OK)):
    from conftest import FakeSession

    def handler(method, url, kwargs):
        if url.endswith("/api/v1/vm/whoami"):
            return whoami
        if "/_search" in url:
            return indexer
        raise AssertionError(f"unexpected request {method} {url}")

    session = FakeSession(handler=handler)
    monkeypatch.setattr(cli, "make_session", lambda *a, **k: session)
    return session


def test_check_all_green_is_exit_0_and_never_prints_the_token(monkeypatch):
    session = fake_check_session(monkeypatch)
    code, out, err = run(["check"], CHECK_ENV)
    assert code == 0, out + err
    assert "[PASS] 1. configuration loads" in out and "42 documents" in out and "wazuh-prod" in out
    assert "[FAIL]" not in out and "0 failed" in out
    assert TOKEN not in out and TOKEN not in err and "pw-secret!" not in out
    assert session.calls[0]["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert [c["method"] for c in session.calls] == ["GET", "POST"]


def test_check_whoami_401_is_a_failure(monkeypatch):
    fake_check_session(monkeypatch, whoami=(401, {"error": "Invalid or expired service token"}))
    code, out, _ = run(["check"], CHECK_ENV)
    assert code == 5
    assert "[FAIL]" in out and "hint:" in out and "revoked" in out


def test_check_insecure_transport_is_explained(monkeypatch):
    fake_check_session(monkeypatch, whoami=(403, {"error": "requires HTTPS", "code": "vm_insecure_transport"}))
    code, out, _ = run(["check"], CHECK_ENV)
    assert code == 5 and "TRUST_PROXY" in out


def test_check_whoami_404_is_skipped_not_failed(monkeypatch):
    fake_check_session(monkeypatch, whoami=(404, {"error": "not found"}))
    code, out, _ = run(["check"], CHECK_ENV)
    assert code == 0, out
    assert "[SKIP]" in out and "server too old for check" in out


def test_check_contract_mismatch_is_exit_4(monkeypatch):
    fake_check_session(monkeypatch, whoami=(200, {**WHOAMI, "contract_sha256": "0" * 64}))
    code, out, _ = run(["check"], CHECK_ENV)
    assert code == 4 and "contract" in out


def test_check_size_limit_is_compared(monkeypatch):
    fake_check_session(monkeypatch, whoami=(200, {**WHOAMI, "limits": {"max_bytes": 1048576}}))
    code, out, _ = run(["check"], {**CHECK_ENV, "EXPORT_MAX_BYTES": "2097152"})
    assert code == 5 and "EXPORT_MAX_BYTES" in out


def test_check_indexer_401_carries_the_hint(monkeypatch):
    fake_check_session(monkeypatch, indexer=(401, {}))
    code, out, _ = run(["check"], CHECK_ENV)
    assert code == 3 and "internal users" in out and "pw-secret!" not in out


def test_check_indexer_unreachable_is_exit_3(monkeypatch):
    import requests
    fake_check_session(monkeypatch, indexer=requests.ConnectionError("Connection refused"))
    code, out, _ = run(["check"], CHECK_ENV)
    assert code == 3 and "network.host" in out


def test_check_auto_mode_without_manager_settings_says_use_indexer_mode(monkeypatch):
    fake_check_session(monkeypatch)
    code, out, _ = run(["check"], {**CHECK_ENV, "WAZUH_MODE": "auto"})
    assert code == 2 and "WAZUH_MODE=indexer" in out


def test_check_config_error_is_exit_2():
    code, out, _ = run(["check"], {"PBC_URL": "https://g"})
    assert code == 2 and "[FAIL]" in out and "PBC_SERVICE_TOKEN" in out


def test_check_notes_an_unneeded_insecure_flag(monkeypatch):
    fake_check_session(monkeypatch)
    code, out, _ = run(["check"], {**CHECK_ENV, "PBC_ALLOW_INSECURE_TRANSPORT": "true"})
    assert code == 0 and "[NOTE]" in out and "not needed" in out


def test_insecure_warning_only_when_a_url_is_plain_http(caplog):
    import logging
    from pbc_vm_exporter.config import load_config
    base = {**ENV, "PBC_ALLOW_INSECURE_TRANSPORT": "true"}
    with caplog.at_level(logging.WARNING):
        load_config(base, None, mode_override=None, dry_run=False, sample=False)
    assert not any("PBC_ALLOW_INSECURE_TRANSPORT" in r.getMessage() for r in caplog.records)
    with caplog.at_level(logging.WARNING):
        load_config({**base, "PBC_URL": "http://grc.local"}, None, mode_override=None, dry_run=False, sample=False)
    assert any("PBC_ALLOW_INSECURE_TRANSPORT" in r.getMessage() for r in caplog.records)
