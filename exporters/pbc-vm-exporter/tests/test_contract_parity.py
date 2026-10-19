import hashlib

from conftest import SERVER_SCHEMA
from pbc_vm_exporter.validate import contract_bytes, contract_sha256, load_contract


def test_vendored_contract_is_byte_identical_to_the_server_file():
    # Fails (does not skip) when the server file is missing: the exporter lives in the same repository.
    assert SERVER_SCHEMA.is_file(), f"server contract not found at {SERVER_SCHEMA}"
    server = SERVER_SCHEMA.read_bytes()
    vendored = contract_bytes()
    print("server  :", hashlib.sha256(server).hexdigest())
    print("vendored:", hashlib.sha256(vendored).hexdigest())
    assert vendored == server


def test_vendored_contract_is_lf_only():
    assert b"\r" not in contract_bytes()


def test_contract_sha256_is_the_sha256_of_the_server_bytes():
    assert contract_sha256() == hashlib.sha256(SERVER_SCHEMA.read_bytes()).hexdigest()


def test_contract_identity():
    contract = load_contract()
    assert contract["$id"] == "urn:pbc-grc:vm:ingest:1"
    assert "50000" in contract["description"]
