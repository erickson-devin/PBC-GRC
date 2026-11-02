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


# ------------------------------------------------------------------------------------------------ vendor sources

A1_ENV = {
    "ACTION1_BASE_URL": "https://app.example/api/3.0", "ACTION1_CLIENT_ID": "client-1",
    "ACTION1_CLIENT_SECRET": "client-secret-" + "z" * 20, "ACTION1_ORG_ID": "org-1",
}
S1_ENV = {
    "S1_CONSOLE_URL": "https://console.example", "S1_API_TOKEN": "s1-token-" + "x" * 30, "S1_SITE_IDS": "111,222",
}


def load_vendor(source, env=None, *, sample=False, dry_run=False, mode=None):
    return load_config(
        {**BASE, **(env or {})}, None, mode_override=mode, dry_run=dry_run, sample=sample, source=source
    )


def test_action1_settings_load_and_the_secret_is_hidden():
    cfg = load_vendor("action1", A1_ENV)
    a1 = cfg.action1
    assert a1.base_url == "https://app.example/api/3.0" and a1.org_id == "org-1" and a1.include_patch_findings is True
    assert a1.verify is True and a1.proxy_url is None and cfg.sentinelone is None
    assert A1_ENV["ACTION1_CLIENT_SECRET"] not in repr(cfg) and A1_ENV["ACTION1_CLIENT_SECRET"] in cfg.secrets()


def test_action1_requires_its_variables_and_names_the_missing_one():
    for name in A1_ENV:
        env = {k: v for k, v in A1_ENV.items() if k != name}
        with pytest.raises(ConfigError, match=name):
            load_vendor("action1", env)


def test_action1_refuses_http_a_bad_org_id_and_control_characters():
    with pytest.raises(ConfigError, match="https"):
        load_vendor("action1", {**A1_ENV, "ACTION1_BASE_URL": "http://app.example/api/3.0"})
    with pytest.raises(ConfigError, match="ACTION1_ORG_ID"):
        load_vendor("action1", {**A1_ENV, "ACTION1_ORG_ID": "a/b"})
    with pytest.raises(ConfigError, match="ACTION1_CLIENT_ID"):
        load_vendor("action1", {**A1_ENV, "ACTION1_CLIENT_ID": "a\x00b"})


def test_action1_secret_never_appears_in_an_error():
    secret = "bad secret\x01" + "q" * 30
    with pytest.raises(ConfigError) as info:
        load_vendor("action1", {**A1_ENV, "ACTION1_CLIENT_SECRET": secret})
    assert "q" * 30 not in str(info.value)


def test_action1_patch_findings_switch_and_proxy():
    assert load_vendor("action1", {**A1_ENV, "ACTION1_INCLUDE_PATCH_FINDINGS": "false"}).action1.include_patch_findings is False
    assert load_vendor("action1", {**A1_ENV, "ACTION1_INCLUDE_PATCH_FINDINGS": "yes"}).action1.include_patch_findings is True
    cfg = load_vendor("action1", {**A1_ENV, "ACTION1_PROXY_URL": "http://proxy.example:3128"})
    assert cfg.action1.proxy_url == "http://proxy.example:3128" and cfg.pbc_url == "https://grc.local"
    with pytest.raises(ConfigError, match="ACTION1_PROXY_URL"):
        load_vendor("action1", {**A1_ENV, "ACTION1_PROXY_URL": "socks5://proxy.example:1080"})
    with pytest.raises(ConfigError, match="credentials"):
        load_vendor("action1", {**A1_ENV, "ACTION1_PROXY_URL": "http://user:pw@proxy.example:3128"})


def test_sentinelone_settings_load_and_site_ids_are_deduplicated():
    cfg = load_vendor("sentinelone", {**S1_ENV, "S1_SITE_IDS": " 123,456,123"})
    assert cfg.sentinelone.site_ids == ("123", "456") and cfg.sentinelone.console_url == "https://console.example"
    assert S1_ENV["S1_API_TOKEN"] not in repr(cfg) and S1_ENV["S1_API_TOKEN"] in cfg.secrets()
    assert cfg.action1 is None


@pytest.mark.parametrize("sites", ["abc", "", "1,,2", "1,x", "-1"])
def test_sentinelone_bad_site_ids(sites):
    with pytest.raises(ConfigError, match="S1_SITE_IDS"):
        load_vendor("sentinelone", {**S1_ENV, "S1_SITE_IDS": sites})


def test_sentinelone_site_id_count_is_capped():
    with pytest.raises(ConfigError, match="S1_SITE_IDS"):
        load_vendor("sentinelone", {**S1_ENV, "S1_SITE_IDS": ",".join(str(i) for i in range(101))})


def test_sentinelone_token_with_a_space_is_refused_and_not_echoed():
    with pytest.raises(ConfigError) as info:
        load_vendor("sentinelone", {**S1_ENV, "S1_API_TOKEN": "abc def " + "t" * 30})
    assert "S1_API_TOKEN" in str(info.value) and "t" * 30 not in str(info.value)
    with pytest.raises(ConfigError, match="S1_API_TOKEN"):
        load_vendor("sentinelone", {**S1_ENV, "S1_API_TOKEN": "short"})


def test_sentinelone_console_url_is_host_only_and_https():
    with pytest.raises(ConfigError, match="host only"):
        load_vendor("sentinelone", {**S1_ENV, "S1_CONSOLE_URL": "https://console.example/web/api/v2.1"})
    with pytest.raises(ConfigError, match="https"):
        load_vendor("sentinelone", {**S1_ENV, "S1_CONSOLE_URL": "http://console.example"})
    for name in S1_ENV:
        with pytest.raises(ConfigError, match=name):
            load_vendor("sentinelone", {k: v for k, v in S1_ENV.items() if k != name})


def test_wazuh_settings_are_not_validated_for_a_vendor_source():
    cfg = load_vendor("sentinelone", {**S1_ENV, "WAZUH_MODE": "bogus", "WAZUH_INDEXER_INDEX": "bad index!"})
    assert cfg.sentinelone is not None
    with pytest.raises(ConfigError, match="WAZUH_MODE"):
        load_vendor("wazuh", {"WAZUH_MODE": "bogus"})


def test_vendor_variables_are_not_needed_for_the_sample():
    assert load_vendor("action1", sample=True, dry_run=True).action1 is None
    assert load_vendor("sentinelone", sample=True, dry_run=True).sentinelone is None


def test_vendor_variables_are_ignored_by_the_other_sources():
    assert load_vendor("wazuh", {**A1_ENV, **S1_ENV}).action1 is None
    assert load_vendor("wazuh", {"ACTION1_BASE_URL": "http://x"}).action1 is None


def test_apitoken_is_redacted_in_text():
    assert redact("sent Authorization: ApiToken abc.def now") == "sent Authorization: ApiToken [REDACTED] now"
