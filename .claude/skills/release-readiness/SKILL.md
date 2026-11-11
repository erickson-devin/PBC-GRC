---
name: release-readiness
description: Pre-release check for PBC-GRC's on-prem Docker deployment - Dockerfile and docker-compose.yml pinning and hardening, environment variable validation and wiring, idempotent PostgreSQL schema changes with row-level security, third-party licence notices, and the Vite bundle size. Use before tagging a release, bumping the version or IMAGE_TAG, merging a branch that touches Dockerfile, docker-compose.yml, docker/, server/schema.ts, server/db.ts, env vars or vite.config.ts, or when the user asks whether something is ready to ship or deploy.
---

# Release readiness (PBC-GRC)

Deployment: one image (`ghcr.io/erickson-devin/pbc-grc`, multi-stage `node:22-alpine`, `tsx server/index.ts` serving `dist/`) plus `postgres:16-alpine` and an optional `ollama` profile, orchestrated by `docker-compose.yml` on-prem / air-gapped (offline bundle: `scripts/build-offline-bundle.sh`, `docs/OFFLINE_INSTALL.md`). `docker-publish.yml` publishes only from `main` after CI. Report findings; do not push, tag or publish.

## 1. Gates (each as its own command, check exit codes)

```bash
npm run typecheck
npm run build
npm run test:all
npx tsx tests/onPremOnly.test.ts
```

Add `npx -y -p node@22 -- npm run test:all` (CI's Node) and, if `exporters/` changed, `cd exporters/pbc-vm-exporter && python -m pytest -q` and `npm run scanner:test`. Baseline is in `CLAUDE.md`.

## 2. Docker and build config

- Every base image is pinned by digest (`Dockerfile` both stages, compose `postgres` and `ollama`), and the CI `live-postgres` service uses the same postgres digest (checked by `tests/onPremOnly.test.ts`). No `latest` anywhere.
- `npm ci` (not `npm install`); runtime stage uses `--omit=dev`; no global npm installs.
- `generateThirdPartyNotices.ts` still runs in the image; any new production dependency's licence is in `ALLOWED_LICENSES` (otherwise the image build fails).
- Runs as `USER node`; `HEALTHCHECK` hits `/api/v1/health`; `init: true` kept so SIGTERM reaches `server/shutdown.ts`.
- `.dockerignore` still excludes `.env`, `.env.*`, `data/`, `.git`, `.claude/`, `scanner-agent/`, `exporters`.
- Version agreement: `package.json` `version`, compose default `IMAGE_TAG`, `server/version.ts` and the release notes agree.
- Database port stays bound to `127.0.0.1`; app connects as `APP_DB_USER` (never the superuser, which bypasses RLS).

## 3. Environment variables

For every env var added or changed in the diff (`git diff main...HEAD | grep -oE 'process\.env\.[A-Z_]+' | sort -u`):
- Validated at startup with a clear error, failing closed (pattern: `LOCAL_AUTH_SECRET` >= 32 chars in `server/auth/localAuth.ts`, `assertDbModeAllowed` in `server/db.ts`, `isNonProductionEnv` in `server/runtimeEnv.ts`). Empty string means the built-in default.
- Listed in `docker-compose.yml` `singularity-app.environment` (compose passes **no** `env_file`, so an unlisted var never reaches the container), with `${VAR:?…}` for required secrets.
- Documented in `.env.example` and the relevant `docs/*.md` (`ON_PREM_DATABASE.md`, `VULNERABILITY_MANAGEMENT.md`, `SSP_IMPORT.md`, `GO_LIVE_CHECKLIST.md`).
- Test-only switches (`DB_MODE=memory`, `ALLOW_DEV_MOCK_TOKENS`) are still refused in production.
- SSP AI defaults unchanged for `llama3.2:3b` (candidate limit 4, BM25 floor 9, confidence floor 0.5) unless the release is about that.

## 4. Database migration safety

There is no migration tool: `buildSchemaSql()` in `server/schema.ts` runs at every startup against existing installs, so each statement must be idempotent and safe on populated data.
- `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`; constraints via `DROP CONSTRAINT IF EXISTS` then `ADD`.
- A new `NOT NULL` column has a `DEFAULT` or a backfill (see `scripts/backfillProgramIds.ts`); a new or tightened `CHECK` must accept every existing row.
- No `DROP COLUMN` / `DROP TABLE` / type narrowing / rename without an explicit upgrade note in `docs/ON_PREM_DATABASE.md`.
- New tenant or program tables are in `RLS_TENANT_TABLES` / `RLS_PROGRAM_TABLES` (ENABLE + FORCE RLS), and the memory emulator in `server/db.ts` matches.
- Changes to `docker/postgres/10-app-role.sh` only run on a fresh volume: existing installs need documented manual steps.
- Needs a real PostgreSQL (CI job `live-postgres` runs them): `npm run db:verify-rls` (includes the upgrade rehearsal), `npm run db:verify-vm`, `npm run db:prove-control-serialization`. If not run locally, say so.

## 5. Bundle size

```bash
npm run build
```

Compare the `dist/assets` sizes Vite prints with the same build on `main` (`git stash` is off-limits; build `main` in a separate checkout or compare against the last CI log). Flag any chunk over `chunkSizeWarningLimit` (1500 kB; only the generated NIST 800-53 catalog is expected near it), new code landing in the entry chunk instead of a `manualChunks` group in `vite.config.ts`, a heavy library (`pdfjs-dist`, `mammoth`, `jszip`) imported eagerly instead of with `import()`, and a growth over about 10% without a reason.

## 6. Report

A go / no-go table: gate, command, result (exit code and `TEST RESULTS` totals verbatim), then blockers, warnings and what was not verified (live PostgreSQL, Docker image build, GPU / Ollama profile, Unraid).
