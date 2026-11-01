"""XCCDF 1.1 / 1.2 and ARF result files -> configuration-only hosts for the ingest contract (source kind SCAP).

The files are untrusted input, so:
  - a file over 512 MiB is refused before it is read;
  - a file that mentions <!DOCTYPE or <!ENTITY (any case) is refused before it is parsed (no entity expansion, no
    external subsets), as is any encoding the byte scan cannot see through (UTF-16 / UTF-32);
  - parsing is streaming (iterparse) and the heavy subtrees are released as soon as they are read;
  - messages and logs name an input by its number ("input 1"), never by path, host name, address or agent id.

Namespaces are ignored (local names only), which covers XCCDF 1.1 and 1.2 and the ARF wrapper around them. A host is
identified by agent_id = "xccdf-" + the first 32 hex characters of sha256(lowercase fqdn, else lowercase target). A
time without an offset is read as UTC. source_sha256 is the sha256 of the file's bytes.
"""

import hashlib
import ipaddress
import logging
import re
import xml.etree.ElementTree as ET
from io import BytesIO
from pathlib import Path
from typing import Any, Sequence

from .adapter import clean_line, normalize_datetime
from .errors import ScanFileError

log = logging.getLogger(__name__)

MAX_INPUT_BYTES = 512 * 1024 * 1024
MAX_RESULTS_PER_SCAN = 5000
MAX_SCANS_PER_HOST = 20
MAX_CCI_PER_RESULT = 20

_FORBIDDEN = re.compile(rb"<!(?:DOCTYPE|ENTITY)", re.IGNORECASE)
_NAIVE_TIME = re.compile(r"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?\Z")
_ID_BAD = re.compile(r"[^A-Za-z0-9._:-]")
_CCE = re.compile(r"CCE-[0-9]{1,6}-[0-9]")
_CCI = re.compile(r"CCI-[0-9]{6}")
_IP = re.compile(r"[A-Za-z0-9.:_/%-]{0,64}")
_MAC = re.compile(r"[0-9A-Fa-f:.-]{0,32}")

FACT_PREFIX = "urn:xccdf:fact:asset:identifier:"
RESULTS = ("pass", "fail", "error", "unknown", "notapplicable", "notchecked", "notselected", "informational", "fixed")
SEVERITIES = ("high", "medium", "low", "info", "unknown")
# When one rule id appears more than once in a TestResult the worst outcome wins.
_RANK = {"fail": 0, "error": 1, "unknown": 2, "pass": 3, "fixed": 4}


def _local(tag: Any) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _text(elem: ET.Element) -> str:
    return "".join(elem.itertext()).strip()


def _children(elem: ET.Element, name: str) -> list[ET.Element]:
    return [c for c in elem if _local(c.tag) == name]


def _first_text(elem: ET.Element, name: str) -> str | None:
    for c in _children(elem, name):
        t = _text(c)
        if t:
            return t
    return None


def xccdf_id(v: Any) -> str | None:
    """An identifier in the contract's pattern (^[A-Za-z0-9_][A-Za-z0-9._:-]{0,254}$); odd characters become `_`."""
    if not isinstance(v, str):
        return None
    s = _ID_BAD.sub("_", v.strip())[:255]
    if not s:
        return None
    if s[0] in ".:-":
        s = "_" + s[:254]
    return s


def _time(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip()
    if _NAIVE_TIME.match(s):
        s += "Z"  # no offset: UTC
    return normalize_datetime(s)


def agent_id_for(fqdn: str | None, target: str | None) -> str | None:
    seed = (fqdn or target or "").strip().lower()
    if not seed:
        return None
    return "xccdf-" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32]


def _usable_ip(v: str) -> str | None:
    v = v.strip()
    try:
        addr = ipaddress.ip_address(v.split("%", 1)[0])
    except ValueError:
        return None
    if addr.is_loopback or addr.is_unspecified or not _IP.fullmatch(v):
        return None
    return v


class _Parsed:
    """What one input yields before ARF assets are joined to the results."""

    def __init__(self) -> None:
        self.rule_titles: dict[str, str] = {}
        self.profile_titles: dict[str, str] = {}
        self.root_benchmark: dict[str, str | None] | None = None
        self.results: list[dict] = []
        self.assets: dict[str, dict] = {}
        self.about: dict[str, str] = {}  # report id -> asset id


def _read_test_result(elem: ET.Element, report_id: str | None) -> dict:
    facts: dict[str, list[str]] = {}
    for tf in _children(elem, "target-facts"):
        for f in _children(tf, "fact"):
            name = f.get("name") or ""
            value = _text(f)
            if name.startswith(FACT_PREFIX) and value:
                facts.setdefault(name[len(FACT_PREFIX):].lower(), []).append(value)
    addresses = [_text(c) for c in _children(elem, "target-address")] + facts.get("ipv4", []) + facts.get("ipv6", [])
    rules: list[dict] = []
    for rr in _children(elem, "rule-result"):
        idref = xccdf_id(rr.get("idref"))
        if idref is None:
            continue
        raw_result = (_first_text(rr, "result") or "").lower()
        severity = (rr.get("severity") or "").strip().lower()
        cce: str | None = None
        cci: list[str] = []
        for ident in _children(rr, "ident"):
            value = _text(ident)
            if _CCI.fullmatch(value):
                if value not in cci and len(cci) < MAX_CCI_PER_RESULT:
                    cci.append(value)
            elif cce is None and "cce" in (ident.get("system") or "").lower() and _CCE.fullmatch(value):
                cce = value
        rules.append({
            "rule_id": idref,
            "result": raw_result if raw_result in RESULTS else "unknown",
            "severity": severity if severity in SEVERITIES else None,
            "cce": cce,
            "cci": cci,
        })
    benchmark_elems = _children(elem, "benchmark")
    profile_elems = _children(elem, "profile")
    return {
        "report": report_id,
        "benchmark_id": xccdf_id(benchmark_elems[0].get("id")) if benchmark_elems else None,
        "version": clean_line(elem.get("version"), 64),
        "profile_id": xccdf_id(profile_elems[0].get("idref")) if profile_elems else None,
        "start": _time(elem.get("start-time")),
        "end": _time(elem.get("end-time")),
        "scanner": clean_line(elem.get("test-system"), 128),
        "targets": [t for t in (_text(c) for c in _children(elem, "target")) if t],
        "addresses": addresses,
        "facts": facts,
        "rules": rules,
    }


def _read_device(elem: ET.Element) -> dict:
    ips: list[str] = []
    macs: list[str] = []
    for el in elem.iter():
        name = _local(el.tag)
        if name in ("ip-v4", "ip-v6"):
            ips.append(_text(el))
        elif name == "mac-address":
            macs.append(_text(el))
    return {"fqdn": _first_text(elem, "fqdn"), "host_name": _first_text(elem, "hostname"), "ips": ips, "macs": macs}


def _parse(data: bytes) -> _Parsed:
    out = _Parsed()
    stack: list[tuple[str, str | None]] = []
    seen_benchmark = False
    for event, elem in ET.iterparse(BytesIO(data), events=("start", "end")):
        name = _local(elem.tag)
        if event == "start":
            stack.append((name, elem.get("id")))
            continue
        stack.pop()
        if name == "Rule":
            title = _first_text(elem, "title")
            rid = xccdf_id(elem.get("id"))
            if rid is not None and title and rid not in out.rule_titles:
                out.rule_titles[rid] = title
            elem.clear()
        elif name == "Profile":
            title = _first_text(elem, "title")
            pid = xccdf_id(elem.get("id"))
            if pid is not None and title and pid not in out.profile_titles:
                out.profile_titles[pid] = title
        elif name == "Benchmark" and not seen_benchmark and not any(n == "TestResult" for n, _ in stack):
            seen_benchmark = True
            out.root_benchmark = {
                "id": xccdf_id(elem.get("id")),
                "version": clean_line(_first_text(elem, "version"), 64),
                "title": clean_line(_first_text(elem, "title"), 255),
            }
        elif name == "TestResult":
            report_id = next((i for n, i in reversed(stack) if n == "report"), None)
            out.results.append(_read_test_result(elem, report_id))
            elem.clear()
        elif name == "computing-device":
            asset_id = next((i for n, i in reversed(stack) if n == "asset"), None)
            if asset_id:
                out.assets[asset_id] = _read_device(elem)
            elem.clear()
        elif name == "relationship" and (elem.get("type") or "").endswith("isAbout"):
            subject = (elem.get("subject") or "").lstrip("#")
            for ref in _children(elem, "ref"):
                target = _text(ref).lstrip("#")
                if subject and target:
                    out.about[subject] = target
            elem.clear()
    return out


def _scan_and_host(res: dict, parsed: _Parsed, sha256: str, input_no: int) -> tuple[str, dict, dict] | None:
    if not res["rules"]:
        return None
    facts = res["facts"]
    device = None
    if res["report"] is not None:
        device = parsed.assets.get(parsed.about.get(res["report"], ""))
    if device is None and len(parsed.assets) == 1 and len(parsed.results) == 1:
        device = next(iter(parsed.assets.values()))

    target = res["targets"][0] if res["targets"] else None
    fqdn = (device or {}).get("fqdn") or (facts.get("fqdn") or [None])[0]
    host_name = (device or {}).get("host_name") or (facts.get("host_name") or [None])[0]
    agent_id = agent_id_for(fqdn, target)
    if agent_id is None:
        raise ScanFileError(f"input {input_no}: a TestResult names no target; its host cannot be identified")

    host: dict[str, Any] = {"agent_id": agent_id}
    hostname = clean_line(fqdn or host_name or target, 255)
    if hostname is not None:
        host["hostname"] = hostname
    ip = next((a for a in map(_usable_ip, res["addresses"] + (device or {}).get("ips", [])) if a), None)
    if ip is not None:
        host["ip"] = ip
    mac = next(
        (m.strip() for m in facts.get("mac", []) + (device or {}).get("macs", []) if m.strip() and _MAC.fullmatch(m.strip())),
        None,
    )
    if mac is not None:
        host["mac"] = mac

    scanned_at = res["end"] or res["start"]
    if scanned_at is None:
        raise ScanFileError(f"input {input_no}: a TestResult has no usable start-time or end-time")
    root = parsed.root_benchmark or {}
    benchmark: dict[str, str] = {"id": res["benchmark_id"] or root.get("id") or "unknown"}
    version = res["version"] or root.get("version")
    if version:
        benchmark["version"] = version
    if root.get("title"):
        benchmark["title"] = root["title"]  # type: ignore[assignment]
    scan: dict[str, Any] = {"benchmark": benchmark}
    if res["profile_id"]:
        profile: dict[str, str] = {"id": res["profile_id"]}
        ptitle = clean_line(parsed.profile_titles.get(res["profile_id"]), 255)
        if ptitle:
            profile["title"] = ptitle
        scan["profile"] = profile
    scan["scanner"] = {"name": res["scanner"] or "unknown"}
    if res["start"] and res["end"]:
        scan["started_at"] = res["start"]
    scan["scanned_at"] = scanned_at
    scan["source_sha256"] = sha256
    scan["results"] = _fold(res["rules"], parsed.rule_titles, input_no)
    return agent_id, host, scan


def _fold(rules: list[dict], titles: dict[str, str], input_no: int) -> list[dict]:
    best: dict[str, dict] = {}
    for r in rules:
        cur = best.get(r["rule_id"])
        if cur is None:
            best[r["rule_id"]] = dict(r)
            continue
        if _RANK.get(r["result"], 5) < _RANK.get(cur["result"], 5):
            keep = dict(r)
            for k in ("severity", "cce"):
                keep[k] = keep[k] or cur[k]
            keep["cci"] = keep["cci"] or cur["cci"]
            best[r["rule_id"]] = keep
        else:
            for k in ("severity", "cce"):
                cur[k] = cur[k] or r[k]
            cur["cci"] = cur["cci"] or r["cci"]
    if len(best) > MAX_RESULTS_PER_SCAN:
        raise ScanFileError(f"input {input_no}: a scan has more than {MAX_RESULTS_PER_SCAN} distinct rules")
    results: list[dict] = []
    for rule_id in sorted(best):
        r = best[rule_id]
        item: dict[str, Any] = {"rule_id": rule_id}
        if r["cce"]:
            item["cce"] = r["cce"]
        if r["cci"]:
            item["cci"] = r["cci"]
        item["result"] = r["result"]
        if r["severity"]:
            item["severity"] = r["severity"]
        title = clean_line(titles.get(rule_id), 512)
        if title is not None:
            item["title"] = title
        results.append(item)
    return results


def expand_inputs(paths: Sequence[str]) -> list[Path]:
    """Files as given, directories as their *.xml files (sorted). Errors name the argument number, not the path."""
    out: list[Path] = []
    for n, raw in enumerate(paths, 1):
        p = Path(raw)
        if p.is_dir():
            out.extend(sorted(c for c in p.iterdir() if c.is_file() and c.suffix.lower() == ".xml"))
        elif p.is_file():
            out.append(p)
        else:
            raise ScanFileError(f"--input argument {n} is not a file or a directory")
    return out


def read_xccdf_file(path: Path, input_no: int) -> list[tuple[str, dict, dict]]:
    """(agent_id, host identity, scan) per TestResult that carries rule results."""
    try:
        size = path.stat().st_size
        if size > MAX_INPUT_BYTES:
            raise ScanFileError(f"input {input_no}: refused, larger than {MAX_INPUT_BYTES // (1024 * 1024)} MiB")
        data = path.read_bytes()
    except OSError as err:
        raise ScanFileError(f"input {input_no} cannot be read ({type(err).__name__})") from None
    if len(data) > MAX_INPUT_BYTES:
        raise ScanFileError(f"input {input_no}: refused, larger than {MAX_INPUT_BYTES // (1024 * 1024)} MiB")
    if data[:2] in (b"\xff\xfe", b"\xfe\xff") or b"\x00" in data[:4]:
        raise ScanFileError(f"input {input_no}: refused, only UTF-8 (or ASCII / ISO-8859-1) XML is accepted")
    if _FORBIDDEN.search(data):
        raise ScanFileError(f"input {input_no}: refused, DOCTYPE and ENTITY declarations are not allowed")
    sha256 = hashlib.sha256(data).hexdigest()
    try:
        parsed = _parse(data)
    except ET.ParseError:
        raise ScanFileError(f"input {input_no} is not well-formed XML") from None
    found = [r for r in (_scan_and_host(res, parsed, sha256, input_no) for res in parsed.results) if r is not None]
    log.info("input %d: sha256 %s, %d scan(s), %d rule result(s)", input_no, sha256[:12], len(found),
             sum(len(s["results"]) for _, _, s in found))
    return found


def read_xccdf(paths: Sequence[Path]) -> list[dict]:
    """Configuration-only hosts (agent_id, identity, `configuration`) from every input, sorted by agent_id."""
    hosts: dict[str, dict] = {}
    keys: dict[str, set[tuple]] = {}
    for n, path in enumerate(paths, 1):
        for agent_id, identity, scan in read_xccdf_file(path, n):
            host = hosts.get(agent_id)
            if host is None:
                host = hosts[agent_id] = {**identity, "configuration": []}
                keys[agent_id] = set()
            else:
                for k, v in identity.items():
                    host.setdefault(k, v)
            key = (scan["benchmark"]["id"], scan.get("profile", {}).get("id", ""), scan["scanned_at"])
            if key in keys[agent_id]:
                continue  # the same scan supplied twice
            keys[agent_id].add(key)
            host["configuration"].append(scan)
    out: list[dict] = []
    for agent_id in sorted(hosts):
        host = hosts[agent_id]
        host["configuration"].sort(key=lambda s: (s["scanned_at"], s["benchmark"]["id"], s.get("profile", {}).get("id", "")))
        if len(host["configuration"]) > MAX_SCANS_PER_HOST:
            raise ScanFileError(f"a host has more than {MAX_SCANS_PER_HOST} scans across the inputs")
        out.append(host)
    if not out:
        raise ScanFileError("no XCCDF TestResult with results was found; nothing was sent")
    return out
