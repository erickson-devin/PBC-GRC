"""Command line entry point. Subcommands: `check` (test the connections) and `init` (create the env file).

Sources: wazuh (default), xccdf (XCCDF / ARF files), action1 and sentinelone (vendor cloud APIs).

Exit codes: 0 success, 2 configuration, 3 source read error (Wazuh, Action1 or SentinelOne, including a run that reads
zero hosts) or an unreadable / refused XCCDF / ARF file (including inputs with no results), 4 payload validation, 5 rejected by PBC-GRC, 6 transport or hash mismatch, 7 partial (every POST succeeded but hosts were
skipped), 130 interrupted, 1 unexpected. There is deliberately no option that accepts a token or a password.
"""

import argparse
import hashlib
import json
import logging
import os
import sys
from pathlib import Path
from typing import Mapping, Sequence, TextIO

import requests

from . import __version__
from .action1 import Action1Reader, group_action1, load_action1_sample
from .adapter import build_config_payloads, build_payloads, encode_payload, normalize_agent_id
from .client import IngestClient
from .config import SOURCES, VENDOR_SOURCES, Config, RedactingFilter, load_config, redact
from .detect import resolve_mode
from .diagnose import HINT_INDEXER_REDIRECT, HINT_INDEXER_ROLES, classify, insecure_flag_note
from .errors import (
    Action1ReadError, ConfigError, ExporterError, PayloadValidationError, ScanFileError, SentinelOneReadError,
    WazuhReadError,
)
from .init import build_init_parser, run_init
from .sentinelone import SentinelOneReader, group_sentinelone, load_sentinelone_sample
from .transport import make_session
from .validate import contract_sha256, validate_payload
from .wazuh_api import ApiReader
from .wazuh_indexer import INVENTORY_KINDS, IndexerReader, group_documents, group_inventory
from .xccdf import expand_inputs, read_xccdf

log = logging.getLogger("pbc_vm_exporter")

SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "indexer_sample.json"
XCCDF_SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "xccdf_sample.xml"
ACTION1_SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "action1_sample.json"
SENTINELONE_SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "sentinelone_sample.json"
INVENTORY_SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "indexer_inventory_sample.json"

KINDS = {"wazuh": "WAZUH", "action1": "ACTION1", "sentinelone": "SENTINELONE"}
VENDOR_NAMES = {"action1": "Action1", "sentinelone": "SentinelOne"}
VENDOR_ERRORS = {"action1": Action1ReadError, "sentinelone": SentinelOneReadError}


class _UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message: str):  # argparse would print the usage and exit; main() turns this into exit code 2
        raise _UsageError(message)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="pbc-vm-exporter",
        description="Reads vulnerability state from Wazuh, Action1 or SentinelOne (or XCCDF / ARF result files) and pushes "
        "it to PBC-GRC. Configuration comes from the environment or an env file; there is no option for a token or "
        "password. Run `pbc-vm-exporter init` to create the env file and `pbc-vm-exporter check` to test the connections "
        "(PBC-GRC, Wazuh) without sending anything.",
        allow_abbrev=False,
    )
    parser.add_argument("--version", action="version", version=f"pbc-vm-exporter {__version__}")
    parser.add_argument("--dry-run", action="store_true", help="build and validate the payloads, print them, send nothing")
    parser.add_argument("--env-file", metavar="PATH", help="KEY=value file (default: ./.env if present)")
    parser.add_argument(
        "--mode", choices=("auto", "indexer", "api"), help="Wazuh reader (overrides WAZUH_MODE; --source wazuh only)"
    )
    parser.add_argument(
        "--source", choices=SOURCES, default="wazuh",
        help="wazuh (default): read Wazuh vulnerability state; xccdf: read XCCDF / ARF result files (needs --input); "
        "action1: read missing updates from Action1; sentinelone: read vulnerabilities from SentinelOne",
    )
    parser.add_argument(
        "--input", metavar="PATH", action="append", default=[],
        help="XCCDF 1.1/1.2 or ARF result file, or a directory of *.xml files (repeatable; --source xccdf only)",
    )
    parser.add_argument(
        "--skipped-report", metavar="PATH",
        help="on a partial export (exit 7) write the skipped agent ids to this file, one per line, owner-only; "
        "the log and stderr carry counts only",
    )
    parser.add_argument("--print-contract-sha256", action="store_true", help="print the sha256 of the vendored contract")
    parser.add_argument("--sample", action="store_true", help="use the bundled synthetic data (requires --dry-run)")
    return parser


def load_sample_hosts() -> list[dict]:
    data = json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
    return group_documents([h["_source"] for h in data["hits"]["hits"]])


def load_sample_inventory() -> dict[str, dict]:
    data = json.loads(INVENTORY_SAMPLE_PATH.read_text(encoding="utf-8"))
    return group_inventory({kind: data.get(kind) or [] for kind in INVENTORY_KINDS})


def should_send_inventory(setting: str, features: Sequence[str] | None) -> bool:
    """`true` and `false` are absolute; `auto` follows what the server advertises (`features` is None when there is no
    server to ask, a dry run, and auto then includes the inventory so the output shows what a real run would send)."""
    if setting == "true":
        return True
    if setting == "false":
        return False
    return features is None or "inventory" in features


def read_inventory(cfg: Config) -> dict[str, dict]:
    """Host inventory from the Wazuh indexer (every error is a WazuhReadError, never a partial result)."""
    if not cfg.indexer_url:
        raise ConfigError("WAZUH_INDEXER_URL is required to read the inventory")
    return IndexerReader(
        cfg.indexer_url, cfg.indexer_user, cfg.indexer_password, cfg.wazuh_verify, cfg.timeout, index=cfg.indexer_index,
    ).fetch_inventory()


def wants_inventory(args: argparse.Namespace, cfg: Config) -> bool:
    """Whether this run reads and sends the Wazuh host inventory. The server is asked (whoami) only for `auto`."""
    if cfg.send_inventory == "false":
        return False
    if args.sample:
        return True
    if cfg.wazuh_mode == "api":
        log.info("host inventory is read from the Wazuh indexer: skipped in api mode")
        return False
    if not cfg.indexer_url:
        return False
    if args.dry_run:
        return should_send_inventory(cfg.send_inventory, None)
    if cfg.send_inventory == "auto":
        assert cfg.pbc_url is not None and cfg.pbc_token is not None
        features = IngestClient(cfg.pbc_url, cfg.pbc_token, cfg.pbc_verify, cfg.timeout).features()
        if not should_send_inventory("auto", features):
            log.info("this PBC-GRC does not advertise host inventory: sending vulnerabilities only "
                     "(PBC_SEND_INVENTORY=true forces it)")
            return False
        return True
    return True


def attach_inventory(raw_hosts: list[dict], inventory: dict[str, dict]) -> list[dict]:
    """Adds each host's inventory to its raw host; an agent that only the inventory knows becomes an inventory-only host
    (no findings key, so it never takes part in closure). The input list and its hosts are not changed."""
    out: list[dict] = []
    known: set[str] = set()
    for raw in raw_hosts:
        agent = normalize_agent_id(raw.get("agent_id"))
        if agent is not None:
            known.add(agent)
        inv = inventory.get(agent) if agent is not None else None
        out.append(dict(raw, inventory=inv) if inv else raw)
    for agent in sorted(inventory):
        if normalize_agent_id(agent) is None or agent in known:
            continue
        out.append({
            "agent_id": agent, "hostname": inventory[agent].get("agent_name"), "rows": [],
            "inventory": inventory[agent], "inventory_only": True,
        })
    return out


def read_action1_hosts(cfg: Config) -> list[dict]:
    """Reads the canonical raw hosts from Action1 (every error is an Action1ReadError, never a partial list)."""
    assert cfg.action1 is not None
    return Action1Reader(cfg.action1, cfg.timeout).fetch_hosts()


def read_sentinelone_hosts(cfg: Config) -> list[dict]:
    """Reads the canonical raw hosts from SentinelOne (every error is a SentinelOneReadError, never a partial list)."""
    assert cfg.sentinelone is not None
    return SentinelOneReader(cfg.sentinelone, cfg.timeout).fetch_hosts()


def _report_skipped(args: argparse.Namespace, skipped: list[str], stderr: TextIO) -> None:
    """Exit-7 reporting: a count on stderr, the agent ids only in the file the operator named with --skipped-report
    (one per line, created owner-only: 0600 on POSIX; on Windows the file takes the folder's ACL)."""
    if not skipped:
        return
    if args.skipped_report:
        fd = os.open(args.skipped_report, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("".join(f"{agent_id}\n" for agent_id in skipped))
        stderr.write(f"partial export: {len(skipped)} host(s) skipped (agent ids written to {args.skipped_report})\n")
    else:
        stderr.write(f"partial export: {len(skipped)} host(s) skipped (--skipped-report PATH lists the agent ids)\n")


def _run_xccdf(args: argparse.Namespace, cfg: Config, stdout: TextIO, stderr: TextIO) -> int:
    """Configuration results from XCCDF / ARF files. Nothing here names a file, host, address or agent id."""
    paths = [XCCDF_SAMPLE_PATH] if args.sample else expand_inputs(args.input)
    hosts = read_xccdf(paths)
    label = cfg.source_label or "sample-scap"
    payloads, skipped = build_config_payloads(
        hosts, label=label, max_hosts=cfg.max_hosts, max_bytes=cfg.max_bytes
    )
    bodies = [encode_payload(p) for p in payloads]
    for i, body in enumerate(bodies):
        error = validate_payload(json.loads(body))
        if error is not None:
            raise PayloadValidationError(f"chunk {i + 1}/{len(bodies)} does not satisfy the contract: {error}")
    metas = [
        {
            "sha256": hashlib.sha256(body).hexdigest(),
            "bytes": len(body),
            "hosts": len(p["hosts"]),
            "findings": 0,
            "results": sum(len(s["results"]) for h in p["hosts"] for s in h["configuration"]),
        }
        for body, p in zip(bodies, payloads)
    ]
    if skipped:
        log.warning("%d host(s) skipped whole: too large to send in one payload", len(skipped))
    if not payloads:
        raise ScanFileError("no host could be exported; nothing was sent")

    if args.dry_run:
        out = {
            "contract_sha256": contract_sha256(),
            "chunks": [dict(meta, payload=p) for meta, p in zip(metas, payloads)],
            "skipped_hosts": len(skipped),
        }
        stdout.write(redact(json.dumps(out, indent=2), cfg.secrets()) + "\n")
        return 0

    assert cfg.pbc_url is not None and cfg.pbc_token is not None
    client = IngestClient(cfg.pbc_url, cfg.pbc_token, cfg.pbc_verify, cfg.timeout)
    client.send_all(bodies, metas)
    if skipped:
        _report_skipped(args, skipped, stderr)
        return 7
    return 0


def read_hosts(cfg: Config) -> list[dict]:
    """Reads the canonical raw hosts from Wazuh in the resolved mode."""
    api_reader = None
    if cfg.wazuh_mode in ("auto", "api"):
        if not cfg.api_url:
            raise ConfigError("WAZUH_API_URL is required for this mode")
        api_reader = ApiReader(cfg.api_url, cfg.api_user, cfg.api_password, cfg.wazuh_verify, cfg.timeout)
    mode, _manager = resolve_mode(cfg, api_reader)
    if mode == "indexer":
        if not cfg.indexer_url:
            raise ConfigError("WAZUH_INDEXER_URL is required for indexer mode")
        return IndexerReader(
            cfg.indexer_url, cfg.indexer_user, cfg.indexer_password, cfg.wazuh_verify, cfg.timeout,
            index=cfg.indexer_index,
        ).fetch_hosts()
    if api_reader is None:
        raise ConfigError("WAZUH_API_URL is required for api mode")
    return api_reader.fetch_hosts()


def _run(args: argparse.Namespace, environ: Mapping[str, str], stdout: TextIO, stderr: TextIO, flt: RedactingFilter) -> int:
    cfg = load_config(
        environ, args.env_file, mode_override=args.mode, dry_run=args.dry_run, sample=args.sample, source=args.source
    )
    flt.secrets = cfg.secrets()
    if args.source == "xccdf":
        return _run_xccdf(args, cfg, stdout, stderr)

    vendor = args.source in VENDOR_SOURCES  # vendor cloud sources: their own error types and zero-host messages
    send_inventory = args.source == "wazuh" and wants_inventory(args, cfg)
    if args.source == "action1":
        raw_hosts = group_action1(load_action1_sample(ACTION1_SAMPLE_PATH)) if args.sample else read_action1_hosts(cfg)
    elif args.source == "sentinelone":
        raw_hosts = (
            group_sentinelone(*load_sentinelone_sample(SENTINELONE_SAMPLE_PATH))
            if args.sample else read_sentinelone_hosts(cfg)
        )
    else:
        raw_hosts = load_sample_hosts() if args.sample else read_hosts(cfg)
    if not raw_hosts:
        if vendor:
            raise VENDOR_ERRORS[args.source](
                f"{VENDOR_NAMES[args.source]} returned zero hosts with findings; nothing was sent "
                "(an empty export would hide a read failure)"
            )
        raise WazuhReadError("Wazuh returned zero hosts; nothing was sent (an empty export would hide a read failure)")
    if send_inventory:
        try:
            inventory = load_sample_inventory() if args.sample else read_inventory(cfg)
        except WazuhReadError:  # the inventory is optional: counts only, and the vulnerabilities still go out
            log.warning("the Wazuh host inventory could not be read: sending vulnerabilities only")
            inventory = {}
        raw_hosts = attach_inventory(raw_hosts, inventory)

    label = cfg.source_label or f"sample-{args.source}"
    payloads, stats = build_payloads(
        raw_hosts, label=label, kind=KINDS[args.source], max_hosts=cfg.max_hosts, max_findings=cfg.max_findings,
        max_bytes=cfg.max_bytes, name_hosts=False,  # every source: the log carries counts, never agent ids (#219)
    )
    # Validate exactly the bytes that would go on the wire, and only then send anything.
    bodies = [encode_payload(p) for p in payloads]
    for i, body in enumerate(bodies):
        error = validate_payload(json.loads(body))
        if error is not None:
            raise PayloadValidationError(f"chunk {i + 1}/{len(bodies)} does not satisfy the contract: {error}")
    metas = [
        {
            "sha256": hashlib.sha256(body).hexdigest(),
            "bytes": len(body),
            "hosts": len(p["hosts"]),
            "findings": sum(len(h.get("findings", [])) for h in p["hosts"]),
            **({"software": sum(len(h.get("software", [])) for h in p["hosts"])} if send_inventory else {}),
        }
        for body, p in zip(bodies, payloads)
    ]
    if send_inventory:
        sent = [h for p in payloads for h in p["hosts"]]
        log.info(
            "inventory: %d host(s) with hardware, %d host(s) with software (%d items), %d inventory-only host(s)",
            sum("hardware" in h for h in sent), sum("software" in h for h in sent),
            sum(len(h.get("software", [])) for h in sent), sum("findings" not in h for h in sent),
        )
        if stats.software_overflow_hosts:
            log.warning("%d host(s) have more than 10000 software items: their software list was not sent",
                        stats.software_overflow_hosts)
    if stats.skipped_hosts:
        log.warning("%d host(s) skipped whole", len(stats.skipped_hosts))
    if stats.dropped_rows:
        log.warning("%d row(s) dropped (unusable vulnerability id)", stats.dropped_rows)
    if not payloads:
        raise (VENDOR_ERRORS[args.source] if vendor else WazuhReadError)("no host could be exported; nothing was sent")

    if args.dry_run:
        out = {
            "contract_sha256": contract_sha256(),
            "chunks": [dict(meta, payload=p) for meta, p in zip(metas, payloads)],
            "skipped_hosts": len(stats.skipped_hosts),
            "dropped_rows": stats.dropped_rows,
        }
        stdout.write(redact(json.dumps(out, indent=2), cfg.secrets()) + "\n")
        return 0

    assert cfg.pbc_url is not None and cfg.pbc_token is not None
    client = IngestClient(cfg.pbc_url, cfg.pbc_token, cfg.pbc_verify, cfg.timeout)
    client.send_all(bodies, metas)
    if stats.skipped_hosts:
        _report_skipped(args, stats.skipped_hosts, stderr)
        return 7
    return 0


WHOAMI_PATH = "/api/v1/vm/whoami"
EMPTY_INDEX_HINT = (
    "the index is empty: vulnerability detection may be off in Wazuh, or WAZUH_INDEXER_INDEX names the wrong index "
    "(a run would stop with zero hosts); before Wazuh 4.8 there is no such index: use WAZUH_MODE=api"
)


def build_check_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="pbc-vm-exporter check",
        description="Tests the configuration, PBC-GRC (reachable, token, contract, size limit) and Wazuh (indexer and, "
        "where used, manager API). Sends no vulnerability data. Exit 0 when nothing failed.",
        allow_abbrev=False,
    )
    parser.add_argument("--env-file", metavar="PATH", help="KEY=value file (default: ./.env if present)")
    parser.add_argument("--mode", choices=("auto", "indexer", "api"), help="Wazuh reader (overrides WAZUH_MODE)")
    parser.add_argument("--source", choices=SOURCES, default="wazuh", help="source to check (default wazuh)")
    return parser


def _body(resp: object) -> dict:
    try:
        data = resp.json()  # type: ignore[attr-defined]
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _short(value: object, limit: int = 64) -> str:
    return " ".join(str(value).split())[:limit]


def _run_check(args: argparse.Namespace, environ: Mapping[str, str], stdout: TextIO, flt: RedactingFilter) -> int:
    """Step by step connection test. Prints PASS / FAIL / SKIP / NOTE lines with a hint; no secret and no payload."""
    counts = {"PASS": 0, "FAIL": 0, "SKIP": 0, "NOTE": 0}
    failures: list[int] = []
    number = 0
    server_inventory = False  # the server advertises inventory support (whoami features)
    role_problem = False  # the indexer refused a read (403) or answered 0 documents: show the roles it applied

    def emit(state: str, title: str, detail: str = "", hint: str = "", code: int = 1) -> None:
        nonlocal number
        number += 1
        counts[state] += 1
        line = f"[{state}] {number}. {title}" + (f": {detail}" if detail else "")
        stdout.write(redact(" ".join(line.split()), flt.secrets) + "\n")
        if hint:
            stdout.write(redact("       hint: " + hint, flt.secrets) + "\n")
        if state == "FAIL":
            failures.append(code)

    def finish() -> int:
        stdout.write(f"check: {counts['PASS']} passed, {counts['FAIL']} failed, {counts['SKIP']} skipped\n")
        return failures[0] if failures else 0

    try:
        cfg = load_config(
            environ, args.env_file, mode_override=args.mode, dry_run=False, sample=False, source=args.source
        )
    except ConfigError as err:
        flt.secrets = []
        emit("FAIL", "configuration loads", str(err), code=2)
        return finish()
    flt.secrets = cfg.secrets()
    emit("PASS", "configuration loads", f"source {args.source}")

    # PBC-GRC: reachable, token valid, same contract, size limit.
    assert cfg.pbc_url is not None and cfg.pbc_token is not None
    session = make_session()
    try:
        resp = session.get(
            cfg.pbc_url + WHOAMI_PATH, headers={"Authorization": f"Bearer {cfg.pbc_token}", "Accept": "application/json"},
            timeout=(10, cfg.timeout), verify=cfg.pbc_verify, allow_redirects=False,
        )
    except requests.RequestException as err:
        code, hint = classify(err, "pbc", cfg.pbc_url)
        emit("FAIL", "PBC-GRC is reachable", f"{type(err).__name__} ({code})", hint, 6)
        resp = None
    if resp is not None:
        status = resp.status_code
        data = _body(resp)
        if status == 200:
            token = data.get("token") if isinstance(data.get("token"), dict) else {}
            expires = token.get("expires_at")
            emit(
                "PASS", "PBC-GRC is reachable and the token is valid",
                f"token '{_short(token.get('name', ''))}' ({_short(token.get('prefix', ''))}), "
                f"expires {_short(expires) if expires else 'never'}",
            )
            server_sha = data.get("contract_sha256")
            if not isinstance(server_sha, str):
                emit("SKIP", "contract matches the server", "the server did not report its contract hash")
            elif server_sha == contract_sha256():
                emit("PASS", "contract matches the server")
            else:
                emit(
                    "FAIL", "contract matches the server", "the server's ingest contract differs from this exporter's",
                    "upgrade the exporter or the server so both match (--print-contract-sha256 shows this exporter's)", 4,
                )
            if args.source == "wazuh" and cfg.send_inventory != "false" and cfg.wazuh_mode != "api":
                features = data.get("features")
                if isinstance(features, list) and "inventory" in features:
                    server_inventory = True
                    emit("PASS", "PBC-GRC accepts inventory")
                else:
                    emit(
                        "NOTE", "PBC-GRC accepts inventory", "the server does not advertise it",
                        "upgrade PBC-GRC to send host hardware and software; until then only vulnerabilities are "
                        "sent (PBC_SEND_INVENTORY=false silences this)",
                    )
            limits = data.get("limits") if isinstance(data.get("limits"), dict) else {}
            max_bytes = limits.get("max_bytes")
            if not isinstance(max_bytes, int) or isinstance(max_bytes, bool):
                emit("SKIP", "payload size limit", "the server did not report its limit")
            elif cfg.max_bytes <= max_bytes:
                emit("PASS", "payload size limit", f"EXPORT_MAX_BYTES {cfg.max_bytes} <= server {max_bytes}")
            else:
                emit(
                    "FAIL", "payload size limit", f"EXPORT_MAX_BYTES {cfg.max_bytes} > server {max_bytes}",
                    "lower EXPORT_MAX_BYTES, or raise VM_INGEST_MAX_BYTES on the server", 5,
                )
        elif status == 404:
            emit("SKIP", "PBC-GRC token and contract", "server too old for check (it has no whoami endpoint)")
        elif 300 <= status < 400:
            emit("FAIL", "PBC-GRC is reachable", f"HTTP {status}", "redirect refused; set PBC_URL to the final https URL", 5)
        elif status in (401, 403) or 400 <= status < 500:
            server_code = data.get("code") if isinstance(data.get("code"), str) else ""
            code, hint = classify(f"HTTP {status} {server_code}", "pbc", cfg.pbc_url)
            emit("FAIL", "PBC-GRC accepts the token", f"HTTP {status} ({code})", hint, 5)
        else:
            emit("FAIL", "PBC-GRC is reachable", f"HTTP {status}", "retry later; check the server log", 6)

    # Wazuh: only for the wazuh source.
    urls: list[str | None] = [cfg.pbc_url, cfg.api_url, cfg.indexer_url]
    if cfg.action1 is not None:
        urls.append(cfg.action1.base_url)
    if cfg.sentinelone is not None:
        urls.append(cfg.sentinelone.console_url)
    if args.source != "wazuh":
        emit("SKIP", "Wazuh checks", f"not used by --source {args.source}")
    else:
        mode = cfg.wazuh_mode
        if mode == "api":
            emit("SKIP", "Wazuh indexer", "api mode does not use it")
        elif not cfg.indexer_url:
            if mode == "indexer":
                emit("FAIL", "Wazuh indexer", "WAZUH_INDEXER_URL is required for indexer mode", code=2)
            else:
                emit("SKIP", "Wazuh indexer", "WAZUH_INDEXER_URL is not set")
        else:
            reader = IndexerReader(
                cfg.indexer_url, cfg.indexer_user, cfg.indexer_password, cfg.wazuh_verify, cfg.timeout,
                index=cfg.indexer_index, session=session,
            )
            try:
                found = reader._call(
                    "post", f"{reader.url}/{reader.index}/_search", "search", json={"size": 0, "track_total_hits": True}
                )
                total = _body(found).get("hits", {}).get("total")
                count = total.get("value") if isinstance(total, dict) else total
                if not isinstance(count, int) or isinstance(count, bool):
                    emit("FAIL", "Wazuh indexer", "an unexpected response body", HINT_INDEXER_REDIRECT, 3)
                elif count == 0:
                    role_problem = True  # a cluster that does not fail on forbidden reports a missing permission as 0
                    emit("FAIL", "Wazuh indexer", "reachable, 0 documents", EMPTY_INDEX_HINT, 3)
                else:
                    emit("PASS", "Wazuh indexer", f"reachable, {count} documents")
            except WazuhReadError as err:
                role_problem = classify(str(err), "indexer", cfg.indexer_url)[0] == "indexer_role"
                emit("FAIL", "Wazuh indexer", str(err), code=3)
            if cfg.send_inventory == "true" or (cfg.send_inventory == "auto" and server_inventory):
                try:
                    hosts_with_inventory = reader.count_inventory_hosts()
                    if hosts_with_inventory is None:
                        emit("NOTE", "Wazuh inventory indices", "an unexpected response body")
                    elif hosts_with_inventory == 0:
                        emit(
                            "NOTE", "Wazuh inventory indices", "wazuh-states-inventory-system-* has 0 documents",
                            "needs Wazuh 4.14 or later with the inventory modules enabled and an indexer role with read "
                            "on wazuh-states-inventory-*; until then only vulnerabilities are sent",
                        )
                    else:
                        emit("PASS", "Wazuh inventory indices", f"{hosts_with_inventory} system documents")
                except WazuhReadError as err:
                    if classify(str(err), "indexer", cfg.indexer_url)[0] == "indexer_role":
                        role_problem = True
                    emit(
                        "NOTE", "Wazuh inventory indices", str(err),
                        "grant the indexer user read on wazuh-states-inventory-* to send host inventory",
                    )
            if role_problem:
                roles = reader.authinfo_roles()
                emit(
                    "NOTE", "indexer roles of this user",
                    "could not be read (GET /_plugins/_security/authinfo)" if roles is None else ", ".join(roles) or "none",
                    HINT_INDEXER_ROLES,
                )
        if mode == "indexer":
            emit("SKIP", "Wazuh manager API", "not needed in indexer mode")
        elif not cfg.api_url:
            emit(
                "FAIL", "Wazuh manager API", "WAZUH_API_URL is required for this mode",
                "set WAZUH_MODE=indexer to read the indexer only; auto and api modes also need WAZUH_API_URL, "
                "WAZUH_API_USER and WAZUH_API_PASSWORD", 2,
            )
        else:
            try:
                ApiReader(
                    cfg.api_url, cfg.api_user, cfg.api_password, cfg.wazuh_verify, cfg.timeout, session=session
                ).authenticate()
                emit("PASS", "Wazuh manager API", "authenticated")
            except WazuhReadError as err:
                code, hint = classify(str(err), "manager", cfg.api_url)
                emit("FAIL", "Wazuh manager API", str(err), hint, 3)

    note = insecure_flag_note(cfg.allow_insecure, urls)
    if note is not None:
        emit("NOTE", "PBC_ALLOW_INSECURE_TRANSPORT", "set but not needed", note[1])
    elif cfg.allow_insecure:
        emit("NOTE", "PBC_ALLOW_INSECURE_TRANSPORT", "in use for a plain http URL (development only)")
    return finish()


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    stdout = stdout if stdout is not None else sys.stdout
    stderr = stderr if stderr is not None else sys.stderr
    environ = environ if environ is not None else os.environ

    def fail(message: str, secrets: Sequence[str] = ()) -> None:
        stderr.write("error: " + redact(" ".join(str(message).split()), secrets) + "\n")

    handler = logging.StreamHandler(stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    flt = RedactingFilter()
    handler.addFilter(flt)
    previous_level = log.level
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    try:
        arglist = list(sys.argv[1:] if argv is None else argv)
        if arglist and arglist[0] == "check":  # the one subcommand; anything else positional is still refused below
            try:
                check_args, check_extras = build_check_parser().parse_known_args(arglist[1:])
                if check_extras:
                    names = [e.split("=", 1)[0] for e in check_extras if e.startswith("-")]
                    raise _UsageError(
                        "unrecognized option(s): " + (", ".join(names) or "(positional arguments are not accepted)")
                    )
            except _UsageError as err:
                fail(str(err))
                return 2
            except SystemExit as err:  # --help
                return err.code if isinstance(err.code, int) else 0
            return _run_check(check_args, environ, stdout, flt)
        if arglist and arglist[0] == "init":  # the other subcommand: creates the env file
            try:
                init_args, init_extras = build_init_parser().parse_known_args(arglist[1:])
                if init_extras:
                    names = [e.split("=", 1)[0] for e in init_extras if e.startswith("-")]
                    raise _UsageError(
                        "unrecognized option(s): " + (", ".join(names) or "(positional arguments are not accepted)")
                    )
            except _UsageError as err:
                fail(str(err))
                return 2
            except SystemExit as err:  # --help
                return err.code if isinstance(err.code, int) else 0
            return run_init(init_args, stdout, stderr, flt)
        try:
            args, extras = build_parser().parse_known_args(argv)
            if extras:
                # Name the unknown options only: an unknown --token must not echo the value that follows it.
                names = [e.split("=", 1)[0] for e in extras if e.startswith("-")]
                raise _UsageError("unrecognized option(s): " + (", ".join(names) or "(positional arguments are not accepted)"))
        except _UsageError as err:
            fail(str(err))
            return 2
        except SystemExit as err:  # --help
            return err.code if isinstance(err.code, int) else 0
        if args.print_contract_sha256:
            stdout.write(contract_sha256() + "\n")
            return 0
        if args.mode and args.source in VENDOR_SOURCES:
            fail("--mode applies to --source wazuh only")
            return 2
        if args.source != "xccdf" and args.input:
            fail("--input requires --source xccdf")
            return 2
        if args.source == "xccdf" and args.sample == bool(args.input):
            fail("--source xccdf needs either --input PATH or --sample (not both)")
            return 2
        if args.sample and not args.dry_run:
            fail("--sample requires --dry-run (synthetic hosts must never reach a real tenant)")
            return 2
        return _run(args, environ, stdout, stderr, flt)
    except ExporterError as err:
        fail(str(err), flt.secrets)
        return err.exit_code
    except KeyboardInterrupt:
        fail("interrupted")
        return 130
    except Exception as err:  # no traceback and no locals: they could carry secrets
        fail(f"unexpected {type(err).__name__}: {err}", flt.secrets)
        return 1
    finally:
        log.removeHandler(handler)
        log.setLevel(previous_level)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
