import { Router, Request, Response } from 'express';
import type { ProgramScope } from '../db';
import { DOCUMENT_STATUS, DocumentError } from '../documents/registerStore';
import {
  changeProgramDocuments,
  linkDocumentAttachment,
  putDocumentControls,
  putExpectationLinks,
  readProgramDocuments,
  setAttachmentPrimary,
  unlinkDocumentAttachment,
} from '../documents/programDocumentsStore';
import { EXPECTED_CATALOG } from '../documents/expectedCatalog';
import type { InventoryActor } from '../inventory/events';
import { StaleWriteError } from '../controlAssessments';
import { requireWriteRole } from '../middleware/roleGuard';
import { programCatalogIds } from '../programs';
import { errorMessage } from '../../src/utils/errors';
import { applicableExpected } from '../../src/data/documents/expectedDocuments';
import {
  DOCUMENT_EVIDENCE_ID_PATTERN,
  DOCUMENT_ID_PATTERN,
  EXPECTED_DOCUMENT_ID_PATTERN,
  validateAttachmentInput,
  validateDocumentControlsInput,
  validateDocumentIdChange,
  validateExpectationInput,
  validatePrimaryInput,
} from '../../src/data/documents/documentSchema';

/**
 * A program's side of the document register (issues #240, #250). Mounted at /api/v1/program-documents after authMiddleware and programContext (the
 * program comes from x-program-id; an archived program answers 409 program_archived to writes).
 *
 *   GET    /                                              { programId, declared, documentIds, controlLinks, attachments, expectations }   any member
 *   PATCH  /documents                                     { add?, remove?, force? } the declared set, as deltas   TENANT_OWNER / TENANT_ADMIN / MSP_ADMIN
 *   PUT    /documents/:id/controls                        { controlIds, expectedControlIds } (the whole set is replaced)
 *   POST   /documents/:id/attachments                     { evidenceId, primary? } -> 201 { attachment, changed }, or 200 when the pair was already linked
 *   PATCH  /documents/:id/attachments/:evidenceId         { primary } -> { attachments }
 *   DELETE /documents/:id/attachments/:evidenceId         -> { removed }
 *   PUT    /expectations/:expectedId                      { documentIds, expectedDocumentIds } -> { expectedId, documentIds, changed }
 *
 * The program's history is GET /program-inventory/events (the actions that start with document_). VIEWER and ASSESSOR are strictly read-only
 * (requireWriteRole). Control ids and expected-document ids are catalog codes, not CUI; titles, owners, locations and notes of the documents never
 * reach this API, its history or its logs. The server never opens an attachment or fetches a location.
 */
const router = Router();
router.use(requireWriteRole);

const scopeOf = (req: Request): ProgramScope => ({ tenantId: req.tenantId!, programId: req.programId! });
const actorOf = (req: Request): InventoryActor => ({
  actor: req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor',
  userId: req.user?.uid ?? null,
});

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof StaleWriteError) {
    res.status(409).json({ error: 'The entry was changed by someone else after you loaded it.', code: 'stale_write', current: err.current });
    return;
  }
  if (err instanceof DocumentError) {
    res.status(DOCUMENT_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code, ...(err.details ?? {}) });
    return;
  }
  // errorMessage only: a database error can carry the row's values
  console.error('[Program Documents API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

const invalid = (res: Response, field: string, code = 'invalid'): void => void res.status(400).json({ error: `${field} is invalid`, code, field });
const documentNotFound = (res: Response): void => void res.status(404).json({ error: 'The document was not found in this organization', code: 'document_not_found' });

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await readProgramDocuments(scopeOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to read the program documents');
  }
});

/** PATCH /documents: { add?, remove?, force? } -> { programId, declared, documentIds, added, removed }; 409 document_in_use unless force. */
router.patch('/documents', async (req: Request, res: Response): Promise<void> => {
  const parsed = validateDocumentIdChange(req.body);
  if (!parsed.ok) return invalid(res, parsed.field, 'invalid_document_ids');
  try {
    const result = await changeProgramDocuments(scopeOf(req), parsed.value, actorOf(req));
    if (result.added + result.removed > 0) console.log(`[Program Documents API] ${req.user?.uid} changed the document set of program ${result.programId} in ${req.tenantId} (+${result.added} -${result.removed})`);
    res.json(result);
  } catch (err) {
    sendError(res, err, 'Failed to change the document set');
  }
});

/** PUT /documents/:id/controls: { controlIds, expectedControlIds } -> { documentId, controlIds, changed } (sorted; the whole set is replaced). */
router.put('/documents/:id/controls', async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!DOCUMENT_ID_PATTERN.test(id)) return documentNotFound(res);
  const parsed = validateDocumentControlsInput(req.body);
  if (!parsed.ok) return invalid(res, parsed.field);
  try {
    res.json(await putDocumentControls(scopeOf(req), id, parsed.value.controlIds, parsed.value.expectedControlIds, programCatalogIds(req.program!), actorOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to save the control links');
  }
});

/** POST /documents/:id/attachments: { evidenceId, primary? } -> 201 { attachment, changed: true }, or 200 { attachment, changed } when the pair was already linked. */
router.post('/documents/:id/attachments', async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  if (!DOCUMENT_ID_PATTERN.test(id)) return documentNotFound(res);
  const parsed = validateAttachmentInput(req.body);
  if (!parsed.ok) return invalid(res, parsed.field);
  try {
    const { attachment, created, changed } = await linkDocumentAttachment(scopeOf(req), id, parsed.value, actorOf(req));
    res.status(created ? 201 : 200).json({ attachment, changed });
  } catch (err) {
    sendError(res, err, 'Failed to attach the file');
  }
});

router.patch('/documents/:id/attachments/:evidenceId', async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const evidenceId = String(req.params.evidenceId);
  if (!DOCUMENT_ID_PATTERN.test(id) || !DOCUMENT_EVIDENCE_ID_PATTERN.test(evidenceId)) {
    res.status(404).json({ error: 'Attachment not found', code: 'not_found' });
    return;
  }
  const parsed = validatePrimaryInput(req.body);
  if (!parsed.ok) return invalid(res, parsed.field);
  try {
    const attachments = await setAttachmentPrimary(scopeOf(req), id, evidenceId, parsed.value.primary, actorOf(req));
    if (!attachments) {
      res.status(404).json({ error: 'Attachment not found', code: 'not_found' });
      return;
    }
    res.json({ attachments });
  } catch (err) {
    sendError(res, err, 'Failed to change the primary copy');
  }
});

router.delete('/documents/:id/attachments/:evidenceId', async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const evidenceId = String(req.params.evidenceId);
  if (!DOCUMENT_ID_PATTERN.test(id) || !DOCUMENT_EVIDENCE_ID_PATTERN.test(evidenceId)) {
    res.status(404).json({ error: 'Attachment not found', code: 'not_found' });
    return;
  }
  try {
    if (!(await unlinkDocumentAttachment(scopeOf(req), id, evidenceId, actorOf(req)))) {
      res.status(404).json({ error: 'Attachment not found', code: 'not_found' });
      return;
    }
    res.json({ removed: evidenceId, documentId: id });
  } catch (err) {
    sendError(res, err, 'Failed to remove the attachment');
  }
});

/**
 * PUT /expectations/:expectedId: { documentIds, expectedDocumentIds } -> { expectedId, documentIds, changed }. The expected id must be an entry of the
 * shipped catalog that applies to this program (its framework and baseline); anything else is 400 unknown_expected_document.
 */
router.put('/expectations/:expectedId', async (req: Request, res: Response): Promise<void> => {
  const expectedId = String(req.params.expectedId);
  const applicable = EXPECTED_DOCUMENT_ID_PATTERN.test(expectedId) ? applicableExpected(EXPECTED_CATALOG, req.program!.frameworkId, programCatalogIds(req.program!)) : [];
  if (!applicable.some((e) => e.id === expectedId)) {
    res.status(400).json({ error: 'That expected document is not part of this program\'s checklist', code: 'unknown_expected_document' });
    return;
  }
  const parsed = validateExpectationInput(req.body);
  if (!parsed.ok) return invalid(res, parsed.field);
  try {
    res.json(await putExpectationLinks(scopeOf(req), expectedId, parsed.value.documentIds, parsed.value.expectedDocumentIds, actorOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to save the checklist link');
  }
});

export default router;
