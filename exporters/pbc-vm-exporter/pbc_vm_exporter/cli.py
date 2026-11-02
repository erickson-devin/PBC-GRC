"""Command line entry point.

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

from .action1 import Action1Reader, group_action1, load_action1_sample
from .adapter import build_config_payloads, build_payloads, encode_payload
from .client import IngestClient
from .config import SOURCES, VENDOR_SOURCES, Config, RedactingFilter, load_config, redact
from .detect import resolve_mode
from .errors import (
    Action1ReadError, ConfigError, ExporterError, PayloadValidationError, ScanFileError, SentinelOneReadError,
    WazuhReadError,
)
from .sentinelone import SentinelOneReader, group_sentinelone, load_sentinelone_sample
from .validate import contract_sha256, validate_payload
from .wazuh_api import ApiReader
from .wazuh_indexer import IndexerReader, group_documents
from .xccdf import expand_inputs, read_xccdf

log = logging.getLogger("pbc_vm_exporter")

SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "indexer_sample.json"
XCCDF_SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "xccdf_sample.xml"
ACTION1_SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "action1_sample.json"
SENTINELONE_SAMPLE_PATH = Path(__file__).resolve().parent / "samples" / "sentinelone_sample.json"

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
        "password.",
        allow_abbrev=False,
    )
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
    parser.add_argument("--print-contract-sha256", action="store_true", help="print the sha256 of the vendored contract")
    parser.add_argument("--sample", action="store_true", help="use the bundled synthetic data (requires --dry-run)")
    return parser


def load_sample_hosts() -> list[dict]:
    data = json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
    return group_documents([h["_source"] for h in data["hits"]["hits"]])


def read_action1_hosts(cfg: Config) -> list[dict]:
    """Reads the canonical raw hosts from Action1 (every error is an Action1ReadError, never a partial list)."""
    assert cfg.action1 is not None
    return Action1Reader(cfg.action1, cfg.timeout).fetch_hosts()


def read_sentinelone_hosts(cfg: Config) -> list[dict]:
    """Reads the canonical raw hosts from SentinelOne (every error is a SentinelOneReadError, never a partial list)."""
    assert cfg.sentinelone is not None
    return SentinelOneReader(cfg.sentinelone, cfg.timeout).fetch_hosts()


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
        stderr.write(f"partial export: {len(skipped)} host(s) skipped\n")
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

    vendor = args.source in VENDOR_SOURCES  # vendor cloud sources: logs and exit-7 stderr carry counts, never ids
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

    label = cfg.source_label or f"sample-{args.source}"
    payloads, stats = build_payloads(
        raw_hosts, label=label, kind=KINDS[args.source], max_hosts=cfg.max_hosts, max_findings=cfg.max_findings,
        max_bytes=cfg.max_bytes, name_hosts=not vendor,
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
            "findings": sum(len(h["findings"]) for h in p["hosts"]),
        }
        for body, p in zip(bodies, payloads)
    ]
    if stats.skipped_hosts:
        if vendor:
            log.warning("%d host(s) skipped whole", len(stats.skipped_hosts))
        else:
            log.warning("%d host(s) skipped whole: %s", len(stats.skipped_hosts), ", ".join(stats.skipped_hosts))
    if stats.dropped_rows:
        log.warning("%d row(s) dropped (unusable vulnerability id)", stats.dropped_rows)
    if not payloads:
        raise (VENDOR_ERRORS[args.source] if vendor else WazuhReadError)("no host could be exported; nothing was sent")

    if args.dry_run:
        out = {
            "contract_sha256": contract_sha256(),
            "chunks": [dict(meta, payload=p) for meta, p in zip(metas, payloads)],
            "skipped_hosts": len(stats.skipped_hosts) if vendor else stats.skipped_hosts,
            "dropped_rows": stats.dropped_rows,
        }
        stdout.write(redact(json.dumps(out, indent=2), cfg.secrets()) + "\n")
        return 0

    assert cfg.pbc_url is not None and cfg.pbc_token is not None
    client = IngestClient(cfg.pbc_url, cfg.pbc_token, cfg.pbc_verify, cfg.timeout)
    client.send_all(bodies, metas)
    if stats.skipped_hosts:
        if vendor:
            stderr.write(f"partial export: {len(stats.skipped_hosts)} host(s) skipped\n")
        else:
            stderr.write("partial export: skipped agent ids: " + ", ".join(stats.skipped_hosts) + "\n")
        return 7
    return 0


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
