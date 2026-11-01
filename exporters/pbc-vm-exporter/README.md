# pbc-vm-exporter

Reads vulnerability state from Wazuh, Action1 or SentinelOne (and configuration results from XCCDF / ARF files) and pushes it to PBC-GRC (`POST /api/v1/vm/ingest`).

## 1. What it is

A push-model exporter. It runs inside the enclave next to Wazuh (or anywhere that can reach the Action1 or SentinelOne cloud), reads the source, builds payloads that satisfy the ingest contract (`server/vm/ingest.schema.json`) and POSTs them to PBC-GRC with a service token.

* It is not part of the PBC-GRC application image.
* Data goes only to PBC-GRC. With `--source wazuh` or `--source xccdf` there is no other egress. With `--source action1` or `--source sentinelone` the exporter also makes read-only outbound HTTPS calls to that vendor's cloud (the machine needs outbound HTTPS to it); nothing from PBC-GRC is ever sent there, and the vendor's credentials are never sent to PBC-GRC.
* Proxy settings from the environment (`HTTP_PROXY`, `HTTPS_PROXY`, `.netrc`, `REQUESTS_CA_BUNDLE`) are ignored on purpose (`trust_env=False`). The only proxy is the optional `ACTION1_PROXY_URL` / `S1_PROXY_URL`, used for that vendor's requests and never for PBC-GRC.
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
| `ACTION1_BASE_URL` | `--source action1` | The full Action1 API root, for example `https://app.action1.com/api/3.0` (North America) or `https://app.eu.action1.com/api/3.0` (Europe) |
| `ACTION1_CLIENT_ID`, `ACTION1_CLIENT_SECRET` | `--source action1` | OAuth client credentials of an Action1 API key (secret 1 to 1024 characters; never logged) |
| `ACTION1_ORG_ID` | `--source action1` | Action1 organization id, 1 to 64 characters from `A-Z a-z 0-9 -` |
| `ACTION1_INCLUDE_PATCH_FINDINGS` | no | Default on. `false` drops security updates that name no CVE instead of reporting them by KB id |
| `ACTION1_CA_BUNDLE`, `ACTION1_PROXY_URL` | no | CA bundle for Action1's certificate; an `http://` or `https://` egress proxy for the Action1 requests only |
| `S1_CONSOLE_URL` | `--source sentinelone` | The console host only, for example `https://example.sentinelone.net` (the exporter appends `/web/api/v2.1`) |
| `S1_API_TOKEN` | `--source sentinelone` | API token, 20 to 4096 characters, no whitespace (never logged). Use a service-user token with a chosen expiry |
| `S1_SITE_IDS` | `--source sentinelone` | Comma-separated numeric site ids to read, 1 to 100 (duplicates are removed) |
| `S1_CA_BUNDLE`, `S1_PROXY_URL` | no | CA bundle for the console's certificate; an `http://` or `https://` egress proxy for the SentinelOne requests only |
| `EXPORT_MAX_HOSTS_PER_REQUEST` | no | Hosts per POST, default 500, range 1..1000 |
| `EXPORT_MAX_FINDINGS_PER_REQUEST` | no | Findings per POST, default 50000, range 1..50000 |
| `EXPORT_MAX_BYTES` | no | Body bytes per POST, default 33554432 (32 MiB), range 1048576..104857600. Lower it if the server's `VM_INGEST_MAX_BYTES` is below 32 MiB |
| `EXPORT_TIMEOUT_SECONDS` | no | Read timeout, default 60, range 5..600 |

URLs must be `https` (the two proxy URLs may be `http`) and must not contain credentials, a query or a fragment. The Action1 and SentinelOne variables are required only by their own `--source` and not at all with `--sample`; `WAZUH_MODE` and `WAZUH_INDEXER_INDEX` are not read for those sources. A number that is not a positive integer falls back to the default with a warning; a number outside its range is clamped.

Env file format: `KEY=value`, an optional `export ` prefix, full-line `#` comments, blank lines. There are no inline comments (a `#` inside a password survives), one pair of matching outer quotes is stripped, and there is no interpolation. A malformed line is reported by number only; its content is never echoed.

A run splits a large fleet across several POSTs by hosts, findings and bytes. A host is never split between two POSTs and never shortened.

## 4. Choosing a mode

* `auto` reads `GET /` on the manager API and picks `indexer` for Wazuh 4.8 and later, `api` for 4.x before 4.8. Anything else (3.x, an unreadable version) is a configuration error: set `WAZUH_MODE`.
* `indexer` reads the `wazuh-states-vulnerabilities-*` index (scroll pagination, so it works on every OpenSearch version). Give it a read-only indexer role limited to that index pattern.
* `api` reads `/agents` and `/vulnerability/{id}` from the manager API. An agent that never connected, or has no completed scan, is not reported. A scanned agent with no vulnerabilities is reported with an empty findings list, which is correct: its findings close.

All Wazuh field names and endpoints are from knowledge of Wazuh 4.x, not from a running system. They live in one dictionary per source (`INDEXER_FIELDS` in `wazuh_indexer.py`, `API_FIELDS` in `wazuh_api.py`). Verify them against your running Wazuh before the first live push; a wrong guess is a one-line fix.

The Action1 and SentinelOne endpoints and field names are likewise from vendor documentation, not from a live tenant, and live in one dictionary per module (`A1_PATHS` / `A1_FIELDS` in `action1.py`, `S1_PATHS` / `S1_FIELDS` in `sentinelone.py`). Sections 10b and 10c list what to confirm on the first live run.

## 5. Creating the service token

A TENANT_OWNER or MSP_ADMIN creates it over HTTPS in the app (profile menu, "API Keys & Service Tokens": name, expiry 1 to 730 days, default 90) or with `POST /api/v1/tenants/:tenantId/vm/tokens`. The token is shown once. Through the API alone the default expiry is 365 days. Rotate before it expires. See `docs/VULNERABILITY_MANAGEMENT.md`.

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
* `--sample --source action1` and `--sample --source sentinelone` (require `--dry-run`) use the bundled synthetic data (`samples/action1_sample.json`, `samples/sentinelone_sample.json`: `*.example` hostnames, documentation addresses, public CVE ids). `skipped_hosts` is a count for these sources.
* `--sample --source xccdf` (requires `--dry-run`) uses the bundled synthetic XCCDF file (`samples/xccdf_sample.xml`, documentation addresses only). The dry-run document then has `"results"` (rule results in the chunk) next to `"findings"` (always 0) and `"skipped_hosts"` is a count.

## 10a. Configuration results from XCCDF / ARF files (`--source xccdf`)

`--source xccdf --input PATH` reads result files written by an SCAP scanner (for example `oscap xccdf eval --results` or `--results-arf`) and pushes them as a source of kind `SCAP`: each host carries a `configuration` list (one scan per XCCDF TestResult) and no findings. `--input` is repeatable and accepts a file or a directory (its `*.xml` files, sorted). This is also the manual upload path: there is no browser upload. `PBC_URL`, `PBC_SERVICE_TOKEN` and `PBC_SOURCE_LABEL` are required as usual; the Wazuh settings are not used. Keep the label stable and distinct from any Wazuh label (a label belongs to one source kind).

* Formats: XCCDF 1.1 and 1.2 results files and ARF collections (namespaces are ignored). The rule title comes from the Rule in the file, the CCE from an `ident` of the CCE system, CCI numbers from any `ident` that looks like `CCI-nnnnnn`.
* Host identity: `agent_id` is `xccdf-` plus the first 32 hex characters of sha256 of the lower-case FQDN (ARF asset or the `urn:xccdf:fact:asset:identifier:fqdn` fact), else of the lower-case TestResult target. The server falls back to the MAC address, then the host name, to match an existing asset. A rule id that occurs more than once in one TestResult is folded to its worst outcome (fail, error, unknown, pass, fixed, then the rest).
* Times: a TestResult time without an offset is read as **UTC**. `scanned_at` is the end time (the start time if there is none), `started_at` the start time. `source_sha256` is the sha256 of the file's bytes.
* Untrusted input: a file over 512 MiB, or one that contains `<!DOCTYPE` or `<!ENTITY` (any case), or that is UTF-16 / UTF-32, is refused before it is parsed. Messages and logs name an input by number (`input 1`) with counts and sha256 prefixes; they never print a path, host name, address or agent id. The dry-run output on stdout is the payload itself and does contain the host identity.
* A scan holds at most 5000 distinct rules, a host at most 20 scans per run, and a payload at most 100000 rule results; a host is never split across payloads.

## 10b. Missing updates from Action1 (`--source action1`)

Reads the missing updates of every managed endpoint of one Action1 organization and pushes them as a source of kind `ACTION1`. `PBC_URL`, `PBC_SERVICE_TOKEN` and `PBC_SOURCE_LABEL` are required as usual (keep the label distinct from every other source's); `--mode` does not apply.

```
ACTION1_BASE_URL=https://app.action1.com/api/3.0
ACTION1_CLIENT_ID=...
ACTION1_CLIENT_SECRET=...
ACTION1_ORG_ID=...
python -m pbc_vm_exporter --source action1 --dry-run
```

* Authentication: `POST {ACTION1_BASE_URL}/oauth2/token` with the client id and secret, then a Bearer token. A 401 authenticates once more; a second 401 is exit 3. Create the API key in Action1 with read-only access.
* Findings: one finding per CVE that a missing security update fixes (the server merges them per host and CVE). A security update that names no CVE becomes one finding keyed by its KB or update id; set `ACTION1_INCLUDE_PATCH_FINDINGS=false` to drop those instead. Updates that are not security updates are dropped and counted. The vendor severity is mapped (Critical, Important to HIGH, Moderate to MEDIUM, Low, Unspecified to UNKNOWN; the server grades UNKNOWN from a CVSS score when it has one). There is no detection time, so the first-seen time is the first run that reports the finding.
* Host identity: `agent_id` is the Action1 endpoint id; the MAC and then the host name match an existing asset.
* Only endpoints with at least one finding are reported; a fully patched endpoint is not, so its last findings are not closed by this exporter.
* The whole read finishes before anything is sent: any error is exit 3 and no partial host is exported. A `next_page` link is followed only when its scheme, host and port equal `ACTION1_BASE_URL`'s. At most 10000 pages per listing; a 429 is retried once after `Retry-After` (capped at 60 s). The exporter makes one request per endpoint, so a large estate takes proportionally long.
* Logs and errors carry counts only: no host name, endpoint id, address, or organization id.

First live run, confirm: the regional base URL and `/api/3.0`; the token endpoint (form or JSON body, `expires_in`); paging (`items`, `next_page`, `limit`); the endpoint fields (`id`, `name`, `address`, `MAC`, `OS`); the missing-updates path and fields (`id`, `name`, `version`, `severity` words, `release_date`, the security flag, the CVE list field name, the KB field); whether a per-endpoint CVE list exists (preferred if it does); rate limits.

## 10c. Vulnerabilities from SentinelOne (`--source sentinelone`)

Reads the application vulnerabilities (risks) of the agents of the listed sites and pushes them as a source of kind `SENTINELONE`. It needs a SentinelOne Vulnerability Management licence and a token whose role can read agents and application risks. `PBC_URL`, `PBC_SERVICE_TOKEN` and `PBC_SOURCE_LABEL` are required as usual; `--mode` does not apply.

```
S1_CONSOLE_URL=https://example.sentinelone.net
S1_API_TOKEN=...
S1_SITE_IDS=1234567890123456789
python -m pbc_vm_exporter --source sentinelone --dry-run
```

* Authentication: `Authorization: ApiToken <token>`. The token expires (30 days by default for a user token; a service-user token has the expiry chosen when it was created) and SentinelOne has no refresh: an expired token is exit 3 with the message `SentinelOne rejected the API token (HTTP 401); it may have expired: generate a new token and update S1_API_TOKEN`. Put the expiry date in a calendar.
* Reads `GET /agents` and `GET /application-management/risks` (cursor paging, `siteIds`, limit 1000). A risk row joins to its agent on the endpoint id; a row with an unknown endpoint, and every decommissioned agent, is dropped and counted.
* Host identity: `agent_id` is the agent's uuid (stable per install); the host name is `computerName` (often a short name, not an FQDN); the IP is `lastIpToMgmt`; the MAC is that of the interface that holds this IP, and only that one.
* Findings: one per CVE, application and version (`applicationName` / `applicationVersion` as the package; there is no fixed version). Severity is mapped (NONE to UNKNOWN; the server grades UNKNOWN from the CVSS score when it has one). The CVSS score field's version is not stated by the vendor and is taken as given.
* Only agents with at least one finding are reported; a clean agent is not, so its last findings are not closed by this exporter.
* The whole read finishes before anything is sent: any error is exit 3 and no partial host is exported. At most 10000 pages per listing; a 429 is retried once after `Retry-After` (capped at 60 s). Logs and errors carry counts only.

First live run, confirm: the base path and the `ApiToken` header; the `/agents` fields (`uuid`, `computerName`, `osName`, `osRevision`, `lastIpToMgmt`, `networkInterfaces[].inet` and `.physical`, `isDecommissioned`); the risks path and that the licence returns rows; the row fields (`cveId`, the severity words including NONE, `endpointId` equal to the agent `id` or to the `uuid`, `applicationName`, `applicationVersion`, `detectionDate`, the CVSS field name and version, a published date); `pagination.nextCursor` and the maximum limit; the 401 body at expiry; whether `siteIds` filters the risks.

## 11. Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error (one redacted line, no traceback) |
| 2 | Configuration error (including bad command-line usage) |
| 3 | Source read error (Wazuh, Action1 or SentinelOne: authentication, a request, a body, a pagination loop or an expired token), including a run that reads zero hosts (nothing is sent: an empty export would hide a read failure). With `--source xccdf`: a result file that cannot be read or is refused (over 512 MiB, DOCTYPE / ENTITY, not well-formed, not UTF-8), or inputs that hold no TestResult with results |
| 4 | A payload does not satisfy the contract (nothing is sent) |
| 5 | Rejected by PBC-GRC (400, 401, 403, 409, 413, 415, 503 `vm_requires_local_storage`, redirects, other 4xx) |
| 6 | Transport failure after retries, or the server acknowledged different bytes (sha256 mismatch) |
| 7 | Partial: every POST succeeded but one or more hosts were skipped (over 5000 findings, or too large for the byte budget). With `--source wazuh` the skipped agent ids are printed on stderr; with `--source action1` or `sentinelone` only the number of skipped hosts is |
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
* Action1 and SentinelOne endpoints and field names are unverified against a live tenant (sections 10b and 10c): this support is dry-run tested only until a first live run is recorded.
* Action1 and SentinelOne export only hosts that have findings (see above), and an Action1 patch is a finding keyed by CVE (or KB id), not an installed-software inventory.
* A host with more than 5000 findings (a developer machine in SentinelOne, for example) is skipped whole with exit code 7; the number of skipped hosts is on stderr.
* SentinelOne host names are often short while Wazuh names are FQDNs; the same machine in both sources can appear as two assets until the names agree (the agent id and MAC match first).
* The Wazuh path still names skipped agent ids in its log and exit-7 message; the Action1 and SentinelOne paths do not.
