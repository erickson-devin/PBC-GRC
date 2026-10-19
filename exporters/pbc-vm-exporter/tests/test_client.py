import hashlib
import logging

import pytest
import requests

from conftest import TOKEN, FakeSession
from pbc_vm_exporter.client import IngestClient
from pbc_vm_exporter.errors import RejectedError, TransportError
from pbc_vm_exporter.transport import make_session

BODY = b'{"hello":"world"}'
SHA = hashlib.sha256(BODY).hexdigest()
OK = (202, {"run_id": "run-1", "status": "RECEIVED", "sha256": SHA})


def client(script, sleeps, verify=True, **kw):
    session = FakeSession(script)
    return IngestClient("https://grc.local/", TOKEN, verify, 60, session=session, sleep=sleeps, **kw), session


# ------------------------------------------------------------------------------------------------ success

def test_202_success_and_request_shape(sleeps):
    c, session = client([OK], sleeps)
    result = c.post_payload(BODY)
    assert (result.http_status, result.run_id, result.status, result.duplicate) == (202, "run-1", "RECEIVED", False)
    assert len(session.calls) == 1
    call = session.calls[0]
    assert call["url"] == "https://grc.local/api/v1/vm/ingest"
    assert call["data"] == BODY
    assert call["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert call["headers"]["Content-Type"] == "application/json"
    assert call["verify"] is True and call["allow_redirects"] is False and call["timeout"] == (10, 60)


def test_sha_mismatch_is_a_transport_error(sleeps):
    c, _ = client([(202, {"run_id": "r", "status": "RECEIVED", "sha256": "0" * 64})], sleeps)
    with pytest.raises(TransportError) as info:
        c.post_payload(BODY)
    assert info.value.exit_code == 6


def test_missing_sha_is_a_transport_error(sleeps):
    c, _ = client([(202, {"run_id": "r", "status": "RECEIVED"})], sleeps)
    with pytest.raises(TransportError):
        c.post_payload(BODY)


def test_duplicate_200_is_success(sleeps):
    c, _ = client([(200, {"run_id": "run-0", "status": "DONE", "sha256": SHA, "duplicate": True})], sleeps)
    result = c.post_payload(BODY)
    assert result.duplicate is True and result.http_status == 200


# ------------------------------------------------------------------------------------------------ rejected, one attempt

@pytest.mark.parametrize(
    "status,body,needle",
    [
        (400, {"error": "$.hosts[0].agent_id: required"}, "$.hosts[0].agent_id: required"),
        (401, {"error": "Unauthorized: invalid service token"}, "401"),
        (403, {"error": "insufficient_scope"}, "insufficient_scope"),
        (409, {"error": "vm_source_kind_mismatch"}, "vm_source_kind_mismatch"),
        (413, {"error": "payload_too_large"}, "EXPORT_MAX_BYTES"),
        (415, {"error": "unsupported_media_type"}, "415"),
        (503, {"error": "vm_requires_local_storage"}, "vm_requires_local_storage"),
        (404, {"error": "nope"}, "404"),
    ],
)
def test_rejected_after_one_attempt(sleeps, status, body, needle):
    c, session = client([(status, body)], sleeps)
    with pytest.raises(RejectedError) as info:
        c.post_payload(BODY)
    assert info.value.exit_code == 5 and needle in str(info.value)
    assert len(session.calls) == 1 and sleeps.calls == []


def test_redirect_is_refused(sleeps):
    c, session = client([(302, None, {"Location": "https://elsewhere/"})], sleeps)
    with pytest.raises(RejectedError) as info:
        c.post_payload(BODY)
    assert "redirect refused" in str(info.value) and len(session.calls) == 1


# ------------------------------------------------------------------------------------------------ retries

def test_429_honours_retry_after(sleeps):
    c, session = client([(429, {}, {"Retry-After": "60"}), OK], sleeps)
    assert c.post_payload(BODY).http_status == 202
    assert sleeps.calls == [60] and len(session.calls) == 2


def test_429_retry_after_is_capped_at_60(sleeps):
    c, _ = client([(429, {}, {"Retry-After": "600"}), OK], sleeps)
    c.post_payload(BODY)
    assert sleeps.calls == [60]


def test_429_without_header_waits_5(sleeps):
    c, _ = client([(429, {}), OK], sleeps)
    c.post_payload(BODY)
    assert sleeps.calls == [5]


@pytest.mark.parametrize("status", [500, 502, 504])
def test_5xx_retries_then_gives_up(sleeps, status):
    c, session = client([(status, {"error": "x"})] * 3, sleeps)
    with pytest.raises(TransportError) as info:
        c.post_payload(BODY)
    assert info.value.exit_code == 6
    assert len(session.calls) == 3 and sleeps.calls == [2, 4]


def test_connection_error_then_success(sleeps):
    c, session = client([requests.ConnectionError("boom"), OK], sleeps)
    assert c.post_payload(BODY).http_status == 202
    assert len(session.calls) == 2


def test_timeouts_exhaust_into_exit_6(sleeps):
    c, session = client([requests.Timeout("slow")] * 3, sleeps)
    with pytest.raises(TransportError) as info:
        c.post_payload(BODY)
    assert info.value.exit_code == 6 and len(session.calls) == 3


def test_retries_resend_identical_bytes(sleeps):
    c, session = client([(500, {}), (500, {}), OK], sleeps)
    c.post_payload(BODY)
    assert [call["data"] for call in session.calls] == [BODY, BODY, BODY]


# ------------------------------------------------------------------------------------------------ session and logging

def test_ca_bundle_is_passed_and_verification_is_never_off(sleeps):
    c, session = client([(500, {}), OK], sleeps, verify="/x/ca.pem")
    c.post_payload(BODY)
    assert all(call["verify"] == "/x/ca.pem" for call in session.calls)
    assert all(call["verify"] is not False for call in session.calls)


def test_session_ignores_the_environment():
    assert make_session().trust_env is False


def test_logs_never_carry_the_token(sleeps, caplog):
    caplog.set_level(logging.DEBUG)
    for script in ([OK], [(429, {}), OK], [(500, {})] * 3, [(401, {"error": "Unauthorized"})], [requests.ConnectionError("x")] * 3):
        c, _ = client(script, sleeps)
        try:
            c.post_payload(BODY)
        except Exception:
            pass
    c, _ = client([OK, OK], sleeps)
    c.send_all([BODY, BODY], [{"hosts": 1, "findings": 2}, {"hosts": 1, "findings": 3}])
    text = caplog.text
    assert TOKEN not in text and "Bearer pbcvm_" not in text


# ------------------------------------------------------------------------------------------------ send_all

def test_send_all_stops_at_the_first_failure(sleeps):
    c, session = client([OK, (400, {"error": "$.x: bad"})], sleeps)
    with pytest.raises(RejectedError):
        c.send_all([BODY, BODY, BODY], [{}, {}, {}])
    assert len(session.calls) == 2


def test_send_all_pauses_between_chunks(sleeps):
    c, _ = client([OK, OK], sleeps)
    results = c.send_all([BODY, BODY], [{}, {}])
    assert len(results) == 2 and sleeps.calls == [2.5]
