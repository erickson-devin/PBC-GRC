import hashlib
import io
import json
import subprocess
import sys

import pytest

from conftest import EXPORTER_DIR, SERVER_SCHEMA, TOKEN
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
