# pbc-vm-exporter

Reads vulnerability state from Wazuh and pushes it to PBC-GRC (`POST /api/v1/vm/ingest`).

## 1. What it is

A push-model exporter. It runs inside the enclave next to Wazuh, reads Wazuh, builds payloads that satisfy the ingest contract (`server/vm/ingest.schema.json`) and POSTs them to PBC-GRC with a service token.

* It is not part of the PBC-GRC application image.
* Data goes only to PBC-GRC. There is no other egress, and proxy settings from the environment (`HTTP_PROXY`, `HTTPS_PROXY`, `.netrc`, `REQUESTS_CA_BUNDLE`) are ignored on purpose (`trust_env=False`).
* AI is not involved.

## 2. Requirements and install

Python 3.11 or later and `requests`.

```
python -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"          # Windows: .venv\Scripts\python.exe
```

Offline or air-gapped hosts: on a connected machine run `pip download -d wheelhouse "requests>=2.31" setuptools`, copy the folder over, then `pip install --no-index --find-links wheelhouse -e .` (add `--no-build-isolation` if setuptools is already present).

Running without installing (only `requests` is needed):

```
cd exporters/pbc-vm-exporter
python -m pbc_vm_exporter --help
python -m pytest -q          # needs pytest
```

## 3. Configuration

Everything comes from the environment or from an env file (`--env-file PATH`, default `./.env` if it exists). The environment wins over the file. **There is no command-line option for a token or a password.**

| Variable | Required | Meaning |
| --- | --- | --- |
| `PBC_URL` | yes (not for `--dry-run`) | Base URL of PBC-GRC, `https://...` |
| `PBC_SERVICE_TOKEN` | yes (not for `--dry-run`) | Service token, `pbcvm_` plus 43 characters |
| `PBC_SOURCE_LABEL` | yes (not for `--sample`) | Source label, 1 to 128 characters, no control characters. No default: keep it stable (see Limitations) |
| `PBC_CA_BUNDLE` | no | CA bundle file for PBC-GRC's certificate |
| `PBC_ALLOW_INSECURE_TRANSPORT` | no | `true`, `1`, `yes` or `on` allows plain `http://`. Development only; logs a warning |
| `WAZUH_MODE` | no | `auto` (default), `indexer` or `api`. `--mode` wins |
| `WAZUH_INDEXER_URL`, `WAZUH_INDEXER_USER`, `WAZUH_INDEXER_PASSWORD` | indexer mode | Wazuh indexer (Wazuh 4.8 and later) |
| `WAZUH_INDEXER_INDEX` | no | Default `wazuh-states-vulnerabilities-*` |
| `WAZUH_API_URL`, `WAZUH_API_USER`, `WAZUH_API_PASSWORD` | api and auto mode | Wazuh manager API (4.7 and earlier; also used by `auto` to read the version) |
| `WAZUH_CA_BUNDLE` | no | CA bundle file for the Wazuh certificates |
| `EXPORT_MAX_HOSTS_PER_REQUEST` | no | Hosts per POST, default 500, range 1..1000 |
| `EXPORT_MAX_FINDINGS_PER_REQUEST` | no | Findings per POST, default 50000, range 1..50000 |
| `EXPORT_MAX_BYTES` | no | Body bytes per POST, default 33554432 (32 MiB), range 1048576..104857600. Lower it if the server's `VM_INGEST_MAX_BYTES` is below 32 MiB |
| `EXPORT_TIMEOUT_SECONDS` | no | Read timeout, default 60, range 5..600 |

URLs must be `https` and must not contain credentials, a query or a fragment. A number that is not a positive integer falls back to the default with a warning; a number outside its range is clamped.

Env file format: `KEY=value`, an optional `export ` prefix, full-line `#` comments, blank lines. There are no inline comments (a `#` inside a password survives), one pair of matching outer quotes is stripped, and there is no interpolation. A malformed line is reported by number only; its content is never echoed.

A run splits a large fleet across several POSTs by hosts, findings and bytes. A host is never split between two POSTs and never shortened.

## 4. Choosing a mode

* `auto` reads `GET /` on the manager API and picks `indexer` for Wazuh 4.8 and later, `api` for 4.x before 4.8. Anything else (3.x, an unreadable version) is a configuration error: set `WAZUH_MODE`.
* `indexer` reads the `wazuh-states-vulnerabilities-*` index (scroll pagination, so it works on every OpenSearch version). Give it a read-only indexer role limited to that index pattern.
* `api` reads `/agents` and `/vulnerability/{id}` from the manager API. An agent that never connected, or has no completed scan, is not reported. A scanned agent with no vulnerabilities is reported with an empty findings list, which is correct: its findings close.

All Wazuh field names and endpoints are from knowledge of Wazuh 4.x, not from a running system. They live in one dictionary per source (`INDEXER_FIELDS` in `wazuh_indexer.py`, `API_FIELDS` in `wazuh_api.py`). Verify them against your running Wazuh before the first live push; a wrong guess is a one-line fix.

## 5. Creating the service token

A TENANT_OWNER or MSP_ADMIN creates it with `POST /api/v1/tenants/:tenantId/vm/tokens` over HTTPS. The token is shown once. The default expiry is 365 days: rotate before it expires. See `docs/VULNERABILITY_MANAGEMENT.md`.

## 6. TLS requirements

* TLS must be terminated in front of PBC-GRC and `TRUST_PROXY` set on the server (`docs/VULNERABILITY_MANAGEMENT.md`, section 2).
* Private CAs: set `PBC_CA_BUNDLE` and `WAZUH_CA_BUNDLE` to the CA file (Wazuh's default root CA is `root-ca.pem` under its certificates directory; verify the path on your install).
* Certificate verification cannot be turned off. There is no such option. Default Wazuh certificates may not match the host name you use to reach Wazuh: reissue the certificates with the right names (or point the exporter at a name they cover) and supply the CA bundle. `PBC_ALLOW_INSECURE_TRANSPORT` only allows plain `http://` for development; it does not skip certificate checks.

## 7. Exporter-host security

* The token lives only in the environment or in an env file at mode `0600` owned by the service account (or root). There is no `--token` flag, because command-line arguments are visible to other users (`ps`, `/proc`) and end up in shell history. The exporter warns when an env file is readable by group or others (`chmod 600`).
* The exporter host is inside the CUI enclave, so the organization's patching, hardening and logging requirements apply to it like any other enclave host.
* Logs are redacted (tokens, bearer values, JWTs, URL credentials, configured passwords), but `--dry-run` output contains hostnames and the CVE inventory. Treat it as CUI and do not paste it outside the enclave. The exporter never writes a payload to disk.
* Revoke the token when the exporter is decommissioned (`POST /api/v1/tenants/:tenantId/vm/tokens/:id/revoke`).

## 8. Running on a schedule

### systemd (Linux)

Create a dedicated unprivileged user and a root-managed env file:

```
useradd --system --no-create-home --shell /usr/sbin/nologin pbc-vm-exporter
install -d -m 0750 -o root -g pbc-vm-exporter /etc/pbc-vm-exporter
install -m 0600 -o pbc-vm-exporter -g pbc-vm-exporter /dev/null /etc/pbc-vm-exporter/env
```

`/etc/systemd/system/pbc-vm-exporter.service`:

```
[Unit]
Description=Push Wazuh vulnerability state to PBC-GRC

[Service]
Type=oneshot
User=pbc-vm-exporter
EnvironmentFile=/etc/pbc-vm-exporter/env
ExecStart=/opt/pbc-vm-exporter/.venv/bin/python -m pbc_vm_exporter
WorkingDirectory=/opt/pbc-vm-exporter
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
```

`/etc/systemd/system/pbc-vm-exporter.timer`:

```
[Unit]
Description=Daily PBC-GRC vulnerability export

[Timer]
OnCalendar=daily
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
```

Daily matches the server's expected interval of 1440 minutes (`docs/VULNERABILITY_MANAGEMENT.md`). Enable with `systemctl enable --now pbc-vm-exporter.timer`.

### Windows Task Scheduler

Run the task as a dedicated low-privilege service account. Store the token in that account's user environment (run this as that account: `[Environment]::SetEnvironmentVariable('PBC_SERVICE_TOKEN', '...', 'User')`), or in an env file whose ACL grants only that account. The action is `python.exe -m pbc_vm_exporter` with **no secrets in the arguments** (task arguments are readable by other users). Trigger daily and enable "Run whether user is logged on or not".

## 9. Contract parity

`pbc_vm_exporter/contract/ingest.schema.json` is a byte copy of `server/vm/ingest.schema.json` (LF only). The exporter validates every payload against it, with a stdlib validator that mirrors the server (first-error order, messages, UTF-16 lengths), before anything is sent.

```
python -m pbc_vm_exporter --print-contract-sha256
sha256sum ../../server/vm/ingest.schema.json
```

The two values must be equal; tests and the Node test suite check it. Contract changes land in the server first, then the file is copied here. The validator refuses (in the tests) a schema keyword it does not implement.

## 10. Dry run and sample

* `--dry-run` builds and validates the payloads, prints one JSON document to stdout and sends nothing: `{"contract_sha256", "chunks": [{"sha256", "bytes", "hosts", "findings", "payload"}], "skipped_hosts", "dropped_rows"}`. The `sha256` is that of the real bytes that would be sent. The output goes through redaction.
* `--sample` (requires `--dry-run`) uses the bundled synthetic Wazuh data (`samples/indexer_sample.json`, fake hostnames and public CVE ids) and needs no Wazuh or PBC-GRC configuration. It can never reach a tenant.
* `--print-contract-sha256` prints the contract hash and exits.

## 11. Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error (one redacted line, no traceback) |
| 2 | Configuration error (including bad command-line usage) |
| 3 | Wazuh read error, including a run that reads zero hosts (nothing is sent: an empty export would hide a read failure) |
| 4 | A payload does not satisfy the contract (nothing is sent) |
| 5 | Rejected by PBC-GRC (400, 401, 403, 409, 413, 415, 503 `vm_requires_local_storage`, redirects, other 4xx) |
| 6 | Transport failure after retries, or the server acknowledged different bytes (sha256 mismatch) |
| 7 | Partial: every POST succeeded but one or more hosts were skipped (over 5000 findings, or too large for the byte budget). The skipped agent ids are printed on stderr |
| 130 | Interrupted |

Retries: 429 honours `Retry-After` (capped at 60 s); 500, 502, 503 and 504 and connection errors are tried 3 times with 2 s then 4 s pauses; other 4xx are not retried. A retry resends the same bytes, so a lost 202 is answered with `200 {"duplicate": true}`. Chunks are sent one after another with a 2.5 s pause (the server allows 30 per minute) and the run stops at the first failure.

## 12. Troubleshooting by server status

* 400: the path names the offending field. This indicates an exporter bug: file an issue.
* 401: the token is wrong, expired or revoked.
* 403 `insufficient_scope`: the token lacks the `vm:ingest` scope.
* 409 `vm_source_kind_mismatch`: the label is already used by a source of another kind; choose another `PBC_SOURCE_LABEL`.
* 413: lower `EXPORT_MAX_BYTES` or `EXPORT_MAX_HOSTS_PER_REQUEST`, or check `VM_INGEST_MAX_BYTES` on the server.
* 415: a proxy is rewriting `Content-Type` or `Content-Encoding`.
* 429: wait; the pacing should prevent it.
* 500: server storage problem; see the server log.
* 503 `vm_requires_local_storage`: the server needs `STORAGE_PROVIDER=local`.
* TLS errors: check the CA bundle (`PBC_CA_BUNDLE`, `WAZUH_CA_BUNDLE`) and that the certificate names match the URL.

## 13. Limitations

* **Indexer mode exports only hosts that have vulnerability documents** (conservative). On Wazuh 4.8 and later a fully patched host has no documents, so it is never reported and its last findings are not closed by this exporter. Confirming on a live Wazuh 4.8+ that "agent active, scan completed after T, zero vulnerability documents" means "clean" is what would unlock sending clean hosts with an empty findings list. Until then, the server's Phase 5 stale / never-reported list surfaces such hosts.
* Hosts with more than 5000 findings, or too large for `EXPORT_MAX_BYTES`, are skipped whole with a warning and exit code 7. A host is never shortened or split: the server closes findings a reported host no longer lists, so a partial host would close real findings.
* Keep `PBC_SOURCE_LABEL` stable. A new label is a new source, and the old source's findings never close.
* One exporter and one label per Wazuh manager or cluster.
* Wazuh field names are unverified against a running system (see section 4).
