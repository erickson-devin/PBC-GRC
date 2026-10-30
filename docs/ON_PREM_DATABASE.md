# On-premises database and identity setup

## Why the application must not use the database admin account

Row-level security (RLS) is what keeps one tenant's data away from another. PostgreSQL **superusers and roles with
`BYPASSRLS` skip RLS entirely**, even with `FORCE ROW LEVEL SECURITY`. The app therefore connects as an ordinary role
(`grc_app` by default). `docker compose up` creates it automatically on a fresh volume
(`docker/postgres/10-app-role.sh`).

Required settings (in a `.env` file next to `docker-compose.yml`, or exported):

| Variable | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | database admin password (bootstrap only) |
| `APP_DB_PASSWORD` | password of the application role |
| `LOCAL_AUTH_SECRET` | 32+ random characters that sign sessions: `openssl rand -hex 32` |

## First-time setup

On a new installation there is no account yet. Open the application in a browser: when no platform administrator and no local user exist,
every address shows the **setup wizard** (`/#setup`) instead of the sign-in page. It asks for

1. your company name (this creates the first tenant),
2. the application owner's email and password (12+ characters): this account becomes the platform administrator and owns the tenant,
3. optionally, the email addresses of teammates to invite.

When it finishes you are signed in, and the wizard shows one invitation link per teammate to copy and hand out (an air-gapped
server sends no email; the links are shown once, and new ones can be issued later under Team settings).

**The wizard locks itself permanently the moment it completes.** From then on `/setup` is an unknown path (it goes to the
sign-in page) and `POST /api/v1/setup` answers `409`. The lock is a database row that no code path deletes, so it stays closed
even if the administrator is later removed, and it is taken with one atomic insert, so two simultaneous requests cannot both
succeed. Setup is also closed whenever `PLATFORM_ADMIN_EMAILS` is set.

A fresh install is open until someone completes the wizard, so do that before exposing the server to a wider network. To make
that safe by construction, set `SETUP_TOKEN` (any secret string) in the app container's environment: the wizard then asks for
it, and a request without it is refused.

Recovery (a forgotten password, or an account that must exist before the wizard runs) is still possible on the server:

```bash
docker compose exec -e LOCAL_USER_PASSWORD='a long passphrase, 12+ chars' singularity-app \
  npm run auth:create-user -- you@example.mil "Your Name"
```

## Network exposure

The app listens on `APP_BIND_ADDRESS` (default `0.0.0.0`, all interfaces) and the compose file publishes `APP_PORT`
(default `3000`) on all interfaces, so the Unraid WebUI is reachable on the LAN out of the box. The server logs one line at
startup when it is bound to all interfaces. The app speaks plain HTTP; see
`docs/VULNERABILITY_MANAGEMENT.md` §2.3 for the TLS requirement on service tokens.

To restrict access:

* Put a reverse proxy on the same host. With compose, change the published port to `127.0.0.1:${APP_PORT:-3000}:3000` (the
  app inside the container must keep listening on `0.0.0.0`, or Docker cannot forward the published port to it). For a
  source install, set `APP_BIND_ADDRESS=127.0.0.1`.
* Use the host firewall to limit which networks can reach `APP_PORT`.
* Reach the app only over a VPN.
* With a TLS proxy, set `TRUST_PROXY` to the proxy's address and have the proxy send `X-Forwarded-Proto: https`, so the
  session cookie is marked `Secure` (and service-token creation is allowed).

The database and the other internal services are never exposed to the network: PostgreSQL is published on `127.0.0.1`
only (`${DB_PORT:-5432}`), and Ollama (the optional `ai` profile) publishes no port and is reachable only on the internal
Docker network.

**Multi-factor authentication (NIST SP 800-171 3.5.3).** The app enforces a TOTP second factor according to `MFA_REQUIRED` (on for
everyone by default); see "Multi-factor authentication" below. The app must **not** be configured to trust an identity header from a
proxy: if the port is reachable without the proxy, that would let anyone sign in as anyone.

## Multi-factor authentication

The app has its own second factor, so NIST SP 800-171 3.5.3 no longer depends on an external control (a VPN that enforces
MFA is still good practice for network access, see "Network exposure"). **It is on by default.**

**What it is.** TOTP (RFC 6238: 6 digits, 30 seconds, SHA-1) with any authenticator app. At enrolment the server shows an
`otpauth://` URI and the secret as text (there is no QR image: type or paste the secret, or open the URI on a phone) and the
person confirms with a first code. They then get **8 single-use recovery codes, shown once** (format `XXXXX-XXXXX`, letters
and digits without the easily confused `I`, `L`, `O`, `U`); save them somewhere other than the phone. Signing in is two steps:
the password, then a code from the app (or a recovery code). The second step is only reachable with the short-lived proof that
the password step succeeded; the proof works once.

**`MFA_REQUIRED`** (environment variable; read on every sign-in):

| Value | Who must hold a second factor |
| --- | --- |
| `all` (default, also when empty) | every local account |
| `privileged` | platform administrators (`PLATFORM_ADMIN_EMAILS` and the first administrator), tenant owners (`TENANT_OWNER`) and MSP administrators (`MSP_ADMIN`) |
| `off` | nobody is required to. Anyone who has already enrolled is still asked for a code at sign-in |

Any other value stops the server at startup. With `off` in production (`NODE_ENV=production`) the server logs a warning at
startup, because 3.5.3 is then not met by the application.

**Staged rollout (the operator's job; the server does not stage it for you).** Set `MFA_REQUIRED=privileged`, restart, let
the administrators and tenant owners enrol, then remove the variable (or set `all`) and restart. Whenever a person is
required to hold a factor and has none, they are asked to enrol **at their next sign-in** (no grace period): the password
step is followed by the enrolment screen, and no session is issued until the first code is confirmed. All sessions signed
before the upgrade that introduced this feature end at the upgrade (sessions are now signed with a derived key), so
everyone signs in again.

**First administrator and invitations.** The first-time setup wizard enrols the first administrator inline (a platform
administrator is always privileged), unless `MFA_REQUIRED=off`: the wizard returns the enrolment step instead of a session
and continues once the first code is confirmed. A person who registers through an invitation is asked to enrol straight away
when `MFA_REQUIRED` requires it for them (always under `all`; under `privileged` when the invited role is `TENANT_OWNER` or
`MSP_ADMIN`).

**Lockout.** A wrong or replayed code counts like a wrong password: five consecutive failures lock the account for 15
minutes (the same counter as password failures). The password step no longer resets that counter on success when a second
step follows; the counter is reset when the whole sign-in completes. The same five-failure lock also applies, in memory, to
any address typed at the sign-in form whether or not an account exists, so the 429 reveals nothing about which accounts exist
(that state is per process and is lost on restart; the stored lock on real accounts is not). Each sign-in uses two requests
of the 20 per minute per IP address allowed. Behind a reverse proxy, set `TRUST_PROXY` to the proxy's address: with it unset,
people share the proxy's address, and the server logs one `[Proxy]` warning when it sees a forwarded request. Failed sign-in
log lines name the account by a keyed reference (an HMAC under a key derived from `LOCAL_AUTH_SECRET`), never by its address.

**Forced password change (`must_change_password`, NIST 3.5.9).** A password typed by an operator is temporary. Accounts created with
`npm run auth:create-user` and accounts whose password a platform administrator reset have `must_change_password` set. Until they change it,
their session can only call the password-change endpoint (every other request answers 403 `password_change_required`); a
successful change clears the flag and issues a new session. The change asks for the current password and, when a factor is
enrolled, a current code.

**Browser sessions (cookie).** The session is an HttpOnly cookie `pbc_session` (SameSite=Strict, Path=/api, lifetime = the
session's, 8 h by default) that page script cannot read and that is never kept in browser storage; the page keeps only a
random session reference. `Secure` is set when the request is HTTPS: TLS at the proxy with `TRUST_PROXY` naming the proxy and
the proxy sending `X-Forwarded-Proto: https`; a plain-HTTP LAN install gets a non-Secure cookie. Cookie requests must carry the
`X-PBC-Session` header, and a cross-site request (`Sec-Fetch-Site`) is refused with 403 `csrf_rejected`. Sign-out
(`POST /api/v1/auth/logout`) clears the cookie. `Authorization: Bearer` still works for scripts; scanners use VM service tokens.
The API sends no CORS headers (same-origin only). Browsers signed in before this release are signed out once at the upgrade.

**Session-ended reasons.** A 401 from the session check carries `reason`: `session_missing` (no session cookie and no bearer), `session_invalid`
(a token the server cannot trust), `session_expired` (an authentic token past its expiry) or `session_revoked` (an authentic
token whose account is gone or disabled, or whose sessions were ended by a password change, an MFA reset or an administrator
action; the three are not told apart). The app's sign-in message follows the reason. Two more reasons never come from the
server: the app uses `signed_out_elsewhere` (another tab of the same browser signed out) and `switched_elsewhere` (another
tab signed in as a different account, replacing the browser's one session cookie). The tab then shows the sign-in screen
without sending a logout request, so the other tab's session is untouched.

**Platform administrator account actions** (Administration console, `/api/v1/platform/users`, platform administrators only):
*reset password* (sets a temporary password, removes the person's second factor and recovery codes, ends their sessions,
clears a lockout, and forces a change at their next sign-in), *reset MFA* (removes the factor and recovery codes, ends their
sessions; they enrol again at their next sign-in if required), *disable* (blocks sign-in, ends their sessions, removes the
factor) and *enable* (allows sign-in again and clears a lockout; the factor is not restored). **An administrator cannot do
any of these to their own account** (409); their own password change goes through the account settings. Each action logs the
actor's and the target's email address. Each action also needs a fresh code from the administrator's own authenticator
(`code` in the body; recovery codes are not accepted), and a code works once: a wrong or replayed code is 403 `invalid_code`
and counts toward the administrator's lockout, a missing one is 400 `code_required`. An administrator with no factor is
refused (409 `mfa_not_enrolled`) whatever `MFA_REQUIRED` says and must enrol first; `npm run auth:reset-mfa` remains the
break-glass path. A refused code is logged with the keyed account reference only.

**Lost authenticator and lost recovery codes.** Another platform administrator resets the person's MFA (or their password,
which also removes the factor) in the console. For the **last remaining platform administrator** nobody else can do that, so
use the command line at the server's keyboard, with the same `DATABASE_URL` / `DB_*` as the server:

```bash
npm run auth:reset-mfa -- you@example.mil
```

It removes the factor and recovery codes, ends the person's sessions and clears a lockout; they enrol again at the next
sign-in. (It needs PostgreSQL; it refuses `DB_MODE=memory`.) Someone who still holds recovery codes can sign in with one
instead of a code, and a signed-in person can replace their recovery codes with 8 new ones (`POST /api/v1/auth/mfa/recovery-codes`, which needs a fresh app code).

**Secrets and rotation.** Three keys are derived (HKDF-SHA256) with different labels, so none can be used in place of
another: the **session signing** key (from `LOCAL_AUTH_SECRET`), the **TOTP secret encryption** key (AES-256-GCM, bound to the
account row) and the **recovery-code pepper** (a keyed hash, so a stolen database cannot be brute-forced). The last two come
from `MFA_ENCRYPTION_KEY` when it is set (optional, 32 or more random characters, for example `openssl rand -hex 32`) and
from `LOCAL_AUTH_SECRET` otherwise. Plain secrets and recovery codes are never stored or logged.

* **Case A: `MFA_ENCRYPTION_KEY` not set, `LOCAL_AUTH_SECRET` rotated.** Everyone is signed out **and every enrolled factor and
  recovery code becomes unreadable**. At the second step the server answers 503 `mfa_unavailable` (it never falls back to a
  password-only session) until each person's factor is removed with `npm run auth:reset-mfa -- <email>` (or by an
  administrator in the console) and they enrol again.
* **Case B: `MFA_ENCRYPTION_KEY` set, `LOCAL_AUTH_SECRET` rotated.** Everyone is signed out, and the factors survive.
  Set `MFA_ENCRYPTION_KEY` before enrolling people if you expect to rotate the session secret.
* **Rotating `MFA_ENCRYPTION_KEY`** (or setting it on an installation that already has enrolments, or removing it) **always
  destroys the enrolled factors**, as in case A: reset each one with the same command.

**Sessions end immediately.** Every authenticated request checks the account in the database: disabling an account, a
password change, an MFA reset or an administrator password reset ends that person's sessions on their next request (this
costs one extra primary-key lookup per request; if the database is unavailable the answer is 503, not a sign-out).

## Host paths (Docker Compose)

The compose file keeps every host-specific location in a variable, so the same file runs on a laptop and on Unraid. The
defaults are a named volume (database, Ollama models) or the repository folder (evidence, init scripts); the Unraid
installation sets these in the `.env` next to `docker-compose.yml`:

| Variable | Unraid value | Default |
| --- | --- | --- |
| `DB_DATA_DIR` | `/mnt/cache/appdata/singularity/postgres` | named volume `postgres_data` |
| `EVIDENCE_DIR` | `/mnt/cache/appdata/singularity/evidence` | `./data/evidence` |
| `OLLAMA_MODELS_DIR` | `/mnt/user/appdata/singularity/ollama-models` | named volume `ollama-models` |
| `INITDB_DIR` | `/mnt/user/appdata/singularity/docker/postgres` | `./docker/postgres` (the repository copy) |

Changing `DB_DATA_DIR` on an existing installation points PostgreSQL at a different (empty) directory: the init script runs
again there and the old data stays where it was. The Unraid installation also runs `OLLAMA_MODEL=llama3.2:3b` with
`OLLAMA_NUM_CTX=4096` (the model the CMMC import is tuned for), set the same way.

## Assessment history retention

Every control and objective write leaves a history row (who, when, the SHA-256 of the notes, never their text). A daily
sweep inside the app deletes rows older than `ASSESSMENT_EVENT_RETENTION_DAYS`:

* unset: 1095 days (three years: a Level 2 certificate runs three years and the next assessment may look back across the cycle);
* `0`: keep everything;
* 1 to 364: accepted, with a startup warning that an assessment may look back further;
* anything else: nothing is deleted and the startup log says so.

The first sweep runs ten minutes after start, then daily; its log lines carry counts only. To see what a sweep would
delete, or to run one by hand:

```bash
docker exec singularity-app npm run db:prune-assessment-events -- --dry-run
```

(`--days N` overrides the setting for that run; `--tenant <id>` limits it.) The first start after the upgrade that adds this
builds two indexes on the history tables; on a large history that takes a moment and holds up writes while it runs.

## Upgrading to a new release (no wipe)

A release never needs the database wiped. At startup the server applies its schema in place (`CREATE ... IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, constraints dropped and re-added), and data that predates a feature is adopted on first use (for
example, each tenant's existing rows move into its "Default Authorization Boundary" program the first time the tenant is
used). If a release seems to need a wipe, that is a bug: report it instead.

Once a table has no row without a program, startup also finalizes its `program_id` column (the NOT VALID check is validated,
the column becomes NOT NULL and the check is dropped). This never blocks the boot: if a table still has rows that no tenant has
adopted yet, startup logs a warning such as `evidence_metadata: rows without a program remain; program_id stays nullable until
every tenant is backfilled` and tries again at the next start. Tenants that are used adopt their rows on their own. To finish
the job for tenants that nobody uses, take a backup (step 1 below), pick a quiet window (the discovery briefly locks the six
tables) and run the operator script, `--dry-run` first:

```bash
docker exec singularity-app npm run db:backfill-program-ids -- --all --dry-run
docker exec singularity-app npm run db:backfill-program-ids -- --all
```

It prints table names, tenant ids and row counts only, and exits 0 once `program_id` is NOT NULL on all six tables. You can
also name tenants instead of `--all`. A tenant whose `tenant_id` has no tenant record is listed too and gets a default program
like any other.

The unused `ssp_documents` table is dropped at startup when it is empty; a table that still holds rows is kept and logs a
warning (`ssp_documents still holds rows and was not dropped`).

What makes an upgrade safe is the release routine around it:

1. **Back up first.** Create the backup folder once, then before every deploy (`app_db` and `postgres` are this install's
   `POSTGRES_DB` and `POSTGRES_USER`; use yours):

   ```bash
   docker exec singularity-db pg_dump -U postgres -Fc app_db > /mnt/user/appdata/singularity/backups/app_db-$(date +%F-%H%M).dump
   ```

   The dump holds control narratives and other CUI: keep the backup folder on the enclave host, with the same access
   controls as the database directory.
2. **Keep `.env` the same between deploys.** In particular `POSTGRES_DB`, `APP_DB_USER`, `LOCAL_AUTH_SECRET`,
   `MFA_ENCRYPTION_KEY` and every path in the table above. Each one changed by accident looks like data loss: a different
   database name or `DB_DATA_DIR` starts an empty database beside the real one (the real one is untouched), and a different
   `LOCAL_AUTH_SECRET` signs everyone out (and, without `MFA_ENCRYPTION_KEY`, ends every enrolled factor; see "Secrets and
   rotation" above). Changing `POSTGRES_PASSWORD` or `APP_DB_PASSWORD` in `.env` does not change the role's password once
   the database exists: run `docker exec -it singularity-db psql -U postgres -d app_db -c "\password app_user"` (or
   `postgres`) and then update `.env`.
3. **Deploy**, then check: `GET /api/v1/health` reports the new `buildCommit` and `"database":"connected"`, and you can sign in.
4. **If something is wrong, restore** the dump taken in step 1 (stop the app container first so nothing writes meanwhile):

   ```bash
   docker stop singularity-app
   docker exec -i singularity-db pg_restore -U postgres -d app_db --clean --if-exists < /mnt/user/appdata/singularity/backups/app_db-<date>.dump
   docker start singularity-app
   ```

**Stopping the app.** `docker stop singularity-app` (or `docker compose down`) sends SIGTERM, which the server handles: it
stops accepting connections, cancels any SSP import that is running or queued (the import shows "The server was shut down
while this import was running. Upload the document again."), stops the document-reader child processes, closes its database
connections and exits, all within 8 seconds, inside Docker's default 10-second stop timeout. The compose file runs the app with
`init: true`, so the signal reaches the server and leftover processes are reaped. Its log shows `[Shutdown] SIGTERM received`
and `[Shutdown] complete` (signal and counts only, never a document, file or person). A container killed outright
(`docker kill`, power loss) leaves an unfinished import, which is picked up again about two minutes after the next start, when
its tenant's imports are listed.

**Is the app looking at the right database?** If everyone is signed out and nobody can sign in after a deploy, check before
changing anything: `docker inspect singularity-db --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'`
shows the data directory in use, `docker exec singularity-db psql -U postgres -l` lists the databases, and
`docker exec singularity-db psql -U postgres -d app_db -c "SELECT count(*) FROM local_users"` shows whether accounts exist.
`PLATFORM_ADMIN_EMAILS` closes the first-time setup wizard: on an empty database with it set, create the administrator with
`docker exec -e LOCAL_USER_PASSWORD singularity-app npm run auth:create-user -- <email> "<name>"` (set
`LOCAL_USER_PASSWORD` in the shell first, for example with `read -rs LOCAL_USER_PASSWORD && export LOCAL_USER_PASSWORD`).

## Existing data volume (already initialised before this change)

The init script only runs when the volume is first created. For an existing deployment, run once as the admin user:

```sql
CREATE ROLE grc_app WITH LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE cmmc_compliance_db TO grc_app;
GRANT USAGE, CREATE ON SCHEMA public TO grc_app;
-- tables created earlier by the admin user must be owned by (or granted to) the app role:
REASSIGN OWNED BY postgres TO grc_app;   -- run while connected to the application database
```

Then point `DB_USER` / `DB_PASS` at the new role and verify:

```bash
DB_HOST=... DB_USER=grc_app DB_PASS=... DB_NAME=cmmc_compliance_db npm run db:verify-rls
```

The script also proves the vulnerability-management tables' isolation, that the composite foreign keys refuse a finding attached to another tenant's asset, and that the two SELECT-only discovery policies (`app.vm_token_hash` for the service-token lookup, `app.vm_scheduler` for scheduler enumeration) see nothing without their setting. **PostgreSQL 15 or later is required**: the vulnerability-management schema uses `ON DELETE SET NULL (column)`, which older versions reject (the bundled compose file ships 16). Startup now enforces this: `initDb` refuses to continue on PostgreSQL older than 15 and reports `PBC-GRC requires PostgreSQL 15 or later; found <version>`.

## Local development without PostgreSQL

The server never falls back to memory on its own. To use the in-memory store (data is lost on restart; never in
production) set `DB_MODE=memory` explicitly, e.g. in `.env`:

```
DB_MODE=memory
```

## The cloud deployment was retired

A former Google Cloud deployment (Firebase sign-in, Cloud SQL, a GCS evidence bucket) held demo data only and is being shut
down. PBC-GRC is on-premises only: this build refuses to start with an `AUTH_MODE` or `STORAGE_PROVIDER` value other than
`local`.

* Evidence rows that still name a cloud path (`gs://`) or carry a cloud sync status (`gcs_synced`, `gcs_signed_url`) are legacy and cannot be read; the demo data they pointed at is gone with the deployment.
* Accounts from that deployment do not exist here. Create the first administrator with `scripts/createLocalUser.ts` or the
  setup wizard, then invite members.
