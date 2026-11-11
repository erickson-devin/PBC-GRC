---
name: security-and-logic-audit
description: Audit new or modified PBC-GRC code (Express 5 routes in server/, React views in src/, the Python exporter) for auth and RBAC bypasses, tenant/program isolation leaks, input validation gaps, exposed secrets or CUI, and race conditions. Use when reviewing a diff, branch or PR before merge, after touching server/routes, server/middleware, server/db.ts, server/schema.ts or server/auth, or when the user asks for a security, logic or authorization review.
---

# Security and logic audit (PBC-GRC)

Stack: Express 5 + `pg` (PostgreSQL 16 with row-level security) in `server/`, React 19 + Vite in `src/`, local bcrypt + HKDF-signed sessions with TOTP MFA, `pbcvm_` service tokens for the exporter, local Ollama only. Read-only review: report findings, do not edit unless asked.

## 1. Scope the diff

```bash
git diff --stat main...HEAD
git diff main...HEAD -- server src exporters docker Dockerfile docker-compose.yml
```

List every new or changed route, middleware, SQL statement, schema change, env var and client call to `src/services/apiClient.ts`.

## 2. Checklist (cite `file:line` per finding)

**Authentication and authorization**
- Every router mounted in `server/routes/api.ts` sits behind `authMiddleware` (tenant-scoped) or `authOnlyMiddleware` (platform). Unauthenticated mounts are only `/auth`, `/setup`, `/invites`, `/vm` (ingest, which uses `serviceTokenMiddleware(scope)`) and `/health`. A new unauthenticated route is a finding.
- Program-scoped data (`/controls`, `/objectives`, `/ssp-metadata`, `/evidence`, anything in `RLS_PROGRAM_TABLES`) also needs `programContext`.
- Mutating handlers (`post/put/patch/delete`) call `requireWriteRole` (only `TENANT_OWNER` and `MSP_ADMIN` write; `ASSESSOR` and `VIEWER` are read-only, see `src/utils/roles.ts`), plus `ensureActiveTenant` / `ensureTenantAdmin` from `server/routes/tenantGuards.ts` where relevant, and `ensureControlInFrameworkPolicy` for control IDs.
- Dev mock tokens and `DB_MODE=memory` must stay refused in production (`server/runtimeEnv.ts` fails closed; `assertDbModeAllowed` in `server/db.ts`). Any new `NODE_ENV` check must use `isNonProductionEnv`, not `=== 'production'`.
- Session revocation: changes to password, MFA or role must bump `token_version`; idle and revoked sessions return the `SESSION_*` reasons in `authMiddleware.ts`.

**Tenant and program isolation**
- Tenant data is queried only through `queryWithTenant` / `queryWithProgram` / `queryWithUser` (they `set_config('app.current_tenant_id' …)`). A raw `pool.query` on a tenant table is a finding.
- A new tenant table is added to `RLS_TENANT_TABLES` (and `RLS_PROGRAM_TABLES` if program-scoped) in `server/schema.ts`; the in-memory emulator in `server/db.ts` mirrors it so the suites see it.
- Never trust `x-tenant-id` / `x-program-id` alone: membership is checked (`isTenantMember`, `getTenantRole`).

**Input validation**
- Request bodies are validated before use (hand-written `validate*Input` like `server/softwareItems.ts`, or `zod` as in `server/vm/ingestSchema.ts`): type, length caps, enums, ID formats. All SQL uses `$n` parameters; no string-built SQL from input.
- Uploads (`multer` in `server/routes/sspImports.ts`) cap size and check the real type with `file-type` (`server/ssp/extract.ts`), not the client MIME or extension; evidence file names and hashes never reach a filesystem path unsanitised (`server/evidence/storage.ts`).
- SSP import documents may hold CUI: only roles passing `canRoleReviewSspImports` (`src/utils/roles.ts`) may see them; `VIEWER` sees none.
- `/api/v1/vm/ingest` bypasses the 15 MB JSON parser in `server/index.ts`: it must enforce `VM_INGEST_MAX_BYTES` itself.

**Secrets and CUI**
- No secrets in code, tests (except the fixed `testEnv.ts` value) or logs; `.env*` stay untracked (`git ls-files | grep -i '\.env'` shows only `.env.example`).
- No notes, narratives, document text or file names in `console.*`, error responses, history events or the browser audit ledger. No `dangerouslySetInnerHTML` (the repo has none).
- `server/ssp/ollama.ts` refuses non-local hosts; AI output only lands in `staged_controls`, never written to a control without a human action.
- Exporter (`exporters/pbc-vm-exporter`): TLS verification stays on, tokens never logged.

**Races and logic**
- Read-modify-write on a row uses a transaction with `SELECT … FOR UPDATE` (see `npm run db:prove-control-serialization`); `updated_at` stays monotonic.
- Check-then-act on uniqueness (invites, setup wizard lock, token creation) is enforced by a DB constraint, not just an `if`.
- Login throttling (`server/auth/loginThrottle.ts`) and `createRateLimiter` cover any new credential or token endpoint.
- Error paths do not leak whether a tenant, user or resource exists to a non-member.

## 3. Verify

```bash
npm run typecheck
npx tsx tests/rbac.test.ts
npx tsx tests/tenantIsolation.test.ts
npx tsx tests/programScoping.test.ts
```

Run server-booting suites one at a time (shared port 8080). RLS and `FOR UPDATE` behaviour is invisible to the in-memory store: flag changes that need `npm run db:verify-rls` against a real PostgreSQL (CI job `live-postgres`).

## 4. Report

Findings ranked by severity: title, `file:line`, concrete exploit or failure scenario, suggested fix, and the test that would catch it. Say explicitly what you could not verify (live PostgreSQL, exporter against a live manager).
