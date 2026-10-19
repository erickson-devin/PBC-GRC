"""Pure mapping from the canonical Wazuh rows to ingest payloads. No I/O; the clock is injectable.

Closure safety (the server closes what a reported host no longer lists):
  - a host's findings are never shortened and a host is never split across chunks;
  - a host that cannot be sent whole (over 5000 findings, or larger than the byte budget) is skipped whole;
  - a host whose read failed or that was never scanned is never passed in here.
"""

import json
import logging
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from . import EXPORTER_NAME, __version__
from .validate import parse_rfc3339, utf16_len

log = logging.getLogger(__name__)

SEVERITY_MAP = {"critical": "CRITICAL", "high": "HIGH", "medium": "MEDIUM", "low": "LOW", "untriaged": "UNKNOWN"}

MAX_FINDINGS_PER_HOST = 5000
ENVELOPE_BYTES = 1024  # allowance for the payload outside the hosts array

_VULN_ID = re.compile(r"(CVE-[0-9]{4}-[0-9]{4,7}|[A-Za-z0-9][A-Za-z0-9._:-]{0,63})")
_CONTROL_OR_SURROGATE = re.compile(r"[\x00-\x1f\x7f]+|[\ud800-\udfff]+")
_REF = re.compile(r"https?://[\x21-\x7e]+")
_IP = re.compile(r"[A-Za-z0-9.:_/%-]{0,64}")
_MAC = re.compile(r"[0-9A-Fa-f:.-]{0,32}")
_SPACE_DATETIME = re.compile(r"\A([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2})\Z")
_DATE_ONLY = re.compile(r"\A([0-9]{4}-[0-9]{2}-[0-9]{2})\Z")
_NUMERIC = re.compile(r"[0-9]+(\.[0-9]+)?")


@dataclass
class AdapterStats:
    dropped_rows: int = 0
    dropped_hosts: int = 0
    skipped_hosts: list[str] = field(default_factory=list)


def map_severity(v: Any) -> str:
    return SEVERITY_MAP.get(str(v).strip().lower(), "UNKNOWN")


def utc_now_rfc3339(now: datetime | None = None) -> str:
    now = now if now is not None else datetime.now(timezone.utc)
    if now.tzinfo is not None:
        now = now.astimezone(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%SZ")


def _format_utc(dt: datetime, millis: int) -> str:
    frac = f".{millis:03d}" if millis else ""
    return f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}T{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}{frac}Z"


def normalize_datetime(v: Any) -> str | None:
    """RFC 3339, `YYYY-MM-DD HH:MM:SS` (UTC) or `YYYY-MM-DD` (midnight UTC) -> UTC `...Z`; anything else -> None."""
    if not isinstance(v, str):
        return None
    s = v.strip()
    m = _SPACE_DATETIME.match(s)
    if m:
        s = f"{m.group(1)}T{m.group(2)}Z"
    elif _DATE_ONLY.match(s):
        s = f"{s}T00:00:00Z"
    parsed = parse_rfc3339(s)
    if parsed is None:
        return None
    local, millis, offset = parsed
    try:
        utc = local - timedelta(minutes=offset)
    except OverflowError:
        return None
    if utc.year < 1:
        return None
    return _format_utc(utc, millis)


def clean_line(v: Any, max_units: int) -> str | None:
    """Control characters become a space, the text is stripped and cut to max_units UTF-16 units (never mid-pair)."""
    if v is None or isinstance(v, bool):
        return None
    s = _CONTROL_OR_SURROGATE.sub(lambda m: " " if m.group(0)[0] < "\ud800" else "", str(v)).strip()
    out: list[str] = []
    units = 0
    for ch in s:
        n = 2 if ord(ch) > 0xFFFF else 1
        if units + n > max_units:
            break
        out.append(ch)
        units += n
    return "".join(out) or None


def normalize_refs(v: Any) -> list[str]:
    items = v.split(",") if isinstance(v, str) else v if isinstance(v, list) else []
    out: list[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        ref = item.strip()
        if len(ref) <= 2048 and _REF.fullmatch(ref) and ref not in out:
            out.append(ref)
            if len(out) == 20:
                break
    return out


def normalize_cvss(score: Any, version: Any) -> float | None:
    """A finite 0..10 number; when a version is given it must be 3.x (a v2 score labelled v3 would mis-grade)."""
    if version is not None and not str(version).strip().startswith("3"):
        return None
    if isinstance(score, bool):
        return None
    if isinstance(score, str):
        text = score.strip()
        if not _NUMERIC.fullmatch(text):
            return None
        score = float(text)
    if not isinstance(score, (int, float)):
        return None
    try:
        if not math.isfinite(score):
            return None
    except OverflowError:
        return None
    return float(score) if 0 <= score <= 10 else None


def normalize_agent_id(v: Any) -> str | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return f"{v:03d}" if v >= 0 else None
    if not isinstance(v, str):
        return None
    s = v.strip()
    if not s or _CONTROL_OR_SURROGATE.search(s) or utf16_len(s) > 128:
        return None
    return s


def row_to_finding(row: dict) -> dict | None:
    vuln_id = row.get("vuln_id")
    vuln_id = vuln_id.strip() if isinstance(vuln_id, str) else None
    if vuln_id is None or not _VULN_ID.fullmatch(vuln_id):
        return None
    finding: dict[str, Any] = {"vuln_id": vuln_id}
    title = clean_line(row.get("title"), 512)
    if title is not None:
        finding["title"] = title
    finding["severity"] = map_severity(row.get("severity"))
    cvss = normalize_cvss(row.get("score"), row.get("score_version"))
    if cvss is not None:
        finding["cvss_v3"] = cvss
    name = clean_line(row.get("package_name"), 255)
    if name is not None:
        package: dict[str, Any] = {"name": name}
        version = clean_line(row.get("package_version"), 128)
        if version is not None:
            package["version"] = version
        package["fixed_version"] = clean_line(row.get("fixed_version"), 128)
        finding["package"] = package
    detected = normalize_datetime(row.get("detected_at"))
    if detected is not None:
        finding["detected_at"] = detected
    published = normalize_datetime(row.get("published_at"))
    if published is not None:
        finding["published_at"] = published
    refs = normalize_refs(row.get("refs"))
    if refs:
        finding["refs"] = refs
    return finding


def _sort_key(f: dict) -> tuple[str, str, str]:
    package = f.get("package") or {}
    return f["vuln_id"], package.get("name", ""), package.get("version", "")


def build_hosts(raw_hosts: list[dict]) -> tuple[list[dict], AdapterStats]:
    stats = AdapterStats()
    merged: dict[str, dict] = {}
    for raw in raw_hosts:
        agent_id = normalize_agent_id(raw.get("agent_id"))
        if agent_id is None:
            stats.dropped_hosts += 1
            log.warning("dropping a host without a usable agent id")
            continue
        entry = merged.get(agent_id)
        if entry is None:
            entry = {"raw": raw, "rows": []}
            merged[agent_id] = entry
        else:
            first = clean_line(entry["raw"].get("hostname"), 255)
            second = clean_line(raw.get("hostname"), 255)
            if first and second and first != second:
                log.warning("agent %s appears with different hostnames; keeping the first", agent_id)
        entry["rows"].extend(raw.get("rows") or [])

    hosts: list[dict] = []
    for agent_id in sorted(merged):
        entry = merged[agent_id]
        raw = entry["raw"]
        findings: list[dict] = []
        seen: set[str] = set()
        for row in entry["rows"]:
            finding = row_to_finding(row)
            if finding is None:
                stats.dropped_rows += 1
                continue
            key = json.dumps(finding, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            findings.append(finding)
        findings.sort(key=_sort_key)
        if len(findings) > MAX_FINDINGS_PER_HOST:
            log.warning("skipping agent %s: %d findings exceed the %d per host limit", agent_id, len(findings),
                        MAX_FINDINGS_PER_HOST)
            stats.skipped_hosts.append(agent_id)
            continue
        host: dict[str, Any] = {"agent_id": agent_id}
        hostname = clean_line(raw.get("hostname"), 255)
        if hostname is not None:
            host["hostname"] = hostname
        ip = raw.get("ip")
        if isinstance(ip, str) and ip.strip() and _IP.fullmatch(ip.strip()):
            host["ip"] = ip.strip()
        mac = raw.get("mac")
        if isinstance(mac, str) and mac.strip() and _MAC.fullmatch(mac.strip()):
            host["mac"] = mac.strip()
        os_info: dict[str, str] = {}
        os_name = clean_line(raw.get("os_name"), 128)
        if os_name is not None:
            os_info["name"] = os_name
        os_version = clean_line(raw.get("os_version"), 64)
        if os_version is not None:
            os_info["version"] = os_version
        if os_info:
            host["os"] = os_info
        host["findings"] = findings
        hosts.append(host)
    return hosts, stats


def encode_payload(p: dict) -> bytes:
    return json.dumps(p, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def chunk_hosts(
    hosts: list[dict], *, max_hosts: int, max_findings: int, max_bytes: int
) -> tuple[list[list[dict]], list[str]]:
    """Greedy packing by hosts, findings and bytes. A host that does not fit an empty chunk is skipped, never cut."""
    chunks: list[list[dict]] = []
    skipped: list[str] = []
    current: list[dict] = []
    cur_findings = 0
    cur_bytes = ENVELOPE_BYTES
    for host in hosts:
        n = len(host["findings"])
        size = len(encode_payload(host)) + 1
        if n > max_findings or ENVELOPE_BYTES + size > max_bytes:
            log.warning("skipping agent %s: too large to send whole (%d findings, %d bytes)", host["agent_id"], n, size)
            skipped.append(host["agent_id"])
            continue
        if current and (
            len(current) >= max_hosts or cur_findings + n > max_findings or cur_bytes + size > max_bytes
        ):
            chunks.append(current)
            current, cur_findings, cur_bytes = [], 0, ENVELOPE_BYTES
        current.append(host)
        cur_findings += n
        cur_bytes += size
    if current:
        chunks.append(current)
    return chunks, skipped


def build_payloads(
    raw_hosts: list[dict],
    *,
    label: str,
    now: datetime | None = None,
    max_hosts: int = 500,
    max_findings: int = 50000,
    max_bytes: int = 33554432,
) -> tuple[list[dict], AdapterStats]:
    hosts, stats = build_hosts(raw_hosts)
    chunks, skipped = chunk_hosts(hosts, max_hosts=max_hosts, max_findings=max_findings, max_bytes=max_bytes)
    stats.skipped_hosts.extend(skipped)
    if not chunks:
        return [], stats
    collected_at = utc_now_rfc3339(now)  # once per export: a retry resends identical bytes
    payloads = [
        {
            "schema_version": 1,
            "source": {"kind": "WAZUH", "label": label},
            "exporter": {"name": EXPORTER_NAME, "version": __version__},
            "collected_at": collected_at,
            "hosts": chunk,
        }
        for chunk in chunks
    ]
    return payloads, stats
