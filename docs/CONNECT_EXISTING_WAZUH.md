# Connect PBC-GRC to an existing Wazuh

A short checklist for standing up PBC-GRC on a customer network next to a Wazuh that someone else administers. It
covers what to ask the Wazuh administrator for, how to test the connection, where to run the exporter, and how to read
the exporter's messages. The long reference is `docs/SCANNER_INTEGRATIONS.md` (section 2) and the exporter README
(`exporters/pbc-vm-exporter/README.md`).

Placeholders in this page: `<wazuh-host>` is the Wazuh server, `<pbc-grc-host>` is the PBC-GRC server, `<user>` is a
user name. Replace them with your own values. Nothing here needs the internet after the exporter is installed.

Things marked **(to verify on site)** are written from knowledge of Wazuh 4.x and were not checked against the customer's
Wazuh: menu names, whether a call is allowed, and one permission.

How it fits together: the **exporter** (a small Python program) reads the Wazuh **indexer** (port 9200) and pushes the
results to PBC-GRC with a service token. The Wazuh manager API (port 55000) is a different service with different users;
the exporter does not need it when `WAZUH_MODE=indexer`.

## 1. Ask the Wazuh administrator for these, in advance

Send this list before the visit.

1. **The Wazuh version.** Wazuh 4.8 and later has the index the exporter reads (`wazuh-states-vulnerabilities-*`). Before
   4.8 there is no such index and you must use `WAZUH_MODE=api` instead (a manager API user, port 55000). Host inventory
   (hardware and software) needs 4.14 or later.
2. **All-in-one or distributed.** In an all-in-one install the indexer listens on `127.0.0.1:9200` only, which decides
   where the exporter must run (section 3). In a distributed install, ask for the address of one indexer node; the
   exporter takes a single indexer URL and has no failover.
3. **Is the indexer on port 9200 reachable from the PBC-GRC host?** If you do not know, run the test in section 2.
4. **A read-only indexer user.** This is a user of the indexer's security plugin, not a Wazuh manager API user. Ask for:
   * a role with the index permission `read` on `wazuh-states-vulnerabilities-*` and on `wazuh-states-inventory-*`
     (one pattern covers all six inventory indices), and the cluster permission `cluster_composite_ops_ro`
     **(to verify on site: it is believed to be needed for the scroll reads)**;
   * the role **mapped to the user**: open the role, Mapped users, add the user. **The Backend roles field of the user
     does not grant the role**; typing the role name there does nothing.
   * in the Wazuh dashboard this is under Indexer management, Security (Internal users, Roles, Mapped users) **(to
     verify on site: menu names differ between Wazuh versions)**. The administrator may prefer the Dev Tools console
     (`PUT _plugins/_security/api/roles/<role>`, `PUT _plugins/_security/api/internalusers/<user>`,
     `PUT _plugins/_security/api/rolesmapping/<role>`) **(to verify on site)**.
5. **The root CA file** that signed the Wazuh certificates. On the Wazuh host it is
   `/etc/wazuh-indexer/certs/root-ca.pem`. If the administrator only has the installer archive:

   ```
   tar -xOf wazuh-install-files.tar wazuh-install-files/root-ca.pem > root-ca.pem
   ```

   Copy `root-ca.pem` to the host that runs the exporter **before** you run `init`: `init` refuses a CA file that does
   not exist. TLS verification cannot be turned off in the exporter, so a private CA must be supplied.
6. **SSH access to the Wazuh host**, if a tunnel is the plan (section 3).

## 2. Test that the indexer is reachable

Run this from the host that will run the exporter. It asks the indexer who you are; it does not read any scan data.
`curl` prompts for the password, so the password is never on the command line or in your shell history.

Linux:

```
curl --cacert root-ca.pem -u <user> https://<wazuh-host>:9200/_plugins/_security/authinfo
```

Windows (PowerShell; use `curl.exe`, because plain `curl` is a different command in PowerShell):

```
curl.exe --ssl-no-revoke --cacert root-ca.pem -u <user> https://<wazuh-host>:9200/_plugins/_security/authinfo
```

`--ssl-no-revoke` is needed on Windows hosts that cannot reach a certificate revocation server; it does not turn off
certificate verification. Whether the indexer answers on this path for every user is **(to verify on site)**.

How to read the result:

* JSON that lists your user and `roles`: the address, the CA and the password work. If `roles` has nothing with read on
  the two index patterns, the role is not mapped (section 1, item 4).
* "Connection refused" or "Failed to connect": nothing listens at that address. See section 3 (all-in-one installs).
* A certificate error: the CA file is wrong, or the certificate does not list the address you used.
* HTTP 401: wrong user or password, or a Wazuh manager API user was used.

The exporter ignores the proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`); it always connects
directly. If a proxy is the only way out of that segment, ask for a direct route or run the exporter somewhere else.

## 3. Where to run the exporter

| | On the PBC-GRC host | On the Wazuh host |
| --- | --- | --- |
| Indexer address | `https://127.0.0.1:9200` through an SSH tunnel, or `https://<wazuh-host>:9200` if the indexer was opened up | `https://127.0.0.1:9200`, no indexer change |
| Needs | a tunnel that stays up, or a change to the indexer's `network.host` and the firewall | Python 3.11 or later, the exporter and its offline wheelhouse copied onto the Wazuh host, and a route to PBC-GRC |
| Wazuh changes | none with a tunnel | none, but you install software on the administrator's host |

The all-in-one certificate is issued for `127.0.0.1` **(to verify on site)**, which is why a tunnel works and a direct
connection to the LAN address fails with "IP address mismatch".

**Option A: on the PBC-GRC host with an SSH tunnel.** Keep this running (a service, `tmux`, or a scheduled task):

```
ssh -N -L 9200:127.0.0.1:9200 <user>@<wazuh-host>
```

Then set `WAZUH_INDEXER_URL=https://127.0.0.1:9200`.

**Option B: on the Wazuh host.** Install the exporter there (see the README, section 2, for the offline wheelhouse) and
set `WAZUH_INDEXER_URL=https://127.0.0.1:9200`. The host needs a route to PBC-GRC on 443.

**Option C (last resort): open the indexer.** On the Wazuh host set `network.host` in
`/etc/wazuh-indexer/opensearch.yml` to a list such as `[127.0.0.1, <LAN IP>]`, restart `wazuh-indexer`, and open port 9200
in the firewall for the exporter host. The indexer certificate must then list that LAN IP.

## 4. PBC-GRC must be reachable the way the token needs

The server refuses service tokens over plain http: creating the token, `whoami` (`check`) and the push all answer HTTP 403
`vm_insecure_transport`. Choose one:

* **HTTPS (recommended).** Put the shipped nginx config in front of the app and set `TRUST_PROXY`; the steps are in
  `docs/GO_LIVE_CHECKLIST.md` (section 3). Use `https://<pbc-grc-host>` as `PBC_URL`. With a private CA, copy that CA file
  to the exporter host and set `PBC_CA_BUNDLE` to it.
* **Development only, on an isolated network segment: plain http.** The default Docker install serves the app on
  `http://<pbc-grc-host>:3000`. Set `VM_ALLOW_INSECURE_TOKENS=true` on the PBC-GRC server (the token then crosses the
  network in clear text) **and** `PBC_ALLOW_INSECURE_TRANSPORT=true` on the exporter. Both are required: the exporter flag
  alone only removes the exporter's own refusal. Do not use this on a production or customer-facing network.

## 5. Create the service token in PBC-GRC

1. Sign in as a Tenant Owner or MSP Admin of the organization (over HTTPS, or the development setting above).
2. Profile menu, **API Keys & Service Tokens**, **VM service tokens**, New service token. Name it after its use (for
   example `Wazuh exporter on <pbc-grc-host>`) and pick an expiry (the screen proposes 90 days).
3. Press **Create token** and copy the value now: it is shown **once** and starts with `pbcvm_`.
4. The same screen shows **Set up the exporter**: it generates the env file text (without the token). You can use that or
   `init` in the next section.

## 6. Install, init, check, dry run, push

Install the exporter (Python 3.11 or later; Linux shown, on Windows use `.venv\Scripts\python.exe`):

```
cd exporters/pbc-vm-exporter
python3 -m venv .venv && .venv/bin/python -m pip install .
```

1. **init**: creates the env file by asking questions. The token and the password are typed without echo and are never
   printed. It never overwrites an existing file.

   ```
   .venv/bin/pbc-vm-exporter init --env-file ./pbc-vm-exporter.env
   ```

   It asks for the PBC-GRC URL, the source label (keep it stable: a new label is a new source), an optional PBC-GRC CA
   file, the service token, the Wazuh indexer URL, the user, the password and the Wazuh CA file. A plain `http://` URL is
   accepted only after you answer `y` to "Plain http is for development only. Allow it?"; `init` then also writes
   `PBC_ALLOW_INSECURE_TRANSPORT=true`. On Windows `init` prints an `icacls` command for the file: run it.

2. **check**: tests every connection and credential and sends no scan data.

   ```
   .venv/bin/pbc-vm-exporter check --env-file ./pbc-vm-exporter.env
   ```

   Each step prints `[PASS]`, `[FAIL]`, `[SKIP]` or `[NOTE]`, and a failure has a `hint:` line under it. The exit code is 0
   when nothing failed (2 configuration, 3 Wazuh, 4 contract, 5 PBC-GRC refused, 6 PBC-GRC unreachable).

3. **dry run**: reads Wazuh for real and prints what would be pushed. The output holds host names and the CVE list: treat
   it as CUI and do not paste it outside the enclave.

   ```
   .venv/bin/pbc-vm-exporter --dry-run --env-file ./pbc-vm-exporter.env
   ```

4. **push**:

   ```
   .venv/bin/pbc-vm-exporter --env-file ./pbc-vm-exporter.env
   ```

On Windows replace `.venv/bin/pbc-vm-exporter` with `.venv\Scripts\python.exe -m pbc_vm_exporter`. Afterwards check the
run and the assets in PBC-GRC (`docs/SCANNER_INTEGRATIONS.md`, section 2.5) and schedule a daily run (README, section 8).

## 7. Troubleshooting

`check` prints `[FAIL] n. <step>: <detail>` and a `hint:` line under it; a run prints `error: <message>`. Find the text
in the first column. The second column is the same wording as the exporter's hint.

| Symptom (the error text contains) | Fix |
| --- | --- |
| Connection refused (WinError 10061) to the Wazuh indexer | nothing is listening at that address: a Wazuh all-in-one install binds the indexer to 127.0.0.1:9200 only. Easiest: run the exporter on the Wazuh host with WAZUH_INDEXER_URL=https://127.0.0.1:9200; or keep it here, open an SSH tunnel (ssh -N -L 9200:127.0.0.1:9200 `<user>@<wazuh-host>`) and use WAZUH_INDEXER_URL=https://127.0.0.1:9200; last resort: set network.host in /etc/wazuh-indexer/opensearch.yml (a list such as [127.0.0.1, `<LAN IP>`]), restart wazuh-indexer and open port 9200 in the firewall (the indexer certificate must then list that LAN IP). Otherwise check the firewall for port 9200 |
| Connection timed out | the connection timed out: a firewall is probably dropping traffic from this host to that address and port (indexer 9200, manager API 55000, PBC-GRC 443); open the port from this host |
| ReadTimeout, read timed out | the server accepted the connection but did not answer in time: raise EXPORT_TIMEOUT_SECONDS |
| getaddrinfo failed, Name or service not known | the host name does not resolve from this machine: check the spelling, DNS, or use the IP address |
| unable to get local issuer certificate, self-signed certificate | set WAZUH_CA_BUNDLE to the indexer root CA (/etc/wazuh-indexer/certs/root-ca.pem on the Wazuh host); for the PBC-GRC certificate set PBC_CA_BUNDLE to its CA |
| IP address mismatch, Hostname mismatch, doesn't match | the certificate does not cover the host name or IP in the URL: use a name the certificate lists (check with openssl s_client ... \| openssl x509 -noout -text, Subject Alternative Name), or reissue it with that IP |
| certificate has expired, certificate is not yet valid | the certificate is expired or not yet valid: check this host's clock (timedatectl / w32tm /query /status) and the certificate's validity dates |
| SSLError (plain_http_port), wrong version number | the server at that address speaks plain http, not https: use the HTTPS address of the TLS proxy (development installs: http:// with PBC_ALLOW_INSECURE_TRANSPORT=true on the exporter and VM_ALLOW_INSECURE_TOKENS=true on PBC-GRC) |
| Indexer returned HTTP 401 | the indexer (port 9200) uses its own internal users from the OpenSearch security plugin, not Wazuh manager API users; create the user with the security plugin (see docs/SCANNER_INTEGRATIONS.md) |
| Indexer returned HTTP 403 | the user is known but none of its roles allows read on the indices the exporter reads: give a role the index permission read on wazuh-states-vulnerabilities-* and wazuh-states-inventory-* (and the cluster permission cluster_composite_ops_ro), then add this user under that role's Mapped users (Indexer management, Security, Roles); typing the role name into the user's Backend roles field does not grant it |
| NOTE: indexer roles of this user | these are the roles the indexer applied to this user; if none of them has read on wazuh-states-vulnerabilities-* and wazuh-states-inventory-*, map one under Roles, Mapped users |
| Indexer returned HTTP 404 (index_not_found) | index_not_found: vulnerability detection is probably off in Wazuh, or WAZUH_INDEXER_INDEX is the wrong index name |
| Indexer returned HTTP 302 (any 3xx) | the indexer never redirects: WAZUH_INDEXER_URL probably points at the Wazuh dashboard (port 443); the indexer is port 9200 |
| Wazuh indexer: reachable, 0 documents | the index is empty: vulnerability detection may be off in Wazuh, or WAZUH_INDEXER_INDEX names the wrong index (a run would stop with zero hosts); before Wazuh 4.8 there is no such index: use WAZUH_MODE=api |
| WAZUH_INDEXER_URL ends in :55000 | WAZUH_INDEXER_URL points at port 55000, which is the Wazuh manager API; the exporter reads the indexer on port 9200 |
| WAZUH_API_URL ends in :9200 | WAZUH_API_URL points at port 9200, which is the Wazuh indexer; the manager API listens on port 55000 |
| WAZUH_API_URL is required for this mode | set WAZUH_MODE=indexer to read the indexer only; auto and api modes also need WAZUH_API_URL, WAZUH_API_USER and WAZUH_API_PASSWORD |
| PBC-GRC answers HTTP 403 vm_insecure_transport | PBC-GRC saw plain http: serve the app over HTTPS, and set TRUST_PROXY on the server when a reverse proxy terminates TLS (vm_insecure_transport); for a development install over plain http set VM_ALLOW_INSECURE_TOKENS=true on PBC-GRC and PBC_ALLOW_INSECURE_TRANSPORT=true here |
| PBC-GRC answers HTTP 401 | the service token is wrong, expired or revoked: create a new one in PBC-GRC (API tokens) and paste it |
| PBC-GRC answers HTTP 403 insufficient_scope | the token lacks the vm:ingest scope (insufficient_scope) |
| PBC-GRC is reachable: HTTP 302 (any 3xx) | redirect refused; set PBC_URL to the final https URL |
| contract matches the server: the server's ingest contract differs | upgrade the exporter or the server so both match (--print-contract-sha256 shows this exporter's) |
| Warning: PBC_ALLOW_INSECURE_TRANSPORT is set | PBC_ALLOW_INSECURE_TRANSPORT is set but every URL is https: remove it, it only silences a safety check |

Other messages:

* `PBC_URL must use https (PBC_ALLOW_INSECURE_TRANSPORT is for development only)`: the URL in the env file is `http://`.
  Use the HTTPS address, or for a development install follow section 4 (both flags).
* `PBC_URL: too many invalid answers; nothing was written`: `init` was given three invalid answers in a row; nothing was
  created, run it again.
* `Wazuh returned zero hosts; nothing was sent (an empty export would hide a read failure)`: the index exists but holds no
  vulnerability documents. Check that vulnerability detection is on in Wazuh and that the user's role can read the index
  (section 1, item 4).
* Exit codes: 0 success, 2 configuration, 3 source read error (including zero hosts), 4 payload does not satisfy the
  contract, 5 PBC-GRC refused, 6 PBC-GRC unreachable, 7 partial. The full table is in the README, section 11.
