# Go-live checklist (on-premises, Docker Compose + TLS reverse proxy)

This is the order an operator follows to take Event Horizon: Singularity into production on one host, with the checks that
prove each step. It assumes the bundled `docker-compose.yml` (app, PostgreSQL 16, optional Ollama) and a TLS reverse proxy
on the same host (the shipped `nginx.conf` is the reviewed sample). Details live in `docs/ON_PREM_DATABASE.md`
(database, secrets, first run, upgrade) and `docs/VULNERABILITY_MANAGEMENT.md` (scanner integration, §2.3 for the
environment table). Commands use the default names (`singularity-app`, `singularity-db`, `cmmc_compliance_db`, `grc_app`);
substitute yours.

The app itself speaks plain HTTP and trusts exactly one proxy address (`TRUST_PROXY`). TLS, HSTS and the public port are
the proxy's job; the security headers, the cookie session and the request limits are the app's.

## 1. Before installing

- [ ] **Host.** Docker Engine with Compose v2; a supported Linux; the host clock synchronised (`timedatectl` shows
      `System clock synchronized: yes`). Two-step codes, session expiry, scanner SLAs and the history retention cutoff all
      use this clock.
- [ ] **Disk.** Size the volumes for the database, the evidence directory and the scanner payloads (every scanner push is
      kept as the assessor-grade record, up to 64 MB each by default; there is no automatic deletion of them yet). Put
      `DB_DATA_DIR` and `EVIDENCE_DIR` outside any git checkout, on encrypted, access-controlled storage.
- [ ] **Image.** Decide the release: a `sha-<commit>` tag from `ghcr.io/erickson-devin/pbc-grc`, written down, never
      `latest` (a rollback needs a name). Air-gapped host: `docker pull` and `docker save` on a connected machine,
      `docker load` on the host. Note the expected `buildCommit` (the full commit SHA) for the health check below.
- [ ] **Ollama (optional).** Pull the model offline (`llama3.2:3b` is what the CMMC import is tuned for) and keep
      `OLLAMA_BASE_URL` pointing at the compose service (`http://ollama:11434`) or at loopback. Never at another LAN host:
      SSP text would travel to it over plain HTTP. `OLLAMA_ALLOW_REMOTE` stays unset.
- [ ] **TLS certificate.** Full chain plus key (key mode `0600`) from the enclave's CA, with a SAN matching the host name
      that people and scanners will use. Put the CA certificate where each scanner host can reference it
      (`PBC_CA_BUNDLE`).

## 2. Configuration (`.env` next to `docker-compose.yml`, mode `0600`)

Required:

- [ ] `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` (long random values; `openssl rand -hex 24`).
- [ ] `LOCAL_AUTH_SECRET` (`openssl rand -hex 32`, 32 characters or more). Losing it signs everyone out; losing it without
      `MFA_ENCRYPTION_KEY` ends every enrolled second factor. Keep a copy in a vault.
- [ ] `MFA_ENCRYPTION_KEY` (32 characters or more), so the authenticator secrets survive a `LOCAL_AUTH_SECRET` rotation.
- [ ] `APP_PUBLISH_ADDRESS=127.0.0.1` so the app port is reachable only through the proxy (the container keeps listening on
      `0.0.0.0` inside its network). Check after start: `curl -m5 http://<LAN-IP>:3000/api/v1/health` must fail.
- [ ] `TRUST_PROXY` = the proxy's address **as the app sees it**: with the compose file's fixed subnet and nginx on the
      host that is the bridge gateway, `172.30.0.1`; for a source install behind a local proxy, `loopback`. Never `true`
      and never a hop count (the app refuses to start). Wrong value symptoms: the session cookie lacks `Secure`, scanner
      token creation answers 403 `vm_insecure_transport`, and the log shows a `[Proxy]` warning.
- [ ] `SETUP_TOKEN` (or `PLATFORM_ADMIN_EMAILS`) **before the first start** if anyone else can reach the host: the
      first-time setup wizard is otherwise claimable by the first person who opens the page.

Recommended:

- [ ] `MFA_REQUIRED` left at its default `all` (`privileged` is a rollout stage, `off` warns at startup and is not for production).
- [ ] `LOCAL_AUTH_TOKEN_TTL_SECONDS` left at 28800 (8 h); the app warns above 43200 (12 h, NIST SP 800-63B AAL2).
- [ ] `ALLOW_TENANT_CREATION=false` for a single-organisation install (platform administrators provision tenants). Leave it
      on only for an MSP install where every signed-in person may create their own tenant.
- [ ] `ASSESSMENT_EVENT_RETENTION_DAYS` left at 1095 (three years) unless your records policy says otherwise; `0` keeps
      the control change history forever.
- [ ] `DB_USER` is the application role (`grc_app`), never `postgres`: the server refuses a SUPERUSER or BYPASSRLS role in
      production because row-level security, and with it tenant isolation, would be bypassed.
- [ ] Nothing from the development block (`DB_MODE=memory`, `ALLOW_DEV_MOCK_TOKENS`, `VM_ALLOW_INSECURE_TOKENS`,
      `OLLAMA_ALLOW_REMOTE`) is set.

## 3. Reverse proxy

- [ ] Install the sample as `/etc/nginx/conf.d/pbc-grc.conf`, edit the `server_name` and certificate paths, then
      `nginx -t && systemctl reload nginx`. Open only 443 (and 80, which redirects) in the host firewall.
- [ ] The sample is TLS 1.3 only. Every supported browser and the scanner exporter negotiate it; uncomment the TLS 1.2 line
      only for a client that cannot, and keep the cipher list that comes with it.
- [ ] Keep the access-log format from the sample: it records the path but not the query string or the Referer, because an
      invitation link carries its one-time token in the URL.
- [ ] HSTS is sent by the proxy (`max-age=31536000`, no `includeSubDomains`, no `preload`: enclave host names are
      internal and preload is permanent).
- [ ] Body size (`100m` on `/api/`) and timeouts (`300s` on `/api/`) match the app's limits: evidence upload 100 MB, scanner
      push 100 MB, SSP upload 50 MB, and the AI wording helper that waits up to `OLLAMA_TIMEOUT_MS` (240 s). The SSP import
      itself is asynchronous and unaffected by proxy timeouts.

## 4. First start

- [ ] `docker compose up -d` (add `--profile ai` for the bundled Ollama). Then `docker compose logs singularity-app` shows
      `[Startup] Database mode: postgres`, `[PostgreSQL] Database schema, control mappings, and RLS policies verified.`,
      the `Assessment history retention` line, and no `[FATAL]`. A misconfiguration exits with code 1 and
      `restart: unless-stopped` loops it: read the log before anything else. Understand every `[Startup]` warning.
- [ ] `docker exec singularity-app npm run db:verify-rls` exits 0 and prints "neither SUPERUSER nor BYPASSRLS". Run it on
      the empty database, **before** the setup wizard (it writes and removes `rls_verify_*` rows). Never run
      `db:verify-vm` or `db:prove-control-serialization` against a production database: they are for a throwaway one.
- [ ] Complete the setup wizard at once (it locks for good afterwards), or, with `PLATFORM_ADMIN_EMAILS` set, create each
      listed administrator with `docker exec -e LOCAL_USER_PASSWORD singularity-app npm run auth:create-user -- <email> "<name>"`.
      A listed administrator address can never be created through a tenant invitation; the wizard or this command are the
      only ways.
- [ ] The first administrator enrols two-step verification and stores the recovery codes away from the phone.

## 5. Verify from the outside

Replace `grc.example.mil` with the host name on the certificate.

- [ ] **TLS.** `openssl s_client -connect grc.example.mil:443 -servername grc.example.mil -tls1_2 </dev/null` fails;
      the same with `-tls1_3` succeeds; `-servername other.example.mil` is refused (`ssl_reject_handshake`).
- [ ] **Headers.** `curl -sI https://grc.example.mil/` shows `strict-transport-security`, `content-security-policy` (with
      `frame-ancestors 'none'` and `script-src 'self'`), `x-frame-options: DENY`, `x-content-type-options: nosniff`,
      `referrer-policy: no-referrer`, `permissions-policy`; it shows **no** `x-powered-by` and a `server:` header without a
      version. `curl -sI https://grc.example.mil/api/v1/health` shows `cache-control: no-store`.
- [ ] **Health.** `curl -s https://grc.example.mil/api/v1/health` reports `"status":"ok"`, `"database":"connected"` and
      the `buildCommit` you wrote down. (It answers 503 `starting` until the schema check has finished.)
- [ ] **Cookie.** `curl -si -X POST https://grc.example.mil/api/v1/auth/logout | grep -i set-cookie` shows `HttpOnly`,
      `SameSite=Strict`, `Path=/api` and `Secure`. No `Secure` means `TRUST_PROXY` or `X-Forwarded-Proto` is wrong.
- [ ] **Setup closed.** `curl -s -X POST https://grc.example.mil/api/v1/setup -H 'Content-Type: application/json' -d '{}'`
      answers 409 (or 403 with a `SETUP_TOKEN`), never 200.
- [ ] **Loopback only.** From another machine on the LAN, port 3000 is closed; only 443 (and 80) answer.
- [ ] **Sign in** through the browser, open one control, type a note, reload: the note is there. Upload one evidence
      file and open its preview.

## 6. Vault, logs and monitoring

- [ ] `ls -ld "$EVIDENCE_DIR" && ls -l "$EVIDENCE_DIR"`: new files are owner-only (`-rw-------`). A vault created by an
      earlier release may hold `0644` files: `chmod -R go-rwx "$EVIDENCE_DIR"` once.
- [ ] Container logs rotate (the compose file sets `max-size: 50m`, `max-file: 5` per service); or set the Docker daemon's
      `log-opts` globally. Treat stdout as sensitive when shipping it to a SIEM: it carries pseudonymous account
      references, client addresses and tenant ids, never notes, file names or secrets. Watch for `[Auth] Failed`,
      `[Startup]` warnings, `[PostgreSQL Pool Error]`, `[Retention]` errors and `[Shutdown]`.
- [ ] The health probe is quiet: one `[PostgreSQL] Successfully connected` line at start, not one per probe.
- [ ] Exactly one `singularity-app` container runs. The scanner scheduler and the history retention sweep run inside the
      process and are not coordinated across replicas.
- [ ] Disk alerting on `DB_DATA_DIR` and `EVIDENCE_DIR`.

## 7. Backups

- [ ] Nightly: a `pg_dump` **and** a copy of `EVIDENCE_DIR` taken together (the commands are in docs/ON_PREM_DATABASE.md,
      "Upgrading"). Keep 30 daily and 12 monthly copies, plus one taken before every upgrade. Keep `.env` in a vault, not
      in the backup set.
- [ ] Backups hold CUI: same access controls as the database directory, never a shared drive.
- [ ] **Restore drill, quarterly, on a scratch host**: create the application role (a fresh volume's init script does it),
      `pg_restore` the dump, unpack the evidence directory, start the app with the same `.env`, sign in, open one control's
      history and one evidence file. A backup that has never been restored is a hope, not a backup.

## 8. Scanner integration (optional)

- [ ] Create the service token from an HTTPS session (the app refuses token creation and scanner pushes over plain HTTP
      unless `VM_ALLOW_INSECURE_TOKENS=true`, which is not for production). Expiry 90 to 180 days.
- [ ] On the scanner host: `PBC_URL=https://grc.example.mil` (exact host, the exporter follows no redirect),
      `PBC_CA_BUNDLE` for a private CA, `PBC_ALLOW_INSECURE_TRANSPORT` unset. The host needs to reach only port 443 on the
      proxy; there is no forward-proxy support yet.
- [ ] Rotation: create the new token, update the scanner, revoke the old one.

## 9. Upgrades

- [ ] Backup (section 7), then keep `.env` unchanged, set the new `sha-` tag, `docker compose pull && docker compose up -d`.
- [ ] Health shows the new `buildCommit` and `connected`; sign in; read the log for `[PostgreSQL]` notes (first start after
      some releases builds indexes or backfills, which can take a moment).
- [ ] Rollback = restore the pre-upgrade dump and evidence copy, then start the previous tag. The previous tag alone may not
      boot against the newer data.

## 10. Known gaps, tracked

- The container runs as root inside the image (#146); vault files are owner-only through the umask meanwhile.
- The published image is not smoke-tested or signed before publish; version tags and digest pinning are not published yet.
- Scanner payloads and snapshots have no retention setting (#61).
- Password history / reuse checks (IA.L2-3.5.8) and an idle session lock (AC.L2-3.1.10) are not implemented.
- Forward-proxy support for the exporter (#67).
