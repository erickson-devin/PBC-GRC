# SSP import

Upload an existing System Security Plan (PDF or Word), see which controls it describes, review each suggestion next to the
control's current answer, and commit the ones you accept. **Nothing changes in a tenant's controls until a Tenant Owner or
MSP Admin commits suggestions they accepted.**

Two ways to read a document, chosen per import:

* **Rule-based** (always available): a control is found where the document names it.
* **AI analysis** (optional): a local language model (Llama 3.1 8B through Ollama) also reads the document, finds controls it
  describes without naming them, and compares each with the NIST SP 800-171A assessment objectives. Everything stays on this
  server; see [AI analysis](#ai-analysis-local-model).

## Scope

* Frameworks: **CMMC Level 1 and Level 2** only (17 / 110 practices), and only a framework that is part of the tenant's
  assessment program. The document is mapped to the ONE framework you ask for.
* No cross-framework propagation: a match is never copied to equivalent controls of another framework.
* Files: PDF and `.docx` (not legacy `.doc`), up to 50 MB, 500 pages. Scanned documents (no text layer) fail with a clear
  message; OCR is not included.

## Who can do what

| Role | See imports and suggestions, download the original | Upload, accept / edit / reject, commit, delete |
|---|---|---|
| Tenant Owner, MSP Admin | yes | yes |
| Assessor | yes (read-only) | no |
| Viewer | no (the document may contain CUI) | no |

## How a document is matched

1. The text is extracted in an isolated worker thread (memory cap and timeout), so a hostile file cannot take down the API.
2. It is split into sections at headings and at lines that start with a control reference.
3. A control is found by its CMMC identifier (`AC.L2-3.1.1`) or its NIST SP 800-171 number (`3.1.1`).
   * a section that starts with the identifier is the document's description of that control (`CMMC_ID_SECTION`, the
     strongest signal);
   * a section that starts with the bare number is matched less confidently (`NIST_NUMBER_SECTION`), because the number may be
     the document's own section numbering;
   * a reference inside another section is a `MENTION`, with a finding that no section describes it.
4. References to other levels or to identifiers that are not in the catalog are listed ("Other references"), never staged.
   Controls the document never mentions are listed under "Not found in the document".
5. Every suggestion carries a verbatim source quote with its page.

The "Automated checks" shown are simple text checks (a mention with no section; a very brief description; a match by number
only). They are not an assessment of whether a practice is met.

## Safety rules

* Staging tables (`ssp_import_jobs`, `staged_controls`) have row-level security like every tenant table and no foreign key into
  `control_assessments`.
* Commit changes **implementation notes only**, never the status. A control with no answer yet starts as `NOT_STARTED`.
* A suggestion is committed only if the control's answer is unchanged since the suggestion was staged. Otherwise it becomes a
  `CONFLICT`, nothing is written for it, and it can be reviewed again against the current answer.
* The commit attributes the change to the import and the reviewer (`updated_by`).
* The original file is kept in the evidence vault under `tenants/<tenantId>/policies/uploaded/`, separate from evidence and
  from documents the application generates. It is removed only when the import is deleted.

## API

`/api/v1/tenants/:tenantId/ssp-imports`

| Method and path | Purpose |
|---|---|
| `GET /capabilities` | what this install supports and what the caller may do |
| `GET /` | the tenant's imports |
| `POST /` | multipart: `file`, `framework` (`CMMC_L1` or `CMMC_L2`), `analysis` (`rules` default, or `ai`). Responds `202` with the job; `409 ai_unavailable` if AI was asked for and cannot be used |
| `POST /:jobId/cancel` | stop an import that has not finished |
| `GET /:jobId`, `GET /:jobId/file` | the job; the stored original |
| `GET /:jobId/staged` | suggestions, each with the control's current answer |
| `PATCH /:jobId/staged/:id` | `{ reviewState: PENDING \| ACCEPTED \| EDITED \| REJECTED, editedNotes? }` |
| `POST /:jobId/commit` | apply the accepted / edited suggestions; returns `committed` and `conflicts` |
| `DELETE /:jobId` | remove the import, its suggestions and the stored document |

Tests: `npm run test:ssp-import`.

## AI analysis (local model)

Needs a local Ollama server. `docker-compose.yml` includes one with GPU support as an optional profile: add
`COMPOSE_PROFILES=ai` to `.env` (or run `docker compose --profile ai up -d`), then load the model once with
`docker compose exec ollama ollama pull llama3.1:8b`. Ollama is not a dependency of the app, so a host without a GPU still
starts and imports use rule-based matching. To use an Ollama already running on the host instead, set
`OLLAMA_BASE_URL=http://host.docker.internal:11434` (on Linux add `extra_hosts: ["host.docker.internal:host-gateway"]` to the
app service). The variables are in `.env.example`; outside Docker, set `SSP_AI_ENABLED=true`.

**Documents never leave your network.** The base URL comes from server configuration only. A host that is not on this machine
or a private network (loopback, RFC 1918, a bare Docker service name, `*.local` / `*.internal`) is refused, unless an operator
sets `OLLAMA_ALLOW_REMOTE=true`. The platform never downloads a model: an air-gapped install loads it ahead of time.

**Checked before work starts.** When the AI option is chosen the upload is refused with the reason (switched off, Ollama
unreachable, or the model not installed and how to load it) before anything is stored. The model is checked again when the
job starts; if it has gone away, or fails on the first sections, the import completes with the rule-based result and a warning
instead of failing.

### How the analysis works

1. The text is split into sections of at most 5,000 characters.
2. Each section is matched against the control catalog with BM25 (keyword ranking, no embeddings) and only the best few
   controls, plus any the section names outright, are offered to the model. Sections that match nothing (a cover page, a
   glossary) are not sent at all.
3. The model is asked, with a JSON-Schema-constrained answer at temperature 0, which offered controls the section describes the
   implementation of, with a short summary and a **quotation**.
4. **Grounding** (`server/ssp/grounding.ts`): a finding is kept only if
   * its control is a control of the framework being mapped *and one that was offered for that section*, and
   * its quotation appears word for word in that section (ignoring case, spacing, line breaks and typographic dashes and
     quotes; a paraphrase, a reordering or an added word does not match). The quotation is stored as the document's own text
     with its position and page, never as the model's rendering of it.
   Everything else is discarded and counted; the review screen says how many.
5. Findings are combined into one suggestion per control. A control the rules found by its identifier but the model did not
   confirm stays as a rule-based suggestion, so the AI can add and sharpen but never remove.
6. **Gap analysis** (`server/ssp/gapAnalysis.ts`): for each suggestion the model is given the requirement, the official 800-171A
   objectives ([a], [b], [c]...) and the document's own text for that control, and says whether each objective is addressed.
   A claim of *addressed* or *partly* stands only if it cites a passage that really is in the document; otherwise the objective
   is shown as *not supported by the text*. An objective nothing addresses always produces a gap. The tally in the summary is
   computed from the verified results, not taken from the model.

The model has no tools and no network, and the document is passed as delimited data with an instruction to ignore anything in it
that looks like an instruction. Whatever a document says, an AI suggestion cannot reach the review screen without a verified
quotation, and nothing reaches a control without a person committing it.

### Small models (3B) and tuning

The defaults are tuned for a small model such as Llama 3.2 3B with a 4096-token context, which is fast but weak at judgement:

* **Few, clear candidates.** At most 4 controls are offered per section, and only ones that score at least 9 and at least half
  of the best match. On realistic text the right control scores 10-25 and unrelated ones 0-6.
* **A control the section does not name must be earned.** The model's quotation is ranked against the whole catalog (the
  same keyword ranking, not the model); the claimed control must be in the top 3 and score at least 4, otherwise the finding is
  discarded (`LOW_SUPPORT`). A real sentence attached to the wrong control is exactly what a small model produces.
* **Confidence is mostly computed, not reported.** A small model's own confidence is nearly always high, so it counts for 15%.
  The rest is how well the quotation fits the control (35%), whether the section names the control (30%) and FULL/PARTIAL
  coverage (20%). Suggestions below 0.5 never reach the review screen (`LOW_CONFIDENCE`).
* **Extractive gap analysis (default).** For each assessment objective the model gets one small question: copy the one sentence
  of the control's own text that shows how the objective is met, or answer NONE. (One question per objective, because a small
  model skips items when asked for a list.) The program then does the rest:
  * a copied sentence counts if it is verbatim in the document, or if it is a near-miss of exactly one sentence of it (a word
    or two changed, and clearly closer to that sentence than to any other); the evidence shown is always the document's own
    sentence;
  * one sentence supports at most two objectives, so a model that repeats itself cannot claim everything;
  * the sentence is the model's choice of what speaks to the objective. The result is therefore "a supporting sentence was
    found", not "the objective is met"; the reviewer judges whether it is enough;
  * **weak matches are flagged.** If the sentence shares fewer than two distinctive words with the objective (one for a
    one-word objective), the objective is still shown with its sentence, but in amber with "Check: shares few words with this
    objective", and the summary counts how many to check. On a real run this marks the loose pairings (a sentence about guest
    accounts offered for "devices are identified", a log-retention sentence offered for "logs are created to enable monitoring")
    and leaves the sound ones alone. It is a cheap warning, not a verdict: a sentence can share words and still miss the point;
  * an objective the model gave no answer for is **not assessed**, which is different from having no supporting sentence. It
    is reported as one note naming the objectives, never as a "nothing documented" gap;
  * the HIGH "no supporting sentence" gap appears only when every objective got a real answer and none has a sentence;
  * which objectives have a sentence, the gaps, their severity, the recommendations and the summary are all written by the
    program from those results, so they cannot be invented or repetitive.

  Verdicts are only *sentence found* / *no sentence found* / *could not be checked* / *not assessed*; there is no "partly".

| Variable | Default | Effect |
|---|---|---|
| `SSP_AI_MAX_CANDIDATES` | 4 | controls offered per section |
| `SSP_AI_RETRIEVAL_MIN_SCORE` | 9 | minimum keyword score to be offered |
| `SSP_AI_MIN_CONFIDENCE` | 0.5 | suggestions below this are discarded |
| `SSP_AI_GAP_MODE` | extractive | `narrative` lets the model write the comparison itself: for 8B and larger |

Raise the first two and lower the confidence floor if a larger model misses real controls; the review screen's "discarded"
count (and the reasons, kept with each import's statistics) shows what the filters are removing.

### Limits and expectations

* The model only reports what the document **says**. It cannot tell whether the organisation really does it, and a sentence it
  picks for an objective is a candidate for you to judge, not a finding that the objective is met.
* Every suggestion shows the model's summary next to the document's own quotation; review one against the other.
* A long document takes minutes (one model call per relevant section, plus one per control for the gap analysis). Progress is
  shown, and a running import can be cancelled; nothing is staged for a cancelled import. `SSP_AI_MAX_SECTIONS` caps the work,
  and `SSP_AI_GAP_ANALYSIS=false` skips the second pass.
* Scope is still CMMC Level 1 and Level 2 only.

Tests: `npm run test:ollama` (client), `test:ssp-grounding`, `test:ssp-analyze` (pipeline against a scripted fake model) and
`test:ssp-import-ai` (through the API). None of them needs a GPU or a model.
