---
name: edge-case-qa
description: Write PBC-GRC tests (tsx script suites in tests/, pytest for the Python exporter) that cover empty states, API and Ollama timeouts, malformed or oversized payloads, and role, tenant and program permission boundaries. Use when adding or changing a route, service, hook or view, when the user asks for more tests, edge cases or QA coverage, or before opening a PR on a feature branch.
---

# Edge-case QA (PBC-GRC)

There is no Jest, Vitest or Playwright, and browser tooling must not be added to the repo. Tests are plain TypeScript scripts run with `tsx`, each with its own `assert` helper and a final `📊 TEST RESULTS: n / n` line. "End to end" here means a suite that boots the real Express server in memory mode and calls it with `fetch`.

## 1. Pick the suite shape

- **Server / API suite**: first line `import './testEnv';` (sets `PORT=8080`, `NODE_ENV=test`, `DB_MODE=memory`, mock tokens), then `import { server } from '../server/index';`. Copy the `assert`, `mockJwt`, `tokenFor`, `call` and `shutdown` helpers from `tests/rbac.test.ts` and `firstProgram` from `tests/programFixture.ts`. Never `process.exit()` while sockets are open (libuv assertion on Windows); follow `shutdown()` there.
- **Pure logic / client suite**: import the module under test (`src/utils/*`, `src/services/*`, `server/*` helpers) with no server; see `tests/controlEditPlan.test.ts` or `tests/markdownBlocks.test.ts`.
- **Exporter**: `exporters/pbc-vm-exporter/tests/` with pytest; fake Wazuh and PBC-GRC, no network.

Extend the existing suite for the area before creating a new one. A new suite must be added to both a `test:<name>` script and the `test:all` chain in `package.json`, or CI never runs it.

## 2. Cases to cover (name each `input -> expected`)

**Empty states**: no tenant memberships, a tenant with no programs, a program with zero controls / evidence / assets / software, empty arrays and empty strings in bodies, a first-run setup (`tests/setupWizard.test.ts`). The API returns `200` with `[]`, not `404` or a crash.

**Timeouts and unavailable dependencies**: Ollama down or slower than `OLLAMA_TIMEOUT_MS` falls back to rule-based matching (see `tests/ollama.test.ts`, `tests/aiAvailabilityView.test.ts`); client code handles a rejected `fetch` and an `ApiError` from `src/services/apiClient.ts` without losing unsaved text (`tests/unsavedText.test.ts`). Fake timers by injecting the clock or fetch, never with real sleeps.

**Malformed payloads**: wrong types, missing required fields, unknown enum values, over-length strings, non-JSON body, invalid IDs (`../`, SQL fragments, unicode), oversize uploads, a spoofed MIME type on an upload, an ingest body over `VM_INGEST_MAX_BYTES`, a zod-rejected ingest (`server/vm/ingestSchema.ts`). Expect `400`/`413`/`415` with a stable `error` shape and no stack or CUI in the body.

**Permission boundaries** (the most important set):
- Each mutating route as `VIEWER` and `ASSESSOR` -> `403`; as `TENANT_OWNER` and `MSP_ADMIN` -> success.
- Missing / malformed / expired / revoked token -> `401`; mock token with `ALLOW_DEV_MOCK_TOKENS` unset -> `401`.
- Tenant A token with `x-tenant-id` of tenant B -> `403`, and the row is not visible (`tests/tenantIsolation.test.ts`).
- Program A's record requested with `x-program-id` of program B -> not found; archived program -> read-only.
- `pbcvm_` service token with the wrong scope -> `403`; a user session on a service route -> `401`.
- Framework not enabled for the tenant -> refused (`tests/tenantFrameworkPolicy.test.ts`).

**Concurrency**: two simultaneous writes to the same control or item end with one consistent row and a monotonic `updated_at` (`Promise.all` against the memory store; true row locking needs `npm run db:prove-control-serialization` on PostgreSQL).

## 3. Rules

- Compute expected counts from data in the test (for example `getFrameworkControls(...)`), never a hard-coded number you did not verify.
- Never weaken an existing assertion to go green. If a case fails because of a real bug, keep the test, report the bug.
- Do not change the SSP import tuning (candidate limit, BM25 floor, confidence floor) to make a test pass.
- Do not touch `src/data/frameworks/**`, `src/data/stigs/**` or the frozen `server/ssp/*` files.

## 4. Run

```bash
npx tsx tests/<name>.test.ts
npm run typecheck
```

Run server-booting suites one at a time (port 8080), then `npm run test:all` alone at the end. For the exporter: `cd exporters/pbc-vm-exporter && python -m pytest -q`. Report the `TEST RESULTS` line verbatim.
