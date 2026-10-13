# SSP import (Phase 1)

Upload an existing System Security Plan (PDF or Word), see which controls it describes, review each suggestion next to the
control's current answer, and commit the ones you accept. **Nothing changes in a tenant's controls until a Tenant Owner or
MSP Admin commits suggestions they accepted.**

Phase 1 is rule-based (no AI): a control is found where the document names it. A later phase adds a local LLM (Ollama) for
narrative extraction and gap analysis; the staging area and review flow below do not change.

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
| `POST /` | multipart: `file`, `framework` (`CMMC_L1` or `CMMC_L2`). Responds `202` with the job |
| `GET /:jobId`, `GET /:jobId/file` | the job; the stored original |
| `GET /:jobId/staged` | suggestions, each with the control's current answer |
| `PATCH /:jobId/staged/:id` | `{ reviewState: PENDING \| ACCEPTED \| EDITED \| REJECTED, editedNotes? }` |
| `POST /:jobId/commit` | apply the accepted / edited suggestions; returns `committed` and `conflicts` |
| `DELETE /:jobId` | remove the import, its suggestions and the stored document |

Tests: `npm run test:ssp-import`.
