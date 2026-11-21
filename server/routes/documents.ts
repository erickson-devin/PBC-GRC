import { Router, Request, Response } from 'express';
import {
  DOCUMENT_STATUS,
  DocumentError,
  approveDocument,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  setDocumentStatus,
  updateDocument,
} from '../documents/registerStore';
import { countDocumentUsage } from '../documents/programDocumentsStore';
import type { InventoryActor } from '../inventory/events';
import { parseExpectedUpdatedAt, StaleWriteError } from '../controlAssessments';
import { MAX_PROGRAMS_PER_TENANT, listPrograms } from '../programs';
import { requireWriteRole } from '../middleware/roleGuard';
import { ensureActiveTenant } from './tenantGuards';
import { errorMessage } from '../../src/utils/errors';
import { DOCUMENT_ID_PATTERN, validateApproval, validateDocumentInput, validateStatusInput } from '../../src/data/documents/documentSchema';
import { MAX_DOCUMENTS_PER_TENANT } from '../../src/types/documents';

/**
 * Document register (issues #240, #250). Mounted at /api/v1/tenants/:tenantId/documents.
 *
 *   GET    /                  { documents, limit }                                                        any member
 *   POST   /                  add a DRAFT document ({ kind, title, ... }; GENERATED needs a seedKey)       TENANT_OWNER / TENANT_ADMIN / MSP_ADMIN
 *   PUT    /:id               change fields (expectedUpdatedAt required) -> { document, changed, approvalCleared }
 *   POST   /:id/approve       { expectedUpdatedAt, version, approvalDate, reviewBy?, confirmReviewed? } -> { document }
 *   POST   /:id/status        { status: 'DRAFT' | 'RETIRED', expectedUpdatedAt } -> { document, changed }
 *   GET    /:id/usage         { programs, controlLinks, attachments, expectations } across the programs
 *   DELETE /:id               remove a document -> { removed }
 *
 * The history is the register history of the Tools and Services register (GET .../inventory/events?entityId=). The RBAC guard is applied here as
 * well as at the tenants router: VIEWER and ASSESSOR are strictly read-only. The approver is the signed-in user, never a name from the body. Titles,
 * owners, locations and notes may be CUI: errors name a field only and the logs carry ids only.
 */
const router = Router({ mergeParams: true });
router.use(requireWriteRole);

const idOf = (req: Request): string => String(req.params.id);
const actorOf = (req: Request): InventoryActor => ({
  actor: req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor',
  userId: req.user?.uid ?? null,
});

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof StaleWriteError) {
    res.status(409).json({ error: 'This document was changed by someone else after you loaded it.', code: 'stale_write', current: err.current });
    return;
  }
  if (err instanceof DocumentError) {
    res.status(DOCUMENT_STATUS[err.code] ?? 400).json({ error: err.message, code: err.code, ...(err.details ?? {}) });
    return;
  }
  // errorMessage only: a database error can carry the row's values
  console.error('[Documents API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

const notFound = (res: Response): void => void res.status(404).json({ error: 'Document not found', code: 'not_found' });

/** A refused body: invalid_location for the location field, invalid otherwise (the field is named, its value never echoed). */
function refuse(res: Response, field: string, reason?: string): void {
  if (field === 'locationUrl' && reason) {
    res.status(400).json({ error: 'The location is not an accepted form (http, https, file://, a network share or a drive path, without credentials)', code: 'invalid_location', field, reason });
    return;
  }
  res.status(400).json({ error: `${field} is invalid`, code: 'invalid', field });
}

/** The stamp the client loaded: required for a change, and a timestamp. Sends the 400 and returns null otherwise. */
function expectedOf(req: Request, res: Response): string | null {
  const expected = parseExpectedUpdatedAt((req.body ?? {}).expectedUpdatedAt);
  if (!expected.ok || typeof expected.value !== 'string') {
    res.status(400).json({ error: 'expectedUpdatedAt must be the timestamp of the document you loaded', code: 'invalid_expected_updated_at' });
    return null;
  }
  return expected.value;
}

/** In how many programs a document is declared, linked, attached or named in the checklist, and how many rows that is (archived programs included). */
async function documentUsage(tenantId: string, id: string): Promise<{ programs: number; controlLinks: number; attachments: number; expectations: number }> {
  const programs = (await listPrograms(tenantId, { includeArchived: true })).slice(0, MAX_PROGRAMS_PER_TENANT);
  const usage = { programs: 0, controlLinks: 0, attachments: 0, expectations: 0 };
  for (const p of programs) {
    const u = await countDocumentUsage({ tenantId, programId: p.id }, id);
    if (u.member || u.controlLinks + u.attachments + u.expectations > 0) usage.programs++;
    usage.controlLinks += u.controlLinks;
    usage.attachments += u.attachments;
    usage.expectations += u.expectations;
  }
  return usage;
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    res.json({ documents: await listDocuments(req.tenantId!), limit: MAX_DOCUMENTS_PER_TENANT });
  } catch (err) {
    sendError(res, err, 'Failed to list the register');
  }
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const parsed = validateDocumentInput(req.body, false);
  if (!parsed.ok) return refuse(res, parsed.field, parsed.reason);
  try {
    res.status(201).json({ document: await createDocument(req.tenantId!, parsed.value, actorOf(req)) });
  } catch (err) {
    sendError(res, err, 'Failed to add the entry');
  }
});

router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!DOCUMENT_ID_PATTERN.test(idOf(req))) return notFound(res);
  const expected = expectedOf(req, res);
  if (expected === null) return;
  const parsed = validateDocumentInput(req.body, true);
  if (!parsed.ok) return refuse(res, parsed.field, parsed.reason);
  try {
    res.json(await updateDocument(req.tenantId!, idOf(req), parsed.value, expected, actorOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to update the entry');
  }
});

router.post('/:id/approve', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!DOCUMENT_ID_PATTERN.test(idOf(req))) return notFound(res);
  const expected = expectedOf(req, res);
  if (expected === null) return;
  const parsed = validateApproval(req.body, new Date().toISOString().slice(0, 10));
  if (!parsed.ok) return refuse(res, parsed.field);
  try {
    res.json({ document: await approveDocument(req.tenantId!, idOf(req), parsed.value, expected, actorOf(req)) });
  } catch (err) {
    sendError(res, err, 'Failed to approve the entry');
  }
});

router.post('/:id/status', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!DOCUMENT_ID_PATTERN.test(idOf(req))) return notFound(res);
  const expected = expectedOf(req, res);
  if (expected === null) return;
  const parsed = validateStatusInput(req.body);
  if (!parsed.ok) return refuse(res, parsed.field);
  try {
    res.json(await setDocumentStatus(req.tenantId!, idOf(req), parsed.value.status, expected, actorOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to change the status');
  }
});

router.get('/:id/usage', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!DOCUMENT_ID_PATTERN.test(idOf(req))) return notFound(res);
  try {
    if (!(await getDocument(req.tenantId!, idOf(req)))) return notFound(res);
    res.json(await documentUsage(req.tenantId!, idOf(req)));
  } catch (err) {
    sendError(res, err, 'Failed to read the usage');
  }
});

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  if (!DOCUMENT_ID_PATTERN.test(idOf(req))) return notFound(res);
  try {
    const id = idOf(req);
    if (!(await deleteDocument(req.tenantId!, id, actorOf(req)))) return notFound(res);
    console.log(`[Documents API] ${req.user?.uid} removed ${id} from ${req.tenantId}`);
    res.json({ removed: id });
  } catch (err) {
    sendError(res, err, 'Failed to delete the entry');
  }
});

export default router;
