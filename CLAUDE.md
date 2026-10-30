# CLAUDE.md: PBC-GRC ("Event Horizon: Singularity")

On-prem CMMC / NIST compliance platform: React + Vite client (`src/`), Express 5 + pg server (`server/`), tsx script tests (`tests/`), shipped catalogs in `src/data/frameworks/`. The push-side vulnerability exporter lives in `exporters/pbc-vm-exporter/` (Python 3.11, `requests` only; its tests run with `npm run test:exporter` inside a venv, `npm run scanner:test` is its offline dry run). `scanner-agent/` is gitignored and unrelated.

## Commands & gates

Node is on PATH (v24 locally; CI and the Dockerfile use Node 22, `engines` is `>=22.13`). Run from the repo root.

| Gate | Command | Baseline (2026-10-30, branch `fix/pre-deployment-batch`) |
| --- | --- | --- |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| Build | `npm run build` (`tsc && vite build`) | exit 0 |
| Tests | `npm run test:all` (about 2m) | exit 0: 69 suites, 5170 of 5170 assertions |
| One suite | `npx tsx tests/<name>.test.ts` (or `npm run test:<name>`) | each prints a final `📊 TEST RESULTS: n / n` line |
| Node 22 (what CI runs) | `npx -y -p node@22 -- npm run test:all` | passes |
| Exporter (Python) | `cd exporters/pbc-vm-exporter && python -m pytest -q` (venv: `python -m venv .venv`, then `pip install -e ".[dev]"`) | 227 passed, 1 skipped (POSIX-only); CI job "exporter" |

* CI (`.github/workflows/ci.yml`) runs two jobs on every PR to `main`: `test` (the three gates: typecheck, build, tests) and `exporter` (pytest plus the offline dry run); `docker-publish.yml` repeats them on `main` before publishing an image. There is no lint, format, locale or spec-parity gate, and no linter or formatter is configured: **match the surrounding style by hand**. `/test` runs all of the above.
* Suites run against the in-memory store (`DB_MODE=memory`, set by `tests/testEnv.ts`): no database or secrets. Suites that boot the server share **port 8080**, so **never run two of them at the same time**.
* `npx tsx scripts/generateNist80053.ts --check` verifies the generated NIST data (`src/data/frameworks/nist80053/*.generated.json`) against NIST's sources (needs network the first time).
* `git remote`: only `origin` (https://github.com/erickson-devin/PBC-GRC.git). The GitHub CLI (`gh`) is **not installed** on this machine; if it is installed later, pass `--repo erickson-devin/PBC-GRC` to every `gh` command.

## Constraints

* No direct pushes to `main`: work on a feature branch, push it, the user opens and merges the PR. Commit and push only when asked.
* Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
* No new dependencies without asking (the on-prem install is supply-chain sensitive). No Puppeteer or browser-test tooling in the repo (browser checks live in a scratch folder).
* Documents and CUI never leave the machine; the local Ollama client refuses non-local hosts. AI output is untrusted and is only ever staged for human review, never written to a control directly.
* CMMC (Level 1 / 2) behaviour of the SSP import is tuned for `llama3.2:3b` (candidate limit 4, BM25 floor 9, confidence floor 0.5, extractive gap analysis): do not change it as a side effect of other work.
* Gotchas: source files mix LF and CRLF; shell heredocs lose backslashes (use the Write / Edit tools for code with regexes); never junction or symlink `node_modules` into a git worktree (removing the worktree wipes the real one).

# Multi-Agent Workflow Rules

1. You act as the Orchestrator. For small, single-file edits, you may write code directly.
2. For complex, multi-file, or architectural tasks, you must use the subagents (`analyst`, `ui-ux`, `coder`, defined in `.claude/agents/`).
3. When using subagents, ALWAYS delegate investigation and planning first: to the `analyst` for data, server and logic work, to `ui-ux` for screens, flows and accessibility (a change that needs both gets the analyst first, then `ui-ux` for the UI part). Neither writes code.
4. Review the plan: take items that need a product decision, would add a dependency, or whose tests are timing/load-dependent to the user as Part B (with a recommendation each) instead of handing them to a coder. Then delegate implementation to the `coder`.
5. Trust but Verify: NEVER accept the coder's self-reported results. Independently run the full test suites AND every CI gate (typecheck, build, `test:all`; there is no lint or parity gate here), check exit codes, and read the non-test diff before declaring the task complete.
6. Baseline first: run the suites before dispatching any coder so its effect is measurable (current baseline in the table above).
7. Parallelism: split a large audit into scoped analysts running concurrently; split implementation into coders with DISJOINT file sets. Any file two plans touch goes to exactly one coder. Coders must not run server-booting suites concurrently (shared port 8080): the orchestrator runs the full suite, alone.
8. Subagent reports are model output, not ground truth: verify claims that matter.
9. Commits: only when asked; one atomic commit per area (`fix(api): …`, `fix(web): …`, `docs: …`), with the rationale in the body and `Closes #n` where applicable.
10. Outward-facing actions (gh issue/PR create, push, anything on another org's repo): always pass `--repo` explicitly; confirm the target before running.
