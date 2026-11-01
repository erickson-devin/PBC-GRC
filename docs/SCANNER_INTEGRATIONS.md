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
| Scanner credentials (Wazuh indexer or API user; later Action1 / SentinelOne API keys) | the scanner | the exporter host, in the same env file | PBC-GRC |

What is supported **today**:

| Tool | Status | What works |
| --- | --- | --- |
| Wazuh 4.x | **supported** (first adapter) | vulnerability state per agent, daily push, findings lifecycle, POA&M drafts, snapshot evidence |
| Any SCAP scanner (OpenSCAP, SCC, STIG Viewer output) | **supported** | configuration results from XCCDF / ARF files, per-control suggestions |
| Action1 | **not yet**: adapter is roadmap item #105 (parked in #184) | nothing pushes today |
| SentinelOne | **not yet**: adapter is issue #217 (see section 4) | nothing pushes today |

For Action1 and SentinelOne, section 4 says exactly what to collect now so the adapter can be built later without you
having to rediscover anything.

## 1. App side: the service token (once per scanner)

1. The app must be reached over **HTTPS** (TLS proxy in front, `TRUST_PROXY` set; `docs/GO_LIVE_CHECKLIST.md` section 3). Over plain
   HTTP the app refuses to create a token and says "Service tokens can only be created over HTTPS".
2. Sign in as a **Tenant Owner or MSP Admin** of the organization the scanner belongs to.
3. Profile menu (top right) → **API Keys & Service Tokens** → **VM service tokens** → New service token:
   * **Token name**: what will use it, e.g. `Wazuh exporter on scan-host-01`. Owners and admins can see the name.
   * **Expires after**: the screen proposes 90 days; the go-live checklist says 90 to 180. Put the expiry in your calendar.
4. Press **Create token**. The value (`pbcvm_` + 43 characters) is shown **once**. Copy it straight into the exporter's env
   file (section 2.3 or 3). Then press **I have stored the token**. The server keeps only a hash; if the value is lost,
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
python3 -m venv .venv && .venv/bin/pip install .
```

### 2.2 Wazuh side: a read-only account

* **Wazuh 4.8 and later** (the normal case): the exporter reads the indexer index `wazuh-states-vulnerabilities-*`.
  Create an indexer (OpenSearch) user with a **read-only role limited to that index pattern**. That user's name and
  password go into `WAZUH_INDEXER_USER` / `WAZUH_INDEXER_PASSWORD`.
* **Wazuh 4.7 and earlier**: the exporter reads `/agents` and `/vulnerability/{id}` from the manager API. Create a
  read-only API user; its name and password go into `WAZUH_API_USER` / `WAZUH_API_PASSWORD`.
* `WAZUH_MODE=auto` (the default) asks the manager API for the version and picks the mode, so in auto mode the
  **manager API user is needed as well** even on 4.8+. Set `WAZUH_MODE=indexer` explicitly to need only the indexer user.
* Wazuh's certificates: the exporter verifies TLS and cannot be told not to. Point `WAZUH_CA_BUNDLE` at Wazuh's root CA
  (`root-ca.pem` in its certificates directory) and reach Wazuh by a name its certificate covers.

### 2.3 The env file (this is where the credentials go)

Linux, as root, following the README's layout:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin pbc-vm-exporter
install -d -m 0750 -o root -g pbc-vm-exporter /etc/pbc-vm-exporter
install -m 0600 -o pbc-vm-exporter -g pbc-vm-exporter /dev/null /etc/pbc-vm-exporter/env
```

Contents of `/etc/pbc-vm-exporter/env` (`KEY=value` lines, no inline comments, no quotes needed):

```
# PBC-GRC (section 1)
PBC_URL=https://grc.example.mil
PBC_SERVICE_TOKEN=pbcvm_...................................................
PBC_SOURCE_LABEL=wazuh-hq
PBC_CA_BUNDLE=/etc/pbc-vm-exporter/pbc-ca.pem

# Wazuh 4.8+ (indexer)
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
  plain HTTP anyway.

### 2.4 First run

```bash
cd /opt/pbc-vm-exporter
# 1. offline check of the install (no network, no credentials needed)
.venv/bin/python -m pbc_vm_exporter --dry-run --sample
# 2. read Wazuh for real but send nothing: prints what would be pushed as JSON
sudo -u pbc-vm-exporter .venv/bin/python -m pbc_vm_exporter --env-file /etc/pbc-vm-exporter/env --dry-run
# 3. the first live push
sudo -u pbc-vm-exporter .venv/bin/python -m pbc_vm_exporter --env-file /etc/pbc-vm-exporter/env
```

Exit codes: 0 pushed; 2 configuration error (read the message, nothing was sent); 3 the scanner could not be read; the
README section 11 lists the rest, and section 12 maps server HTTP statuses to causes (401 = token wrong or revoked,
403 `vm_insecure_transport` = plain HTTP, 413 = lower `EXPORT_MAX_BYTES`).

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

## 3. Configuration results from any SCAP scanner (supported today)

If OpenSCAP, SCC or STIG Viewer produce XCCDF results or ARF files, the same exporter pushes them:

```
sudo -u pbc-vm-exporter .venv/bin/python -m pbc_vm_exporter --env-file /etc/pbc-vm-exporter/env --source xccdf --input /var/lib/scans/
```

`--input` is a file or a directory of `*.xml`. Use a **separate** `PBC_SOURCE_LABEL` and ideally a separate token for
this (a different env file, e.g. `/etc/pbc-vm-exporter/env.xccdf`): it is a different source of a different kind. Results
show in the app under **Configuration Results** with per-control suggestions that a person accepts or not. Note that the
built-in rule-to-control map is small (23 rules, issue #203), so expect few suggestions until it is curated.

## 4. Action1 and SentinelOne (not supported yet): what to collect now

Neither has an adapter, and the server deliberately refuses vulnerability findings from a source kind it has no
normalizer for ("No normalizer for ACTION1 yet"), so there is no workaround to push them today. Do not relabel another
tool's data as Wazuh to get it in: the lifecycle rules assume the source kind.

Building each adapter is a few days of exporter work (Python, `requests` only, following `wazuh_indexer.py`) plus a server
normalizer. What the developer will need from you, which you can gather now and keep with your other credentials:

**Action1**
* The API base URL for your region (Action1's cloud API; North America and Europe have different hosts).
* An **API client ID and secret** created in the Action1 console under your organization with **read-only** rights, and
  the **organization ID**.
* One saved example of the vulnerabilities endpoint's JSON for one endpoint (device), redacted, so the field names are
  real rather than from documentation.
* Which Action1 fields you consider the identity of a device (hostname, serial, Action1's own ID).

**SentinelOne**
* The management console URL (`https://<tenant>.sentinelone.net`) and an **API token** for a read-only user, scoped to
  the site or account that holds your enclave's endpoints. Note the token's expiry: SentinelOne tokens expire and must be
  regenerated.
* Confirmation that the **Singularity Vulnerability Management** (application risk) module is licensed; the agent and
  threat APIs alone do not expose vulnerabilities per endpoint.
* One saved example of the per-endpoint application-vulnerability JSON, redacted.
* The site ID(s) in scope.

Until the adapters exist, SentinelOne's and Action1's own exports are still useful as **evidence files** attached to the
relevant controls in the evidence vault; they just do not drive findings.

## 5. Where everything is, in one table

| Item | Location |
| --- | --- |
| Service token value | only in the exporter host's env file (`/etc/pbc-vm-exporter/env`, mode 0600) |
| Service token list, create, revoke | app → profile menu → API Keys & Service Tokens (Owner / MSP Admin, HTTPS) |
| Scanner credentials | the same env file, `WAZUH_*` variables |
| Source name as PBC-GRC sees it | `PBC_SOURCE_LABEL` in the env file: never change it |
| Exporter code and README | `exporters/pbc-vm-exporter/` in the repository |
| Push interval expectation | daily (server setting `VM_SNAPSHOT_INTERVAL_HOURS` / staleness in `docs/VULNERABILITY_MANAGEMENT.md`) |
| Server-side ingest limits | `VM_INGEST_MAX_BYTES` in the app's `.env` (default 64 MB) |
| Design, lifecycle rules, API reference | `docs/VULNERABILITY_MANAGEMENT.md` |
