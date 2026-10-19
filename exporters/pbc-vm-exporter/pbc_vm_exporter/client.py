"""POST /api/v1/vm/ingest with bounded retries.

A body is serialized once and every retry resends the same bytes: a lost 202 is then answered with
200 {duplicate: true} by the server instead of creating a second run.
"""

import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable

import requests

from .config import redact
from .errors import RejectedError, TransportError
from .transport import make_session

log = logging.getLogger(__name__)

INGEST_PATH = "/api/v1/vm/ingest"
RETRY_AFTER_CAP = 60
RETRY_AFTER_DEFAULT = 5
RETRYABLE_STATUSES = (500, 502, 503, 504)
REJECTED_STATUSES = (400, 401, 403, 409, 413, 415)

HINTS = {
    400: "the path names the offending field; this indicates an exporter bug, file an issue",
    401: "the service token is wrong, expired or revoked",
    403: "the token lacks the vm:ingest scope (insufficient_scope)",
    409: "vm_source_kind_mismatch: PBC_SOURCE_LABEL is already used by a source of another kind; choose another label",
    413: "payload_too_large: lower EXPORT_MAX_BYTES or EXPORT_MAX_HOSTS_PER_REQUEST, or check VM_INGEST_MAX_BYTES on the server",
    415: "a proxy is rewriting Content-Type or Content-Encoding",
    503: "vm_requires_local_storage: the server needs STORAGE_PROVIDER=local",
}


@dataclass
class IngestResult:
    http_status: int
    run_id: str | None
    status: str | None
    sha256: str
    duplicate: bool


def _json(resp: Any) -> dict:
    try:
        data = resp.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _server_error(data: dict) -> str:
    err = data.get("error")
    return redact(err[:300]) if isinstance(err, str) else ""


class IngestClient:
    def __init__(
        self, base_url: str, token: str, verify: bool | str, timeout: int,
        *, session: Any = None, sleep: Callable[[float], None] = time.sleep, max_attempts: int = 3,
        pause_seconds: float = 2.5,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.verify = verify
        self.timeout = timeout
        self.session = session if session is not None else make_session()
        self.sleep = sleep
        self.max_attempts = max_attempts
        self.pause_seconds = pause_seconds

    def _reject(self, status: int, data: dict) -> RejectedError:
        message = f"PBC-GRC rejected the request (HTTP {status})"
        error = _server_error(data)
        if error:
            message += f": {error}"
        hint = HINTS.get(status)
        if hint:
            message += f" - {hint}"
        return RejectedError(message)

    def post_payload(self, body: bytes) -> IngestResult:
        local_sha = hashlib.sha256(body).hexdigest()
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        attempt = 0
        while True:
            attempt += 1
            try:
                resp = self.session.post(
                    self.base_url + INGEST_PATH, data=body, headers=headers, timeout=(10, self.timeout),
                    verify=self.verify, allow_redirects=False,
                )
            except requests.exceptions.SSLError as err:
                raise TransportError(f"TLS error talking to PBC-GRC (check PBC_CA_BUNDLE): {redact(str(err), [self.token])}") from None
            except (requests.ConnectionError, requests.Timeout) as err:
                if attempt >= self.max_attempts:
                    raise TransportError(f"could not reach PBC-GRC after {attempt} attempts: {type(err).__name__}") from None
                log.warning("connection problem (%s); retrying", type(err).__name__)
                self.sleep(2 ** attempt)
                continue
            except requests.RequestException as err:
                raise TransportError(f"request to PBC-GRC failed: {type(err).__name__}: {redact(str(err), [self.token])}") from None

            status = resp.status_code
            data = _json(resp)
            if status == 202 or (status == 200 and data.get("duplicate") is True):
                sha = data.get("sha256")
                if sha != local_sha:
                    raise TransportError("PBC-GRC acknowledged different bytes than were sent (sha256 mismatch or missing)")
                run_id = data.get("run_id")
                state = data.get("status")
                return IngestResult(
                    status, run_id if isinstance(run_id, str) else None, state if isinstance(state, str) else None,
                    sha, status == 200,
                )
            if 300 <= status < 400:
                raise RejectedError("redirect refused; set PBC_URL to the final https URL")
            if status == 503 and data.get("error") == "vm_requires_local_storage":
                raise self._reject(status, data)
            if status == 429 or status in RETRYABLE_STATUSES:
                if attempt >= self.max_attempts:
                    raise TransportError(f"PBC-GRC still answering HTTP {status} after {attempt} attempts")
                if status == 429:
                    wait = self._retry_after(resp)
                    log.warning("rate limited (HTTP 429); waiting %d s", wait)
                else:
                    wait = 2 ** attempt
                    log.warning("PBC-GRC answered HTTP %d; retrying in %d s", status, wait)
                self.sleep(wait)
                continue
            if status in REJECTED_STATUSES or 400 <= status < 500:
                raise self._reject(status, data)
            raise TransportError(f"unexpected HTTP {status} from PBC-GRC")

    @staticmethod
    def _retry_after(resp: Any) -> int:
        raw = str(resp.headers.get("Retry-After", "")).strip()
        if raw.isascii() and raw.isdigit():
            return min(int(raw), RETRY_AFTER_CAP)
        return RETRY_AFTER_DEFAULT

    def send_all(self, bodies: list[bytes], metas: list[dict]) -> list[IngestResult]:
        """Sequential. Stops at the first failure: chunks already accepted stay valid (hosts are never split)."""
        results: list[IngestResult] = []
        total = len(bodies)
        for i, body in enumerate(bodies):
            if i > 0:
                self.sleep(self.pause_seconds)
            result = self.post_payload(body)
            results.append(result)
            meta = metas[i] if i < len(metas) else {}
            log.info(
                "chunk %d/%d: %d%s run_id=%s sha256=%s hosts=%s findings=%s bytes=%s",
                i + 1, total, result.http_status, " duplicate" if result.duplicate else "", result.run_id,
                result.sha256, meta.get("hosts"), meta.get("findings"), len(body),
            )
        return results
