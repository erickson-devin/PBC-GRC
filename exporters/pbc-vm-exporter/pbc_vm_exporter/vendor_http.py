"""Request helpers shared by the vendor cloud readers (Action1, SentinelOne).

Error text carries the status or the exception type only: a message could otherwise name an organization, a site or an
endpoint id, which the readers keep out of every error and log.
"""

import time
from typing import Any, Callable

import requests

PAGE_CAP = 10000      # pages per listing: a vendor that never ends a listing fails the run instead of looping
MAX_RETRY_AFTER = 60  # seconds; a longer Retry-After is capped, not trusted


def retry_after_seconds(resp: Any) -> float:
    raw = str(getattr(resp, "headers", {}).get("Retry-After", "")).strip()
    try:
        seconds = float(raw)
    except ValueError:
        return 1.0
    if seconds != seconds:  # NaN
        return 1.0
    return min(max(seconds, 0.0), float(MAX_RETRY_AFTER))


def send(
    session: Any, method: str, url: str, what: str, error: type[Exception], *, verify: bool | str, timeout: int,
    sleep: Callable[[float], None] = time.sleep, **kwargs: Any,
):
    """One request: no redirects, a 429 is retried once after Retry-After. Other statuses are the caller's to judge."""
    for attempt in (1, 2):
        try:
            resp = getattr(session, method)(
                url, verify=verify, timeout=(10, timeout), allow_redirects=False, **kwargs
            )
        except requests.RequestException as err:
            raise error(f"{what} failed: {type(err).__name__}") from None
        if resp.status_code != 429:
            return resp
        if attempt == 2:
            raise error(f"{what} returned HTTP 429 twice (rate limited)")
        sleep(retry_after_seconds(resp))
    raise error(f"{what} failed")  # unreachable


def json_object(resp: Any, what: str, error: type[Exception]) -> dict:
    try:
        data = resp.json()
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise error(f"{what} returned an unexpected response body")
    return data
