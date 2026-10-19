import pytest
import requests

from conftest import FakeSession, load_fixture
from pbc_vm_exporter.config import load_config
from pbc_vm_exporter.detect import mode_for_version, resolve_mode
from pbc_vm_exporter.errors import ConfigError, WazuhReadError
from pbc_vm_exporter.wazuh_api import ApiReader

ENV = {"PBC_URL": "https://g", "PBC_SERVICE_TOKEN": "pbcvm_" + "A" * 43, "PBC_SOURCE_LABEL": "wazuh-prod"}


def cfg(mode):
    return load_config({**ENV, "WAZUH_MODE": mode}, None, mode_override=None, dry_run=False, sample=False)


@pytest.mark.parametrize(
    "version,expected",
    [
        ("4.7.5", "api"), ("v4.7.0", "api"), ("4.3.11", "api"),
        ("4.8.0", "indexer"), ("4.10.1", "indexer"), ("v4.9.2", "indexer"), ("5.0.0", "indexer"),
    ],
)
def test_mode_for_version(version, expected):
    assert mode_for_version(version) == expected


@pytest.mark.parametrize("version", ["3.13.0", "garbage", "", None])
def test_undetectable_versions(version):
    with pytest.raises(ConfigError):
        mode_for_version(version)


def test_explicit_mode_makes_no_http_call():
    session = FakeSession()
    reader = ApiReader("https://wazuh:55000", "u", "p", True, 60, session=session)
    assert resolve_mode(cfg("indexer"), reader) == ("indexer", None)
    assert resolve_mode(cfg("api"), reader) == ("api", None)
    assert session.calls == []


def test_auto_reads_the_version_from_the_api():
    session = FakeSession([(200, {"data": {"token": "jwt1"}}), (200, load_fixture("api_info_4_7.json"))])
    reader = ApiReader("https://wazuh:55000", "u", "p", True, 60, session=session)
    assert resolve_mode(cfg("auto"), reader) == ("api", "wazuh-mgr")


def test_auto_with_an_unreachable_api():
    session = FakeSession([requests.ConnectionError("down")])
    reader = ApiReader("https://wazuh:55000", "u", "p", True, 60, session=session)
    with pytest.raises(WazuhReadError):
        resolve_mode(cfg("auto"), reader)


def test_auto_without_api_settings():
    with pytest.raises(ConfigError):
        resolve_mode(cfg("auto"), None)
