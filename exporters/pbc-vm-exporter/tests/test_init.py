import io
import os
import stat

import pytest

from conftest import TOKEN
from pbc_vm_exporter import init
from pbc_vm_exporter.cli import main
from pbc_vm_exporter.config import load_config, parse_env_file

PLAIN = ["https://grc.local/", "", "", "https://wazuh:9200", "reader", ""]
SECRETS = [TOKEN, "pw-secret!"]


def drive(monkeypatch, argv, plain=None, secrets=None):
    """Runs main() with scripted answers; returns (code, stdout, stderr)."""
    plain_it = iter(PLAIN if plain is None else plain)
    secret_it = iter(SECRETS if secrets is None else secrets)
    monkeypatch.setattr(init, "_ask", lambda prompt: next(plain_it))
    monkeypatch.setattr(init, "_ask_secret", lambda prompt: next(secret_it))
    monkeypatch.setattr(init, "_is_windows", lambda: False)
    out, err = io.StringIO(), io.StringIO()
    code = main(argv, environ={}, stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    code = main(argv, environ={}, stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


def test_writes_the_env_file(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p)])
    assert code == 0, err
    assert parse_env_file(str(p)) == {
        "PBC_URL": "https://grc.local", "PBC_SERVICE_TOKEN": TOKEN, "PBC_SOURCE_LABEL": "wazuh-prod",
        "WAZUH_MODE": "indexer", "WAZUH_INDEXER_URL": "https://wazuh:9200", "WAZUH_INDEXER_USER": "reader",
        "WAZUH_INDEXER_PASSWORD": "pw-secret!",
    }
    cfg = load_config({}, str(p), mode_override=None, dry_run=False, sample=False)
    assert cfg.wazuh_mode == "indexer"
    assert "\r" not in p.read_bytes().decode() and p.read_bytes().endswith(b"\n")
    assert "# WAZUH_MODE=auto would also need WAZUH_API_URL, WAZUH_API_USER and WAZUH_API_PASSWORD." in p.read_text()


def test_never_prints_a_secret(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p)])
    assert code == 0
    for text in (out, err):
        assert TOKEN not in text and "pw-secret!" not in text and "pbcvm_" not in text


def test_refuses_to_overwrite(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    p.write_text("KEEP=1\n")

    def boom(prompt):
        raise AssertionError("must not prompt")

    monkeypatch.setattr(init, "_ask", boom)
    monkeypatch.setattr(init, "_ask_secret", boom)
    out, err = io.StringIO(), io.StringIO()
    code = main(["init", "--env-file", str(p)], environ={}, stdout=out, stderr=err)
    assert code == 2
    assert "already exists" in err.getvalue()
    assert p.read_text() == "KEEP=1\n"


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")
def test_file_mode_is_0600(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    assert drive(monkeypatch, ["init", "--env-file", str(p)])[0] == 0
    assert stat.S_IMODE(p.stat().st_mode) == 0o600


def test_windows_warns_about_the_acl(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    plain_it, secret_it = iter(PLAIN), iter(SECRETS)
    monkeypatch.setattr(init, "_ask", lambda prompt: next(plain_it))
    monkeypatch.setattr(init, "_ask_secret", lambda prompt: next(secret_it))
    monkeypatch.setattr(init, "_is_windows", lambda: True)
    out, err = io.StringIO(), io.StringIO()
    code = main(["init", "--env-file", str(p)], environ={}, stdout=out, stderr=err)
    assert code == 0
    text = err.getvalue()
    assert "icacls" in text
    assert 'PowerShell:     icacls "' in text and '/grant:r "$($env:USERNAME):F"' in text
    assert "Command Prompt: icacls" in text and '"%USERNAME%:F"' in text


def test_takes_no_secret_on_argv():
    options = [o for a in init.build_init_parser()._actions for o in a.option_strings]
    assert options and not any(w in o for o in options for w in ("token", "password", "secret"))
    code, out, err = run(["init", "--token", TOKEN])
    assert code == 2
    assert TOKEN not in err and TOKEN not in out


def test_rejects_a_malformed_token_then_accepts(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p)], secrets=["pbcvm_short", TOKEN, "pw"])
    assert code == 0
    assert parse_env_file(str(p))["PBC_SERVICE_TOKEN"] == TOKEN
    assert "pbcvm_short" not in out + err


def test_empty_token_writes_an_empty_line(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p)], secrets=["", "pw"])
    assert code == 0
    assert "PBC_SERVICE_TOKEN=\n" in p.read_text()


@pytest.mark.parametrize("password", [" sp'ace ", "'quoted'", '"dq"'])
def test_values_round_trip(monkeypatch, tmp_path, password):
    p = tmp_path / "x.env"
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p)], secrets=[TOKEN, password])
    assert code == 0
    assert parse_env_file(str(p))["WAZUH_INDEXER_PASSWORD"] == password


def test_eof_writes_nothing(monkeypatch, tmp_path):
    p = tmp_path / "x.env"

    def eof(prompt):
        raise EOFError

    monkeypatch.setattr(init, "_ask", eof)
    monkeypatch.setattr(init, "_ask_secret", eof)
    out, err = io.StringIO(), io.StringIO()
    code = main(["init", "--env-file", str(p)], environ={}, stdout=out, stderr=err)
    assert code == 2
    assert not p.exists()


def test_refuses_an_http_url(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p)], plain=["http://grc.local", "n"] * 3)
    assert code == 2
    assert not p.exists()
    assert "PBC_URL: too many invalid answers" in err


def test_http_yes_writes_both_lines(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    plain = ["http://grc.local", "y", "", "", "https://wazuh:9200", "reader", ""]
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p)], plain=plain)
    assert code == 0, err
    values = parse_env_file(str(p))
    assert values["PBC_URL"] == "http://grc.local"
    assert values["PBC_ALLOW_INSECURE_TRANSPORT"] == "true"
    lines = p.read_text().splitlines()
    at = lines.index("PBC_URL=http://grc.local")
    assert lines[at + 1].startswith("# Development only: allows the plain http PBC_URL above")
    assert lines[at + 2] == "PBC_ALLOW_INSECURE_TRANSPORT=true"
    cfg = load_config({}, str(p), mode_override=None, dry_run=False, sample=False)
    assert cfg.allow_insecure is True
    assert "VM_ALLOW_INSECURE_TOKENS=true" in out


@pytest.mark.parametrize("answer", ["n", ""])
def test_http_no_reasks(monkeypatch, tmp_path, answer):
    p = tmp_path / "x.env"
    plain = ["http://grc.local", answer, "https://grc.local", "", "", "https://wazuh:9200", "reader", ""]
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p)], plain=plain)
    assert code == 0, err
    assert "PBC_URL: enter an https URL" in err
    assert parse_env_file(str(p))["PBC_URL"] == "https://grc.local"
    assert "PBC_ALLOW_INSECURE_TRANSPORT" not in p.read_text()
    assert "VM_ALLOW_INSECURE_TOKENS" not in out


def test_http_enter_is_no(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    plain = ["http://grc.local", "", "https://grc.local", "", "", "https://wazuh:9200", "reader", ""]
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p)], plain=plain)
    assert code == 0, err
    assert "PBC_ALLOW_INSECURE_TRANSPORT" not in p.read_text()


def test_https_never_asks_to_confirm(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    asked = []
    plain_it = iter(PLAIN)

    def ask(prompt):
        asked.append(prompt)
        return next(plain_it)

    secret_it = iter(SECRETS)
    monkeypatch.setattr(init, "_ask", ask)
    monkeypatch.setattr(init, "_ask_secret", lambda prompt: next(secret_it))
    monkeypatch.setattr(init, "_is_windows", lambda: False)
    out, err = io.StringIO(), io.StringIO()
    assert main(["init", "--env-file", str(p)], environ={}, stdout=out, stderr=err) == 0
    assert asked and not any("Allow it?" in a for a in asked)


def test_http_with_credentials_refused_without_confirm(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    asked = []
    plain_it = iter(["http://u:p@grc.local"] * 3)

    def ask(prompt):
        asked.append(prompt)
        return next(plain_it)

    monkeypatch.setattr(init, "_ask", ask)
    monkeypatch.setattr(init, "_ask_secret", lambda prompt: "x")
    out, err = io.StringIO(), io.StringIO()
    code = main(["init", "--env-file", str(p)], environ={}, stdout=out, stderr=err)
    assert code == 2 and not p.exists()
    assert "must not contain credentials" in err.getvalue()
    assert not any("Allow it?" in a for a in asked)
    assert "u:p" not in err.getvalue() + out.getvalue()


def test_wazuh_url_stays_https_only(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    plain = ["https://grc.local", "", "", "http://wazuh:9200", "http://wazuh:9200", "http://wazuh:9200"]
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p)], plain=plain)
    assert code == 2 and not p.exists()
    assert "must use https" in err


def test_api_mode(monkeypatch, tmp_path):
    p = tmp_path / "x.env"
    plain = ["https://grc.local", "", "", "https://mgr:55000", "api-user", ""]
    code, out, err = drive(monkeypatch, ["init", "--env-file", str(p), "--mode", "api"], plain=plain)
    assert code == 0, err
    text = p.read_text()
    assert "WAZUH_MODE=api\n" in text and "WAZUH_API_URL=https://mgr:55000\n" in text
    assert "WAZUH_INDEXER_URL=" not in text
    assert parse_env_file(str(p))["WAZUH_API_PASSWORD"] == "pw-secret!"


def test_positional_is_refused():
    code, out, err = run(["init", "bogus"])
    assert code == 2
    assert "positional" in err


def test_code_default_mode_stays_auto():
    cfg = load_config(
        {"PBC_URL": "https://grc.local", "PBC_SERVICE_TOKEN": TOKEN, "PBC_SOURCE_LABEL": "x"},
        None, mode_override=None, dry_run=False, sample=False,
    )
    assert cfg.wazuh_mode == "auto"
