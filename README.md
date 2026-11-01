# PBC-GRC ("Event Horizon: Singularity")

An on-premises compliance platform for organisations that handle Federal Contract Information and Controlled Unclassified
Information. It runs entirely on your own hardware: nothing it stores, generates or analyses leaves the machine.

**Frameworks shipped:** CMMC 2.0 Level 1 and Level 2, NIST SP 800-53 Rev. 5 (with the SP 800-53B baselines), AICPA SOC 2
Type II, and the HIPAA Security Rule.

## What it does

* **Assessment programs.** One installation hosts any number of tenants (enclaves). Each tenant runs an assessment program:
  a primary framework plus any additional frameworks enabled for it. Controls carry a status, an implementation narrative,
  per-objective answers and a history of who changed what. [docs/ASSESSMENT_PROGRAMS.md](docs/ASSESSMENT_PROGRAMS.md)
* **Evidence vault.** Evidence files live on local disk with their SHA-256, attached to controls, with previews and an
  integrity check. Documents and CUI never leave the host.
* **Generated documents.** System Security Plan, Plan of Action & Milestones, system description and attestation
  drafts, built only from what was recorded. Anything not recorded prints as "not recorded" rather than an invented value,
  and the export dialog lists the gaps before you export.
* **SSP import.** Upload an existing SSP (PDF or Word) and review which controls it describes. Reading is rule-based, or
  with a local Ollama model when one is installed. Suggestions are staged for a person to accept; nothing changes a control
  until a Tenant Owner or MSP Admin commits it. [docs/SSP_IMPORT.md](docs/SSP_IMPORT.md)
* **Vulnerability and configuration results.** Scanner data arrives through a push model: an exporter inside the enclave
  reads your scanner and posts to the platform with a service token. Vulnerability findings get lifecycle tracking,
  remediation deadlines and draft POA&M items; configuration-scan results (XCCDF / ARF from any SCAP-capable scanner)
  produce per-control suggestions that a person accepts or not. A periodic snapshot writes the evidence an assessor expects.
  The first adapter reads Wazuh; the contract is vendor-neutral. [docs/VULNERABILITY_MANAGEMENT.md](docs/VULNERABILITY_MANAGEMENT.md),
  [exporters/pbc-vm-exporter](exporters/pbc-vm-exporter/README.md)
* **Identity.** Local accounts with bcrypt passwords, TOTP second factor on by default, recovery codes, idle lock,
  per-tenant roles, an account event log, and no external identity provider.

Automation never sets a control's status. Scanner results, imports and AI output only ever produce suggestions that a
named person records.

## Architecture

| Part | Stack |
| --- | --- |
| Client | React 19, Vite, TypeScript, Tailwind (`src/`) |
| Server | Node 22, Express 5, `pg` (`server/`) |
| Database | PostgreSQL 16 with row-level security per tenant; the app connects as a non-superuser role |
| Storage | Local disk only (`data/evidence`, or the host path you mount) |
| AI (optional) | Ollama on the same host or Docker network; remote hosts are refused |
| Exporter | Python 3.11, `requests` only (`exporters/pbc-vm-exporter/`) |

Tenant isolation is enforced by PostgreSQL row-level security, not only by application code, and the live checks that
prove it run in CI against a real database.

## Install (Docker Compose)

Everything needed is in this repository: `docker-compose.yml`, `nginx.conf` for the TLS reverse proxy, `.env.example`
for the settings, and the published image at `ghcr.io/erickson-devin/pbc-grc`.

```bash
cp .env.example .env     # set POSTGRES_PASSWORD, APP_DB_PASSWORD, LOCAL_AUTH_SECRET, MFA_ENCRYPTION_KEY
docker compose pull
docker compose up -d
```

Open the app, complete the first-time setup wizard (it creates the first administrator and tenant, then locks itself),
and put a TLS proxy in front of port 3000 before anyone else uses it. The full procedure, including the settings to check
and the verification steps, is in [docs/GO_LIVE_CHECKLIST.md](docs/GO_LIVE_CHECKLIST.md); database, identity, paths,
releases and upgrades are in [docs/ON_PREM_DATABASE.md](docs/ON_PREM_DATABASE.md).

Releases are SemVer tags (`vX.Y.Z`) published as image tags; pin `IMAGE_TAG` to one, never `latest`. Versions below 1.0.0
are pre-release builds.

## Develop

```bash
npm install
npm run dev          # Vite on 5173 and the API on 3000
```

The API needs a database or `DB_MODE=memory` plus a `LOCAL_AUTH_SECRET` (32+ characters) in a local `.env`; the memory
store is for development only and is refused in production.

| Gate | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Tests | `npm run test:all` (tsx script suites against the in-memory store; about two minutes) |
| Exporter | `cd exporters/pbc-vm-exporter && python -m pytest -q` (in a venv: `pip install -e ".[dev]"`) |
| Live database checks | `npm run db:verify-rls` and `npm run db:verify-vm` against a throwaway PostgreSQL |

CI runs the first four on every pull request and the live checks against a real PostgreSQL; the publish workflow repeats
them on `main` and smoke-tests the built image against a database before pushing it.

## Repository layout

```
src/                 client (React), shared types, shipped framework catalogs, document compilers
server/              API, schema and row-level security, identity, SSP import, vulnerability management
tests/               test suites (tsx scripts)
scripts/             live PostgreSQL verification, NIST data generation, account tools
exporters/           pbc-vm-exporter (push-side scanner exporter, Python)
docs/                operator and design documentation
docker/, Dockerfile, docker-compose.yml, nginx.conf
```

## Documentation

* [Go-live checklist](docs/GO_LIVE_CHECKLIST.md)
* [On-premises database, identity and releases](docs/ON_PREM_DATABASE.md)
* [Assessment programs and platform administrators](docs/ASSESSMENT_PROGRAMS.md)
* [SSP import](docs/SSP_IMPORT.md)
* [Vulnerability management design](docs/VULNERABILITY_MANAGEMENT.md)
* [Connecting scanners: Wazuh, SCAP files, Action1, SentinelOne](docs/SCANNER_INTEGRATIONS.md)
* [Exporter](exporters/pbc-vm-exporter/README.md)
* [Privacy policy](docs/PRIVACY_POLICY.md) and [terms of service](docs/TERMS_OF_SERVICE.md)

## Contributing

Work on a feature branch and open a pull request against `main`; CI must be green, including the live PostgreSQL checks.
No new runtime dependencies without discussion: the on-premises install is supply-chain sensitive, and base images and
actions are pinned by digest. Generated catalogs under `src/data/frameworks/` are verified against their sources with
`npx tsx scripts/generateNist80053.ts --check`.
