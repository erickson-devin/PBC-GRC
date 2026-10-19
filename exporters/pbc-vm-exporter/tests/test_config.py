import logging
import os

import pytest

from conftest import TOKEN
from pbc_vm_exporter.config import is_truthy, load_config, parse_env_file, redact
from pbc_vm_exporter.errors import ConfigError

BASE = {"PBC_URL": "https://grc.local", "PBC_SERVICE_TOKEN": TOKEN, "PBC_SOURCE_LABEL": "wazuh-prod"}


def load(env=None, *, env_file=None, mode=None, dry_run=False, sample=False, base=True):
    merged = {**(BASE if base else {}), **(env or {})}
    return load_config(merged, env_file, mode_override=mode, dry_run=dry_run, sample=sample)


def write(tmp_path, text, name="exporter.env"):
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return str(path)


# ------------------------------------------------------------------------------------------------ file parsing

def test_env_file_parsing(tmp_path):
    path = write(
        tmp_path,
        f'PBC_URL=https://grc.local\n# a comment\n\nPBC_SERVICE_TOKEN="{TOKEN}"\nexport WAZUH_MODE=api\nPBC_SOURCE_LABEL=wazuh-prod\n',
    )
    values = parse_env_file(path)
    assert values["PBC_SERVICE_TOKEN"] == TOKEN
    cfg = load_config({}, path, mode_override=None, dry_run=False, sample=False)
    assert cfg.pbc_url == "https://grc.local" and cfg.wazuh_mode == "api" and cfg.pbc_token == TOKEN


def test_hash_inside_a_value_survives(tmp_path):
    assert parse_env_file(write(tmp_path, "WAZUH_API_PASSWORD=pa#ss\n"))["WAZUH_API_PASSWORD"] == "pa#ss"


def test_malformed_line_is_reported_without_its_content(tmp_path):
    path = write(tmp_path, "A=1\nB=2\nNOEQUALS\n")
    with pytest.raises(ConfigError) as info:
        parse_env_file(path)
    assert "line 3" in str(info.value) and "NOEQUALS" not in str(info.value)


def test_environment_wins_over_the_file(tmp_path):
    path = write(tmp_path, "PBC_URL=https://a\n")
    cfg = load({"PBC_URL": "https://b"}, env_file=path)
    assert cfg.pbc_url == "https://b"


def test_file_value_used_when_environment_lacks_it(tmp_path):
    path = write(tmp_path, "PBC_URL=https://a\n")
    cfg = load_config(
        {"PBC_SERVICE_TOKEN": TOKEN, "PBC_SOURCE_LABEL": "x"}, path, mode_override=None, dry_run=False, sample=False
    )
    assert cfg.pbc_url == "https://a"


def test_mode_override_beats_environment():
    assert load({"WAZUH_MODE": "api"}, mode="indexer").wazuh_mode == "indexer"
    assert load({"WAZUH_MODE": "api"}).wazuh_mode == "api"
    assert load().wazuh_mode == "auto"


def test_bogus_mode_rejected():
    with pytest.raises(ConfigError):
        load({"WAZUH_MODE": "bogus"})


# ------------------------------------------------------------------------------------------------ token and label

def test_token_required_unless_dry_run():
    with pytest.raises(ConfigError):
        load({"PBC_SERVICE_TOKEN": ""})
    assert load({"PBC_SERVICE_TOKEN": ""}, dry_run=True).pbc_token is None


def test_short_token_rejected_and_not_echoed():
    with pytest.raises(ConfigError) as info:
        load({"PBC_SERVICE_TOKEN": "pbcvm_short"})
    assert "pbcvm_short" not in str(info.value)


def test_label_required_outside_sample():
    env = {"PBC_SOURCE_LABEL": ""}
    with pytest.raises(ConfigError):
        load(env)
    with pytest.raises(ConfigError):
        load(env, dry_run=True)
    assert load(env, dry_run=True, sample=True).source_label is None


@pytest.mark.parametrize("label", ["a\nb", "x" * 129])
def test_bad_labels_rejected(label):
    with pytest.raises(ConfigError):
        load({"PBC_SOURCE_LABEL": label})


# ------------------------------------------------------------------------------------------------ transport and TLS

def test_plain_http_refused_unless_overridden(caplog):
    with pytest.raises(ConfigError):
        load({"PBC_URL": "http://grc.local"})
    with caplog.at_level(logging.WARNING):
        cfg = load({"PBC_URL": "http://grc.local", "PBC_ALLOW_INSECURE_TRANSPORT": "TRUE "})
    assert cfg.pbc_url == "http://grc.local"
    assert any("PBC_ALLOW_INSECURE_TRANSPORT" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("value,expected", [("1", True), ("yes", True), ("on", True), ("false", False), ("", False), ("nah", False)])
def test_is_truthy(value, expected):
    assert is_truthy(value) is expected


def test_indexer_url_needs_https():
    with pytest.raises(ConfigError):
        load({"WAZUH_INDEXER_URL": "http://wazuh:9200"})


def test_url_with_credentials_refused_and_not_echoed():
    with pytest.raises(ConfigError) as info:
        load({"PBC_URL": "https://u:p@grc"})
    assert "u:p" not in str(info.value)


def test_other_schemes_and_query_refused():
    with pytest.raises(ConfigError):
        load({"PBC_URL": "ftp://grc"})
    with pytest.raises(ConfigError):
        load({"PBC_URL": "https://grc/?a=1"})


@pytest.mark.parametrize("var,attr", [("PBC_CA_BUNDLE", "pbc_verify"), ("WAZUH_CA_BUNDLE", "wazuh_verify")])
def test_ca_bundles(tmp_path, var, attr):
    ca = tmp_path / "ca.pem"
    ca.write_text("x")
    assert getattr(load({var: str(ca)}), attr) == str(ca)
    with pytest.raises(ConfigError):
        load({var: str(tmp_path / "missing.pem")})
    assert getattr(load(), attr) is True


# ------------------------------------------------------------------------------------------------ numbers

@pytest.mark.parametrize(
    "var,attr,cases",
    [
        ("EXPORT_MAX_HOSTS_PER_REQUEST", "max_hosts",
         [(None, 500), ("200", 200), ("0", 500), ("5000", 1000), ("abc", 500), ("-5", 500)]),
        ("EXPORT_TIMEOUT_SECONDS", "timeout", [(None, 60), ("1", 5), ("9999", 600), ("x", 60)]),
        ("EXPORT_MAX_BYTES", "max_bytes", [(None, 33554432), ("209715200", 104857600)]),
        ("EXPORT_MAX_FINDINGS_PER_REQUEST", "max_findings", [(None, 50000), ("999999", 50000), ("100", 100)]),
    ],
)
def test_numeric_settings(var, attr, cases):
    for raw, expected in cases:
        env = {} if raw is None else {var: raw}
        assert getattr(load(env), attr) == expected, (var, raw)


def test_indexer_index_default_and_validation():
    assert load().indexer_index == "wazuh-states-vulnerabilities-*"
    with pytest.raises(ConfigError):
        load({"WAZUH_INDEXER_INDEX": "bad index/../x"})


# ------------------------------------------------------------------------------------------------ secrets and permissions

def test_repr_hides_secrets():
    cfg = load({"WAZUH_API_PASSWORD": "S3cret!api", "WAZUH_INDEXER_PASSWORD": "S3cret!idx"})
    text = repr(cfg)
    assert TOKEN not in text and "S3cret!api" not in text and "S3cret!idx" not in text


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")
def test_env_file_mode_warning(tmp_path, caplog):
    path = write(tmp_path, "A=1\n")
    os.chmod(path, 0o644)
    with caplog.at_level(logging.WARNING):
        parse_env_file(path)
    assert any("chmod 600" in r.getMessage() for r in caplog.records)
    caplog.clear()
    os.chmod(path, 0o600)
    with caplog.at_level(logging.WARNING):
        parse_env_file(path)
    assert not caplog.records


# ------------------------------------------------------------------------------------------------ redaction

def test_redact():
    assert TOKEN not in redact(f"Authorization: Bearer {TOKEN}")
    assert "pbcvm_[REDACTED]" in redact(f"t={TOKEN}")
    assert redact("eyJa.eyJb.sig") == "[REDACTED-JWT]"
    assert "S3cret!" not in redact("password is S3cret! ok", ["S3cret!"])
    assert "[REDACTED]" in redact("password is S3cret! ok", ["S3cret!"])
    assert redact("https://user:pw@h") == "https://[REDACTED]@h"
