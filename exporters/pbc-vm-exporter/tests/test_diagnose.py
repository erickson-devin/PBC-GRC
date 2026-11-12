import requests
import pytest

from pbc_vm_exporter.diagnose import HINT_INDEXER_403, HINT_REFUSED_INDEXER, classify, indexer_roles, insecure_flag_note
from pbc_vm_exporter.wazuh_indexer import DEFAULT_INDEX, INVENTORY_INDICES

INDEXER = "https://wazuh:9200"

CASES = [
    # (input, target, url, code)
    (requests.ConnectionError("HTTPSConnectionPool: Max retries: [Errno 111] Connection refused"), "indexer", INDEXER, "refused"),
    (requests.ConnectionError("[WinError 10061] No connection could be made because the target machine actively refused it"), "indexer", INDEXER, "refused"),
    (requests.ConnectTimeout("Connection to wazuh timed out. (connect timeout=10)"), "indexer", INDEXER, "timeout"),
    (requests.ConnectionError("[Errno 11001] getaddrinfo failed"), "indexer", INDEXER, "dns"),
    (requests.ConnectionError("[Errno -2] Name or service not known"), "manager", "https://wazuh:55000", "dns"),
    (requests.ConnectionError("nodename nor servname provided, or not known"), "pbc", "https://grc", "dns"),
    (requests.exceptions.SSLError("certificate verify failed: unable to get local issuer certificate"), "indexer", INDEXER, "ca_missing"),
    (requests.exceptions.SSLError("certificate verify failed: self-signed certificate in certificate chain"), "pbc", "https://grc", "ca_missing"),
    (requests.exceptions.SSLError("certificate verify failed: IP address mismatch, certificate is not valid for '10.0.0.5'"), "indexer", INDEXER, "san_mismatch"),
    (requests.exceptions.SSLError("Hostname mismatch, certificate is not valid for 'wazuh'"), "indexer", INDEXER, "san_mismatch"),
    (requests.exceptions.SSLError("hostname 'x' doesn't match 'y'"), "indexer", INDEXER, "san_mismatch"),
    (requests.ReadTimeout("Read timed out. (read timeout=60)"), "indexer", INDEXER, "read_timeout"),
    (401, "indexer", INDEXER, "indexer_internal_user"),
    ("indexer search returned HTTP 401", "indexer", INDEXER, "indexer_internal_user"),
    (403, "indexer", INDEXER, "indexer_role"),
    (404, "indexer", INDEXER, "index_not_found"),
    (401, "manager", "https://wazuh:55000", "manager_auth"),
    (401, "pbc", "https://grc", "token_invalid"),
    (403, "pbc", "https://grc", "insufficient_scope"),
    ("HTTP 403 vm_insecure_transport", "pbc", "https://grc", "insecure_transport"),
    (401, "indexer", "https://wazuh:55000", "port_swapped"),
    (requests.ConnectionError("Connection refused"), "indexer", "https://wazuh:55000/", "port_swapped"),
    (401, "manager", "https://wazuh:9200", "port_swapped"),
    (RuntimeError("something else"), "indexer", INDEXER, "unknown"),
    (418, "pbc", "https://grc", "http_418"),
    (requests.exceptions.SSLError("[SSL: WRONG_VERSION_NUMBER] wrong version number"), "pbc", "https://grc", "plain_http_port"),
    (requests.exceptions.SSLError("certificate verify failed: certificate has expired"), "indexer", INDEXER, "cert_time"),
    (requests.exceptions.SSLError("certificate verify failed: certificate is not yet valid"), "pbc", "https://grc", "cert_time"),
    (302, "indexer", INDEXER, "indexer_redirect"),
    ("indexer search returned HTTP 301", "indexer", INDEXER, "indexer_redirect"),
]


@pytest.mark.parametrize("value,target,url,code", CASES)
def test_classify_codes(value, target, url, code):
    got, hint = classify(value, target, url)
    assert got == code
    if code not in ("unknown", "not_found") and not code.startswith("http_"):
        assert hint


def test_refused_hint_names_the_bind_address_fix():
    code, hint = classify(requests.ConnectionError("Connection refused"), "indexer", INDEXER)
    assert code == "refused" and hint == HINT_REFUSED_INDEXER
    assert "network.host" in hint and "127.0.0.1" in hint and "9200" in hint
    assert "ssh -N -L 9200:127.0.0.1:9200" in hint and "WAZUH_INDEXER_URL=https://127.0.0.1:9200" in hint
    assert "network.host in /etc/wazuh-indexer/opensearch.yml" in hint


def test_indexer_roles_keeps_only_role_names():
    data = {"roles": ["readall", "own_index"], "backend_roles": ["x"], "user_name": "reader"}
    assert indexer_roles(data) == ["own_index", "readall"]
    assert indexer_roles({"roles": ["ok", "bad\x1b[31m", 5, "x" * 65]}) == ["ok"]
    assert indexer_roles({"roles": []}) == []
    assert indexer_roles({"roles": "own_index"}) == []
    assert indexer_roles(["own_index"]) == []
    assert indexer_roles({"roles": ["a", "a", "b\n"]}) == ["a"]
    assert len(indexer_roles({"roles": [f"r{i}" for i in range(50)]})) == 20


def test_indexer_403_hint_names_both_indices_and_the_mapping_step():
    assert DEFAULT_INDEX in HINT_INDEXER_403
    assert "wazuh-states-inventory-*" in HINT_INDEXER_403
    assert "Mapped users" in HINT_INDEXER_403 and "Backend roles" in HINT_INDEXER_403


def test_every_inventory_index_matches_the_hinted_pattern():
    from fnmatch import fnmatch
    assert INVENTORY_INDICES
    assert all(fnmatch(index, "wazuh-states-inventory-*") for index in INVENTORY_INDICES.values())


def test_hints_never_echo_the_input():
    secret = "pbcvm_" + "A" * 43
    _, hint = classify(requests.ConnectionError(f"Connection refused for {secret} at http://h"), "pbc", "https://h")
    assert secret not in hint and "http://h" not in hint


def test_ca_hint_names_the_right_variable():
    err = requests.exceptions.SSLError("unable to get local issuer certificate")
    assert "WAZUH_CA_BUNDLE" in classify(err, "indexer", INDEXER)[1]
    assert "PBC_CA_BUNDLE" in classify(err, "pbc", "https://grc")[1]


def test_insecure_flag_note():
    assert insecure_flag_note(True, ["https://a", None, "https://b:9200"])[0] == "insecure_flag_unneeded"
    assert insecure_flag_note(True, ["https://a", "http://b"]) is None
    assert insecure_flag_note(False, ["https://a"]) is None
