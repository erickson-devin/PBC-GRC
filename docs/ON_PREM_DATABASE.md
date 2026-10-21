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
  npx tsx scripts/createLocalUser.ts you@example.mil "Your Name"
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
step follows; the counter is reset when the whole sign-in completes. Each sign-in uses two requests of the 20 per minute per
IP address allowed (behind a reverse proxy with `TRUST_PROXY` unset, people share the proxy's address).

**Forced password change (`must_change_password`, NIST 3.5.9).** A password typed by an operator is temporary. Accounts created with
`npm run auth:create-user` and accounts whose password a platform administrator reset have `must_change_password` set. Until they change it,
their session can only call the password-change endpoint (every other request answers 403 `password_change_required`); a
successful change clears the flag and issues a new session. The change asks for the current password and, when a factor is
enrolled, a current code.

**Platform administrator account actions** (Administration console, `/api/v1/platform/users`, platform administrators only):
*reset password* (sets a temporary password, removes the person's second factor and recovery codes, ends their sessions,
clears a lockout, and forces a change at their next sign-in), *reset MFA* (removes the factor and recovery codes, ends their
sessions; they enrol again at their next sign-in if required), *disable* (blocks sign-in, ends their sessions, removes the
factor) and *enable* (allows sign-in again and clears a lockout; the factor is not restored). **An administrator cannot do
any of these to their own account** (409); their own password change goes through the account settings. Each action logs the
actor's and the target's email address.

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
