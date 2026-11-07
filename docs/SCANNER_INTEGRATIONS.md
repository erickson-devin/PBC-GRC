# Connecting scanners: Wazuh, SCAP files, Action1, SentinelOne

An operator guide for getting scanner data into PBC-GRC. The exporter README (`exporters/pbc-vm-exporter/README.md`) is the
reference for the exporter itself and `docs/VULNERABILITY_MANAGEMENT.md` for the server side; this guide is the walk-through
that ties them together. Status table last updated 2026-11-01.

## 0. The one thing to understand first

PBC-GRC never connects out to a scanner. It has no screen, no table and no setting for a scanner's API key, URL or
password, and that is deliberate: the platform holds CUI and makes no outbound connections. Instead, a small program called
the **exporter** runs inside your network next to the scanner, reads the scanner with the scanner's own credentials, and
**pushes** the results to PBC-GRC over HTTPS with a **service token** that PBC-GRC issued.

So there are two sets of credentials, and they live in two different places:

| Credential | Issued by | Lives on | Never goes to |
| --- | --- | --- | --- |
| PBC-GRC service token (`pbcvm_…`) | PBC-GRC, by a Tenant Owner or MSP Admin | the exporter host, in its env file | the scanner, a ticket, email, a command line |
| Scanner credentials (Wazuh indexer or API user, Action1 API client, SentinelOne API token) | the scanner | the exporter host, in the same env file | PBC-GRC |

What is supported **today**:

| Tool | Status | What works |
| --- | --- | --- |
| Wazuh 4.x | **supported** (first adapter) | vulnerability state per agent, daily push, findings lifecycle, POA&M drafts, snapshot evidence |
| Any SCAP scanner (OpenSCAP, SCC, STIG Viewer output) | **supported** | configuration results from XCCDF / ARF files, per-control suggestions |
| Action1 | **dry-run tested, unverified live** (issue #105 phase 1) | missing-update (patch) findings per endpoint, same lifecycle as Wazuh |
| SentinelOne | **dry-run tested, unverified live** (issue #217) | application vulnerabilities (CVE per application per endpoint), same lifecycle as Wazuh |

"Dry-run tested, unverified live" means the readers are covered by offline tests against vendor response shapes written
from the vendors' documentation; nobody has run them against a real tenant yet. Section 4 is the how-to and the list of
what the first live run must confirm.

## 1. App side: the service token (once per scanner)

1. The app must be reached over **HTTPS** (TLS proxy in front, `TRUST_PROXY` set; `docs/GO_LIVE_CHECKLIST.md` section 3). Over plain
   HTTP the app refuses to create a token and says "Service tokens can only be created over HTTPS".
2. Sign in as a **Tenant Owner or MSP Admin** of the organization the scanner belongs to.
3. Profile menu (top right) → **API Keys & Service Tokens** → **VM service tokens** → New service token:
   * **Token name**: what will use it, e.g. `Wazuh exporter on scan-host-01`. Owners and admins can see the name.
   * **Expires after**: the screen proposes 90 days; the go-live checklist says 90 to 180. Put the expiry in your calendar.
4. Press **Create token**. The value (`pbcvm_` + 43 characters) is shown **once**. Copy it straight into the exporter's env
   file (section 2.3 or 3). The screen then shows **Set up the exporter**: pick the scanner, check the PBC-GRC address
   (it defaults to the address you are using now; change it to the one the exporter host uses), copy or download the
   generated settings file and paste the token into it. The token is never part of the generated text. Then press
   **I have stored the token**. The server keeps only a hash; if the value is lost,
   revoke the token and create a new one.
5. One token per scanner host. A token belongs to one organization and can only push scan results (`vm:ingest`).
6. **Rotation**: create the new token, update the exporter's env file, run the exporter once, then **Revoke** the old one
   in the same screen. At most 10 active tokens per organization.

Scripted alternative (same session, same role, HTTPS): `POST /api/v1/tenants/<tenantId>/vm/tokens` with the session
cookie, the `X-PBC-Session` marker and an `x-tenant-id: <tenantId>` header; body `{"name": "...", "expiresInDays": 90}`.

## 2. Wazuh (supported today)

### 2.1 Where the exporter runs

On a Linux host (or Windows) **inside the enclave** that can reach both the Wazuh indexer/manager and the PBC-GRC HTTPS
address. It needs Python 3.11 and nothing else from the internet after install. It is not part of the PBC-GRC image.

```bash
sudo mkdir -p /opt/pbc-vm-exporter && cd /opt/pbc-vm-exporter
# copy exporters/pbc-vm-exporter/ from the repository here (or git clone the repo and cd into that folder)
python3 -m venv .venv && .venv/bin/python -m pip install .
```

### 2.2 Wazuh side: a read-only account

* **Wazuh 4.8 and later** (the normal case): the exporter reads the indexer index `wazuh-states-vulnerabilities-*`.
  Create an indexer (OpenSearch) user with a **read-only role limited to that index pattern**. That user's name and
  password go into `WAZUH_INDEXER_USER` / `WAZUH_INDEXER_PASSWORD`. **Port 9200 is the indexer, and the exporter reads
  the indexer. Port 55000 is the Wazuh manager API, a different service with different users.** A user created in the
  Wazuh dashboard's API / RBAC settings exists only in the manager and is refused by the indexer with HTTP 401. Create
  the indexer user in the OpenSearch security plugin instead: Wazuh dashboard, Indexer management, Security, Internal
  users (create the user), Roles (a role with the cluster permission `cluster_composite_ops_ro` and the index
  permission `read` on `wazuh-states-vulnerabilities-*`), then map the role to the user under Role mappings. Menu names
  differ between Wazuh versions: verify on your install.
* The indexer must be reachable from the exporter host. By default it may listen on `127.0.0.1` only: in
  `/etc/wazuh-indexer/opensearch.yml` set `network.host` to a list such as `[127.0.0.1, <LAN IP>]`, restart
  `wazuh-indexer`, and open port 9200 for the exporter host in the firewall.
* **Wazuh 4.7 and earlier**: the exporter reads `/agents` and `/vulnerability/{id}` from the manager API. Create a
  read-only API user; its name and password go into `WAZUH_API_USER` / `WAZUH_API_PASSWORD`.
* `WAZUH_MODE=auto` (the default) asks the manager API for the version and picks the mode, so in auto mode the
  **manager API user is needed as well** even on 4.8+. Set `WAZUH_MODE=indexer` explicitly to need only the indexer user.
* Wazuh's certificates: the exporter verifies TLS and cannot be told not to. Point `WAZUH_CA_BUNDLE` at Wazuh's root CA
  (`/etc/wazuh-indexer/certs/root-ca.pem` on the Wazuh host) and reach Wazuh by a name its certificate covers: the
  default certificate may list only `127.0.0.1`, and a connection to another IP then fails with "IP address mismatch".
  Check the names with `openssl s_client -connect <host>:9200 </dev/null | openssl x509 -noout -text` (Subject Alternative
  Name) and reissue the certificate with the IP or name you use if it is missing.

### 2.3 The env file (this is where the credentials go)

Linux, as root, following the README's layout:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin pbc-vm-exporter
install -d -m 0750 -o root -g pbc-vm-exporter /etc/pbc-vm-exporter
install -m 0600 -o pbc-vm-exporter -g pbc-vm-exporter /dev/null /etc/pbc-vm-exporter/env
```

Or create the file interactively: `sudo -u pbc-vm-exporter .venv/bin/pbc-vm-exporter init --env-file /etc/pbc-vm-exporter/env`
(the folder must be writable by that account, otherwise run it as root and then `chown` the file to `pbc-vm-exporter`;
`init` never overwrites an existing file, so skip the `install ... /dev/null` line above in that case).

Contents of `/etc/pbc-vm-exporter/env` (`KEY=value` lines; a comment goes on its own line, never after a value; quotes
around a value are optional and one matching pair is stripped):

```
# PBC-GRC (section 1)
PBC_URL=https://grc.example.mil
PBC_SERVICE_TOKEN=pbcvm_...................................................
PBC_SOURCE_LABEL=wazuh-hq
PBC_CA_BUNDLE=/etc/pbc-vm-exporter/pbc-ca.pem

# Wazuh 4.8+ (indexer). 9200 is the Wazuh indexer, which the exporter reads; 55000 is the Wazuh manager API.
# WAZUH_MODE=auto (the default) also needs WAZUH_API_URL, WAZUH_API_USER and WAZUH_API_PASSWORD.
WAZUH_MODE=indexer
WAZUH_INDEXER_URL=https://wazuh-indexer.example.mil:9200
WAZUH_INDEXER_USER=pbc-readonly
WAZUH_INDEXER_PASSWORD=...
WAZUH_CA_BUNDLE=/etc/wazuh-indexer/certs/root-ca.pem

# Wazuh 4.7 and earlier instead (manager API)
# WAZUH_MODE=api
# WAZUH_API_URL=https://wazuh-manager.example.mil:55000
# WAZUH_API_USER=pbc-readonly
# WAZUH_API_PASSWORD=...
```

Rules that matter:
* `PBC_SOURCE_LABEL` names the **source** in PBC-GRC. Keep it stable forever: a new label is a new source, and the old
  source's findings would be treated as a separate scanner. One label per Wazuh deployment.
* `PBC_URL` is the exact HTTPS address of the proxy; the exporter follows no redirects. `PBC_CA_BUNDLE` only if the
  certificate is from a private CA.
* There is no command-line option for a token or password, by design. The env file (mode 0600, owned by the service
  account) is the only place.
* `PBC_ALLOW_INSECURE_TRANSPORT` exists for development only. Leave it unset in production; the server refuses tokens over
  plain HTTP anyway. The exporter warns about it only when some URL is plain `http`; `check` reports it as unneeded
  when every URL is `https`.

### 2.4 First run

```bash
cd /opt/pbc-vm-exporter
# 0. (optional) create the env file by answering prompts instead of editing it; it never overwrites a file
#    sudo -u pbc-vm-exporter .venv/bin/pbc-vm-exporter init --env-file /etc/pbc-vm-exporter/env
# 1. offline check of the install (no network, no credentials needed)
.venv/bin/pbc-vm-exporter --version
.venv/bin/python -m pbc_vm_exporter --dry-run --sample
# 2. test every connection and credential, sending nothing
sudo -u pbc-vm-exporter .venv/bin/pbc-vm-exporter check --env-file /etc/pbc-vm-exporter/env
# 3. read Wazuh for real but send nothing: prints what would be pushed as JSON
sudo -u pbc-vm-exporter .venv/bin/python -m pbc_vm_exporter --env-file /etc/pbc-vm-exporter/env --dry-run
# 4. the first live push
sudo -u pbc-vm-exporter .venv/bin/python -m pbc_vm_exporter --env-file /etc/pbc-vm-exporter/env
```

`check` prints one PASS, FAIL, SKIP or NOTE line per step, with a hint under each failure (the table in section 2.7): the
configuration loads; PBC-GRC is reachable and the token is valid (its name, display prefix and expiry are printed, never the
token); the exporter's contract equals the server's; `EXPORT_MAX_BYTES` is within the server's limit; the Wazuh indexer
answers and has documents; with `WAZUH_MODE=auto` or `api`, the manager API authenticates; and whether
`PBC_ALLOW_INSECURE_TRANSPORT` is needed. It exits 0 when nothing failed, otherwise with the exit code of the failing area
(2 configuration, 3 Wazuh, 4 contract, 5 PBC-GRC refused, 6 PBC-GRC unreachable). Against an older server without the
`whoami` endpoint the PBC-GRC step is SKIPped ("server too old for check"), not failed. `check` accepts `--env-file`,
`--source` and `--mode`; it never sends scan data.

Exit codes: 0 pushed; 2 configuration error (read the message, nothing was sent); 3 the scanner could not be read; the
README section 11 lists the rest, and section 12 maps server HTTP statuses to causes (401 = token wrong or revoked,
403 `vm_insecure_transport` = plain HTTP, 413 = lower `EXPORT_MAX_BYTES`).

The server side of `check` is `GET /api/v1/vm/whoami`, authenticated by the same service token and over HTTPS like the
ingest endpoint (so it counts as use of the token). It answers `token` (name, prefix, expiry), `scopes`, `contract_sha256`
(of `server/vm/ingest.schema.json`), `limits.max_bytes` and `features`. It never returns the tenant id or the token hash.

**Known caveat (issue #68).** The Wazuh field names the exporter reads were written from knowledge of Wazuh 4.x, not
verified against a running manager. If the dry run in step 2 shows zero hosts or empty findings while Wazuh clearly has
vulnerabilities, the field names need a one-line correction: they are in one dictionary per mode, `INDEXER_FIELDS` in
`pbc_vm_exporter/wazuh_indexer.py` and `API_FIELDS` in `pbc_vm_exporter/wazuh_api.py`. Compare them with one real document
from the index (or one `/vulnerability/{id}` response) and fix the key that differs. Please record what you changed in #68.

### 2.5 Verify in PBC-GRC

After the push, in the app the run appears under the organization's vulnerability management (runs list: status
RECEIVED → NORMALIZED within seconds; FAILED with a generic message means the server log has the reason: `docker compose
logs singularity-app | grep "VM Worker"`). Findings appear per asset; hosts Wazuh reported that the inventory did not know
are created as **unconfirmed discoveries** for a person to classify. Check that the asset count matches what Wazuh has.

### 2.6 Schedule it

Daily is the expected interval (the server flags a source as stale when its newest normalized run is older than that).
The README section 8 has the exact systemd service and timer; the service runs as the dedicated user with
`EnvironmentFile=/etc/pbc-vm-exporter/env`. On Windows, Task Scheduler as a low-privilege service account with the token
in that account's user environment and **no secrets in the task arguments**.

### 2.7 Troubleshooting

When a connection fails, the exporter (and `check`) appends a `hint:` to the error. The same table:

| Symptom (the error text contains) | Fix |
| --- | --- |
| Connection refused (WinError 10061) to the Wazuh indexer | nothing is listening at that address: on the Wazuh host the indexer may be bound to 127.0.0.1 only; set network.host in /etc/wazuh-indexer/opensearch.yml (a list such as [127.0.0.1, `<LAN IP>`]) and restart wazuh-indexer, or check the firewall for port 9200 |
| Connection timed out | the connection timed out: a firewall is probably dropping traffic from this host to that address and port (indexer 9200, manager API 55000, PBC-GRC 443); open the port from this host |
| getaddrinfo failed, Name or service not known | the host name does not resolve from this machine: check the spelling, DNS, or use the IP address |
| unable to get local issuer certificate, self-signed certificate | set WAZUH_CA_BUNDLE to the indexer root CA (/etc/wazuh-indexer/certs/root-ca.pem on the Wazuh host); for the PBC-GRC certificate set PBC_CA_BUNDLE to its CA |
| IP address mismatch, Hostname mismatch, doesn't match | the certificate does not cover the host name or IP in the URL: use a name the certificate lists (check with openssl s_client ... \| openssl x509 -noout -text, Subject Alternative Name), or reissue it with that IP |
| Indexer returned HTTP 401 | the indexer (port 9200) uses its own internal users from the OpenSearch security plugin, not Wazuh manager API users; create the user with the security plugin (see docs/SCANNER_INTEGRATIONS.md) |
| Indexer returned HTTP 403 | the user is known but its role lacks read access on the vulnerability index: map a role with read on wazuh-states-vulnerabilities-* to this user in the indexer security plugin |
| Indexer returned HTTP 404 (index_not_found) | index_not_found: vulnerability detection is probably off in Wazuh, or WAZUH_INDEXER_INDEX is the wrong index name |
| WAZUH_INDEXER_URL ends in :55000, or WAZUH_API_URL ends in :9200 | port 9200 is the Wazuh indexer, which the exporter reads; port 55000 is the Wazuh manager API: point WAZUH_INDEXER_URL at 9200 and set WAZUH_MODE=indexer |
| PBC-GRC answers HTTP 403 vm_insecure_transport | PBC-GRC saw plain http: serve the app over HTTPS, and set TRUST_PROXY on the server when a reverse proxy terminates TLS (vm_insecure_transport) |
| PBC-GRC answers HTTP 401 | the service token is wrong, expired or revoked: create a new one in PBC-GRC (API tokens) and paste it |
| Warning: PBC_ALLOW_INSECURE_TRANSPORT is set | PBC_ALLOW_INSECURE_TRANSPORT is set but every URL is https: remove it, it only silences a safety check |

## 3. Configuration results from any SCAP scanner (supported today)

If OpenSCAP, SCC or STIG Viewer produce XCCDF results or ARF files, the same exporter pushes them:

```
sudo -u pbc-vm-exporter .venv/bin/python -m pbc_vm_exporter --env-file /etc/pbc-vm-exporter/env --source xccdf --input /var/lib/scans/
```

`--input` is a file or a directory of `*.xml`. Use a **separate** `PBC_SOURCE_LABEL` and ideally a separate token for
this (a different env file, e.g. `/etc/pbc-vm-exporter/env.xccdf`): it is a different source of a different kind. Results
show in the app under **Configuration Results** with per-control suggestions that a person accepts or not. Note that the
built-in rule-to-control map is small (23 rules, issue #203), so expect few suggestions until it is curated.

## 4. Action1 and SentinelOne (dry-run tested, unverified live)

The same exporter reads both tools and pushes the results with `kind` `ACTION1` or `SENTINELONE`. The server treats them
exactly like Wazuh findings: one finding per host and vulnerability id, the same lifecycle (opened, resolved when the
source stops reporting it, reopened), SLA clock, POA&M drafts and snapshot evidence. A finding that two tools both report
on one host stays open until **every** tool that saw it stops reporting it.

Two things differ from Wazuh:
* The exporter makes **read-only outbound HTTPS calls to the vendor's cloud** (Action1's API, your SentinelOne console).
  Nothing from PBC-GRC is sent there. The exporter ignores `HTTPS_PROXY`; if the enclave's egress needs a proxy, set
  `ACTION1_PROXY_URL` / `S1_PROXY_URL` (used for the vendor only, never for PBC-GRC).
* The vendor field names in the exporter were written from the vendors' documentation and have **not** been checked
  against a live tenant (section 4.3).

Use a **separate** `PBC_SOURCE_LABEL`, and a separate env file, for each tool (for example `/etc/pbc-vm-exporter/env.action1`
and `env.sentinelone`). A label is tied to one tool for good: reusing a Wazuh label for Action1 is refused (409
`vm_source_kind_mismatch`). Install and token creation are the same as sections 1 and 2.1.

### 4.1 Action1

On the Action1 side, in the console under your organization, create an **API client** with **read-only** rights and note
the client ID, the secret and the **organization ID**. The exporter asks for an access token with them on every run.

`/etc/pbc-vm-exporter/env.action1` (same file rules as section 2.3):

```
PBC_URL=https://grc.example.mil
PBC_SERVICE_TOKEN=pbcvm_...................................................
PBC_SOURCE_LABEL=action1-hq

ACTION1_BASE_URL=https://app.action1.com/api/3.0
ACTION1_CLIENT_ID=...
ACTION1_CLIENT_SECRET=...
ACTION1_ORG_ID=...
# ACTION1_CA_BUNDLE=/etc/pbc-vm-exporter/action1-ca.pem
# ACTION1_INCLUDE_PATCH_FINDINGS=true
# ACTION1_PROXY_URL=http://proxy.example.mil:3128
```

| Variable | Rule |
| --- | --- |
| `ACTION1_BASE_URL` | required, `https://`, the **full API root** for your region: North America `https://app.action1.com/api/3.0`, Europe `https://app.eu.action1.com/api/3.0` |
| `ACTION1_CLIENT_ID` | required, 1 to 256 characters |
| `ACTION1_CLIENT_SECRET` | required, 1 to 1024 characters; a secret, never printed |
| `ACTION1_ORG_ID` | required, letters, digits and hyphens, 1 to 64 characters |
| `ACTION1_CA_BUNDLE` | optional, PEM file for a private CA |
| `ACTION1_INCLUDE_PATCH_FINDINGS` | optional, on by default: security updates that fix no CVE become one finding each, identified by the update's KB or id |
| `ACTION1_PROXY_URL` | optional egress proxy for Action1 only |

What a finding is: Action1 reports **missing updates**, not CVEs. Each missing security update becomes one finding per CVE
it fixes (the server merges them by CVE id); a security update with no CVE becomes one finding whose id is the KB number
(for example `KB5034441`). Non-security updates are dropped and counted. Severity comes from Action1's grade
(Critical, Important becomes HIGH, Moderate becomes MEDIUM, Low), and a severity the exporter cannot grade is graded from
the CVSS score when there is one. Action1 gives no detection date, so the finding's SLA clock starts when PBC-GRC first
sees it. The update's own version is recorded as the fixed version.

Run it (the `--sample` run needs no credentials):

```bash
cd /opt/pbc-vm-exporter
.venv/bin/python -m pbc_vm_exporter --dry-run --sample --source action1
sudo -u pbc-vm-exporter .venv/bin/python -m pbc_vm_exporter --env-file /etc/pbc-vm-exporter/env.action1 --source action1 --dry-run
sudo -u pbc-vm-exporter .venv/bin/python -m pbc_vm_exporter --env-file /etc/pbc-vm-exporter/env.action1 --source action1
```

The exporter reads **everything** before it sends anything: any API error stops the run with exit 3 and nothing is pushed,
so a half-read tenant never closes findings. A 401 is retried once with a fresh token; a second 401 is exit 3. `--mode`
applies to Wazuh only and is refused with `--source action1`.

**One-line fixes.** The URL paths and field names are in two dictionaries at the top of
`exporters/pbc-vm-exporter/pbc_vm_exporter/action1.py` (`ACTION1_PATHS`, `ACTION1_FIELDS`), and the severity words in
`ACTION1_SEVERITY`. If the dry run shows zero hosts or empty findings, compare one real response with them and change the
key that differs.

### 4.2 SentinelOne

On the SentinelOne side, create an **API token** for a **service user** (read-only rights are enough), scoped
to the site or account that holds the enclave's endpoints, and note the **site ID(s)**. The **Singularity Vulnerability
Management** (application risk) module must be licensed: without it the console returns no vulnerabilities per endpoint.
Token lifetime is the calendar's problem: a token has an expiry (30 days by default; a service user's token has the
expiry chosen when it was created), SentinelOne does not refresh it, and the exporter will start failing the day it
lapses. Put the expiry date in your calendar and regenerate the token before it.

`/etc/pbc-vm-exporter/env.sentinelone`:

```
PBC_URL=https://grc.example.mil
PBC_SERVICE_TOKEN=pbcvm_...................................................
PBC_SOURCE_LABEL=sentinelone-hq

S1_CONSOLE_URL=https://example.sentinelone.net
S1_API_TOKEN=...
S1_SITE_IDS=1234567890123456789
# S1_CA_BUNDLE=/etc/pbc-vm-exporter/s1-ca.pem
# S1_PROXY_URL=http://proxy.example.mil:3128
```

| Variable | Rule |
| --- | --- |
| `S1_CONSOLE_URL` | required, `https://`, the console **host only** (the exporter appends `/web/api/v2.1`) |
| `S1_API_TOKEN` | required, 20 to 4096 characters, no spaces; a secret, never printed |
| `S1_SITE_IDS` | required, comma-separated numeric site ids, 1 to 100 of them (duplicates are dropped) |
| `S1_CA_BUNDLE` | optional, PEM file for a private CA |
| `S1_PROXY_URL` | optional egress proxy for SentinelOne only |

What a finding is: one finding per CVE per application per endpoint, which the server merges per host and CVE id. The
host is identified by SentinelOne's agent UUID; decommissioned agents are left out; the host's MAC address is the one of
the interface that holds the management IP. Severity comes from SentinelOne's grade (NONE becomes unrated and is then
graded from CVSS when there is a score).

```bash
cd /opt/pbc-vm-exporter
.venv/bin/python -m pbc_vm_exporter --dry-run --sample --source sentinelone
sudo -u pbc-vm-exporter .venv/bin/python -m pbc_vm_exporter --env-file /etc/pbc-vm-exporter/env.sentinelone --source sentinelone --dry-run
sudo -u pbc-vm-exporter .venv/bin/python -m pbc_vm_exporter --env-file /etc/pbc-vm-exporter/env.sentinelone --source sentinelone
```

Same all-or-nothing read as Action1 (any error is exit 3, nothing pushed). A 401 stops at once with "SentinelOne rejected
the API token (HTTP 401); it may have expired: generate a new token and update S1_API_TOKEN". A 429 is retried once after
the pause SentinelOne asks for.

**One-line fixes.** The paths and field names are in `S1_PATHS` and `S1_FIELDS` at the top of
`exporters/pbc-vm-exporter/pbc_vm_exporter/sentinelone.py`, the severity words in `S1_SEVERITY`.

### 4.3 What the first live run must confirm

Record the results in issues #105 (Action1) and #217 (SentinelOne), and fix the dictionaries above for anything that
differs. The dry run against a real tenant prints what would be pushed; compare it with the vendor console.

**SentinelOne**
* The base path `/web/api/v2.1` and the `Authorization: ApiToken` header.
* The `/agents` fields: `uuid`, `computerName`, `osName`, `osRevision`, `lastIpToMgmt`, `networkInterfaces[].inet` and
  `.physical`, `isDecommissioned`.
* The vulnerability endpoint path, and that your licence returns rows from it.
* The row fields: `cveId`, `severity` (and whether `NONE` occurs), `endpointId` (is it the agent `id` or the `uuid`),
  `applicationName` / `applicationVersion`, `detectionDate`, the CVSS field name and version, and whether a published date
  exists.
* Paging (`pagination.nextCursor`) and the largest accepted `limit`.
* What an expired token returns, and the token's lifetime.
* Whether `siteIds` really filters the vulnerability rows.

**Action1**
* The regional base URL and the `/api/3.0` prefix.
* The token endpoint (form body or JSON) and `expires_in`.
* Paging (`items`, `next_page`, `limit` / `from`).
* The endpoint fields: `id`, `name`, `address`, `MAC`, OS.
* The missing-updates path and fields: id, KB, name, version, severity words, `release_date`, the security flag and the
  name of the CVE-list field.
* Whether a per-endpoint **CVE** list exists (it is preferable to the missing-update view).
* Rate limits (the exporter makes one call per endpoint).

**Both**
* The hostname form (short name or FQDN) compared with the same hosts in Wazuh: see "Known limitations".

### 4.4 Known limitations

* **Hostname forms.** Hosts are matched across tools by agent id, then MAC address, then hostname. If SentinelOne reports
  `web-01` and Wazuh reports `web-01.example.mil` and no MAC address matches, PBC-GRC creates a second, unconfirmed asset
  and the two tools' findings do not share one lifecycle. Classify or decommission the duplicate by hand
  (`docs/VULNERABILITY_MANAGEMENT.md` section 6.5).
* **Clean hosts are not reported.** Only hosts with at least one finding are pushed; a host with none does not appear, and
  its asset is not marked as seen by that tool until it has a finding.
* **Very large hosts.** A host with more than 5000 findings (typical for developer machines in SentinelOne) is skipped as a
  whole and the run ends with exit 7 ("partial export"). Its findings stay as they were.
* **Inventory is not collected yet.** Installed software, patch age and a patch SLA are issue #105 phase 2; this phase
  reports findings only.
* Every source logs counts only, never agent ids; a partial export (exit 7) lists the skipped ids only in the file named with `--skipped-report PATH`.

## 5. Where everything is, in one table

| Item | Location |
| --- | --- |
| Service token value | only in the exporter host's env file (`/etc/pbc-vm-exporter/env`, mode 0600) |
| Service token list, create, revoke | app → profile menu → API Keys & Service Tokens (Owner / MSP Admin, HTTPS) |
| Scanner credentials | the same env file: `WAZUH_*`, `ACTION1_*` (client ID and secret) or `S1_*` (API token) variables |
| Optional egress proxy for Action1 / SentinelOne | `ACTION1_PROXY_URL` / `S1_PROXY_URL` in the env file (vendor calls only, never PBC-GRC) |
| Where the vendor field names live (one-line fixes) | `pbc_vm_exporter/action1.py` (`ACTION1_PATHS`, `ACTION1_FIELDS`), `pbc_vm_exporter/sentinelone.py` (`S1_PATHS`, `S1_FIELDS`) |
| Source name as PBC-GRC sees it | `PBC_SOURCE_LABEL` in the env file: never change it |
| Exporter code and README | `exporters/pbc-vm-exporter/` in the repository |
| Push interval expectation | daily (server setting `VM_SNAPSHOT_INTERVAL_HOURS` / staleness in `docs/VULNERABILITY_MANAGEMENT.md`) |
| Server-side ingest limits | `VM_INGEST_MAX_BYTES` in the app's `.env` (default 64 MB) |
| Design, lifecycle rules, API reference | `docs/VULNERABILITY_MANAGEMENT.md` |
