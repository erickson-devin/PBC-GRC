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

**Multi-factor authentication (NIST SP 800-171 3.5.3).** The app provides single-factor password sign-in (12+ characters,
bcrypt, lockout, throttling) and has no second factor of its own. Until TOTP lands in local auth (planned for Phase 5.9),
meet 3.5.3 with an external control: a VPN that enforces MFA, or a jump host. The app must **not** be configured to trust
an identity header from a proxy: if the port is reachable without the proxy, that would let anyone sign in as anyone.

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
