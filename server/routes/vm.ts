import { Router, Request, Response } from 'express';
import { VmTokenError, createVmToken, listVmTokens, revokeVmTokenOutcome } from '../vm/tokens';
import { recordAccountEventBestEffort } from '../auth/accountEvents';
import { getRun, listRuns, listSources, resetRunForReprocess } from '../vm/store';
import { VmPoamEditError, attachRemediation, getVmPoamRow, listFindings, listVmPoamItemEvents, loadFindingsByIds, loadVmPoamView, updateVmPoamItem, withVmTenantTx } from '../vm/findingsStore';
import {
  VmDecisionError,
  getDefaultRemediationPolicy,
  listDecisionStates,
  listPolicyEvents,
  loadStoredPolicy,
  loadTierRules,
  nameDecisionAssets,
  requestDecision,
  resolveDecision,
  saveRemediationPolicy,
  summarizeRemediation,
  withRemediation,
} from '../vm/remediationStore';
import type { DecisionActor, DecisionListFilter, DecisionView, VmDecisionErrorCode } from '../vm/remediationStore';
import { VM_KEV_RULE_TEXT, VM_POLICY_LIMITS, validateDecisionRequest, validateRemediationPolicy } from '../../src/data/vmRemediation';
import { canRoleWrite, isOwnerLevel } from '../../src/utils/roles';
import type { TenantRole } from '../../src/types/tenant';
import type { VmDecision, VmPolicySaveResult, VmRemediationPolicyResponse, VmRemediationSummary } from '../../src/types/vmRemediation';
import { StaleWriteError } from '../controlAssessments';
import { parseVmPoamPatch } from '../../src/data/vmPoamEdit';
import { PoamMilestoneError } from '../../src/data/poamMilestones';
import { VM_POAM_CONTROL_ID, isPoamAutocreateEnabled } from '../vm/transitions';
import { getConfigScan, listConfigResults, listConfigScans, loadLatestConfigResults, summarizeConfigScansByAsset } from '../vm/configStore';
import { computeConfigSuggestions } from '../vm/configSuggestions';
import { aggregateObservedSoftware, getObservedHosts, listObservedHostsForAssets, listObservedSoftware } from '../vm/inventoryStore';
import { getAsset, listAssets } from '../assets';
import { getProgram, resolveVmTargetProgram } from '../programs';
import { getProgramBoundary } from '../programAssets';
import { frameworksDefiningControl } from '../middleware/frameworkGuard';
import { mapConfigRule } from '../../src/data/telemetry/configRuleMap';
import { enqueueVmRun, isVmRunActive, recoverStaleRuns } from '../vm/worker';
import {
  VmSnapshotError,
  lastManualSnapshotAt,
  listVmSnapshots,
  noteManualSnapshot,
  readLatestSnapshot,
  runVmSnapshot,
} from '../vm/snapshotWriter';
import { VM_MANUAL_SNAPSHOT_MIN_INTERVAL_MS, manualSnapshotAllowed } from '../vm/snapshot';
import { ensureActiveTenant, ensureTenantAdmin } from './tenantGuards';
import { errorMessage } from '../../src/utils/errors';
import { VM_CONFIG_RESULTS, VM_FINDING_STATUSES, VM_SEVERITIES, VM_TOKEN_SCOPES } from '../../src/types/vm';
import type { VmConfigResult, VmFindingStatus, VmPoamResponse, VmSeverity, VmTokenScope } from '../../src/types/vm';

/**
 * Tenant-scoped vulnerability management, mounted at /api/v1/tenants/:tenantId/vm by the tenants router, AFTER
 * requireWriteRole: creating and revoking service tokens is already limited to the write roles (TENANT_OWNER, TENANT_ADMIN, MSP_ADMIN).
 * The plaintext token is only ever returned by create, once.
 */
const router = Router({ mergeParams: true });

const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof VmTokenError && err.code === 'not_found') {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof VmTokenError && err.code === 'limit') {
    res.status(429).json({ error: err.message, code: 'limit' });
    return;
  }
  if (err instanceof VmSnapshotError) {
    if (err.code === 'in_progress') {
      res.status(409).json({ error: 'vm_snapshot_in_progress' });
      return;
    }
    if (err.code === 'no_sources') {
      res.status(409).json({ error: 'vm_no_sources' });
      return;
    }
    if (err.code === 'no_program') {
      res.status(409).json({ error: 'vm_no_program' });
      return;
    }
    if (err.code === 'requires_local_storage') {
      res.status(503).json({ error: 'vm_requires_local_storage' });
      return;
    }
    if (err.code === 'integrity') {
      res.status(409).json({ error: 'vm_snapshot_integrity_mismatch' });
      return;
    }
  }
  console.error('[VM API]', fallback, errorMessage(err));
  res.status(500).json({ error: fallback });
}

/**
 * POST /api/v1/tenants/:tenantId/vm/tokens
 * Body: { name, scopes?, expiresInDays? }. Returns { token, record }: the token is shown ONCE; the server keeps only its hash.
 * Refused over plain HTTP (the secret would cross the network in clear text) unless VM_ALLOW_INSECURE_TOKENS=true.
 */
router.post('/tokens', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const overridden = !req.secure && process.env.VM_ALLOW_INSECURE_TOKENS === 'true';
  if (!req.secure && !overridden) {
    res.status(403).json({ error: 'vm_insecure_transport' });
    return;
  }

  const { name, scopes, expiresInDays } = req.body ?? {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 255 || CONTROL_CHARS.test(trimmed)) {
    res.status(400).json({ error: 'Invalid name: 1 to 255 characters, no control characters' });
    return;
  }
  let tokenScopes: VmTokenScope[] = ['vm:ingest'];
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => (VM_TOKEN_SCOPES as readonly unknown[]).includes(s))) {
      res.status(400).json({ error: 'Invalid scopes: expected a non-empty list of ' + VM_TOKEN_SCOPES.join(', ') });
      return;
    }
    tokenScopes = [...new Set(scopes as VmTokenScope[])];
  }
  if (expiresInDays !== undefined && (typeof expiresInDays !== 'number' || !Number.isFinite(expiresInDays))) {
    res.status(400).json({ error: 'Invalid expiresInDays: expected a number' });
    return;
  }

  const user = req.user!;
  try {
    const { token, record } = await createVmToken(req.tenantId!, {
      name: trimmed,
      scopes: tokenScopes,
      expiresInDays,
      createdBy: user.name ? user.name + ' (' + (user.email ?? user.uid) + ')' : user.email ?? user.uid,
      createdByUserId: user.uid,
    });
    if (overridden) {
      console.warn('[VM API] service token ' + record.id + ' created over plain HTTP (VM_ALLOW_INSECURE_TOKENS=true) in ' + req.tenantId);
    }
    console.log('[VM API] ' + user.uid + ' created service token ' + record.id + ' in ' + req.tenantId);
    await recordAccountEventBestEffort({ actorKind: 'user', actorUserId: user.uid, targetUserId: user.uid, action: 'vm_token_created', scopeTenantId: req.tenantId!, details: { tokenId: record.id } });
    res.status(201).json({ token, record });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to create the service token');
  }
});

/** GET .../vm/tokens: every service token (active, revoked, expired). Never the token or its hash. */
router.get('/tokens', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res) || !ensureTenantAdmin(req, res)) return;
  try {
    const tokens = await listVmTokens(req.tenantId!);
    res.json({ tenantId: req.tenantId, totalCount: tokens.length, tokens });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the service tokens');
  }
});

/** POST .../vm/tokens/:id/revoke: idempotent. */
router.post('/tokens/:id/revoke', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const id = String(req.params.id);
  if (!TOKEN_ID_PATTERN.test(id)) {
    res.status(404).json({ error: 'Service token not found' });
    return;
  }
  try {
    const { token, changed } = await revokeVmTokenOutcome(req.tenantId!, id);
    console.log('[VM API] ' + req.user?.uid + ' revoked service token ' + token.id + ' in ' + req.tenantId);
    if (changed && req.user) {
      await recordAccountEventBestEffort({ actorKind: 'user', actorUserId: req.user.uid, targetUserId: req.user.uid, action: 'vm_token_revoked', scopeTenantId: req.tenantId!, details: { tokenId: token.id } });
    }
    res.json({ token });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to revoke the service token');
  }
});

/** GET .../vm/runs?limit=: received runs, newest first. The server-side storage path is not exposed. */
router.get('/runs', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const rawLimit = req.query.limit;
  let limit = 100;
  if (rawLimit !== undefined) {
    const n = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      res.status(400).json({ error: 'Invalid limit: between 1 and 500' });
      return;
    }
    limit = n;
  }
  try {
    const all = await listRuns(req.tenantId!, { limit });
    void recoverStaleRuns(req.tenantId!);
    const runs = all.map(({ rawPath: _rawPath, ...rest }) => rest);
    res.json({ tenantId: req.tenantId, totalCount: runs.length, runs });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the runs');
  }
});

/**
 * POST .../vm/runs/:id/reprocess (owner / admin, by requireWriteRole): puts the run back to RECEIVED and normalizes it again.
 * The worker re-verifies the stored payload against its recorded checksum first; sightings and the reducer are idempotent.
 */
router.post('/runs/:id/reprocess', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const id = String(req.params.id);
  if (!TOKEN_ID_PATTERN.test(id)) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  try {
    const run = await getRun(req.tenantId!, id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    if ((run.status === 'RECEIVED' || run.status === 'NORMALIZING') && isVmRunActive(id)) {
      res.status(409).json({ error: 'vm_run_in_progress' });
      return;
    }
    await resetRunForReprocess(req.tenantId!, id);
    enqueueVmRun(req.tenantId!, id);
    console.log('[VM API] ' + req.user?.uid + ' reprocessed run ' + id + ' in ' + req.tenantId);
    res.status(202).json({ run_id: id, status: 'RECEIVED' });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to reprocess the run');
  }
});

/** GET .../vm/findings?assetId=&severity=&status=&limit=: most severe first, then earliest deadline. */
router.get('/findings', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const { assetId, severity, status, limit: rawLimit } = req.query;
  if (assetId !== undefined && (typeof assetId !== 'string' || !TOKEN_ID_PATTERN.test(assetId))) {
    res.status(400).json({ error: 'Invalid assetId' });
    return;
  }
  if (severity !== undefined && !(typeof severity === 'string' && (VM_SEVERITIES as readonly string[]).includes(severity))) {
    res.status(400).json({ error: 'Invalid severity: ' + VM_SEVERITIES.join(', ') });
    return;
  }
  if (status !== undefined && !(typeof status === 'string' && (VM_FINDING_STATUSES as readonly string[]).includes(status))) {
    res.status(400).json({ error: 'Invalid status: ' + VM_FINDING_STATUSES.join(', ') });
    return;
  }
  let limit = 500;
  if (rawLimit !== undefined) {
    const n = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      res.status(400).json({ error: 'Invalid limit: between 1 and 1000' });
      return;
    }
    limit = n;
  }
  try {
    const findings = await listFindings(req.tenantId!, {
      assetId: assetId as string | undefined,
      severity: severity as VmSeverity | undefined,
      status: status as VmFindingStatus | undefined,
      limit,
    });
    res.json({ tenantId: req.tenantId, totalCount: findings.length, findings: await withRemediation(req.tenantId!, findings, new Date().toISOString()) });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the findings');
  }
});

/** A non-negative integer query parameter within [0, max]: the fallback when absent, null when it is not valid. */
function countParam(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/**
 * GET .../vm/poam?status=open|all&limit=&offset=&upcomingLimit=: the POA&M items of the request's program (x-program-id, else the default
 * program) with the finding and host each is about, plus the rule that creates them (#274, docs/VULNERABILITY_MANAGEMENT.md). For the VM target
 * program it also lists the open findings whose deadline has not passed yet and counts the overdue ones that have no item. Open to every
 * role, like /findings. Read only. Nothing about a finding is logged.
 */
router.get('/poam', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const { status } = req.query;
  if (status !== undefined && status !== 'open' && status !== 'all') {
    res.status(400).json({ error: 'Invalid status: open or all' });
    return;
  }
  const limit = limitParam(req.query.limit, 500, 1000);
  if (limit === null) {
    res.status(400).json({ error: 'Invalid limit: between 1 and 1000' });
    return;
  }
  const offset = countParam(req.query.offset, 0, 100000);
  if (offset === null) {
    res.status(400).json({ error: 'Invalid offset: between 0 and 100000' });
    return;
  }
  const upcomingLimit = countParam(req.query.upcomingLimit, 100, 1000);
  if (upcomingLimit === null) {
    res.status(400).json({ error: 'Invalid upcomingLimit: between 0 and 1000' });
    return;
  }
  try {
    const program = req.program ?? (req.programId ? await getProgram(tenantId, req.programId) : null);
    if (!program) {
      // no program header and no default: the tenant has no program yet
      if (!req.programId) {
        res.status(409).json({ error: 'This tenant has no program yet: create one first', code: 'program_required' });
        return;
      }
      res.status(404).json({ error: 'Program not found', code: 'program_not_found' });
      return;
    }
    const target = await resolveVmTargetProgram(tenantId);
    const isVmTarget = target?.program.id === program.id;
    const generatedAt = new Date().toISOString();
    const rules = await loadTierRules(tenantId, generatedAt);
    const view = await loadVmPoamView({ tenantId, programId: program.id }, generatedAt, {
      rules,
      openOnly: status !== 'all',
      limit,
      offset,
      upcomingLimit,
      includeFindingWindow: isVmTarget,
    });
    const response: VmPoamResponse = {
      tenantId,
      programId: program.id,
      generatedAt,
      rules: {
        controlId: VM_POAM_CONTROL_ID,
        autocreateEnabled: isPoamAutocreateEnabled(),
        vmTargetProgramId: target?.program.id ?? null,
        isVmTarget,
        slaDays: rules.policy.slaDays,
        policy: rules.policy,
      },
      ...view,
    };
    res.json(response);
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the POA&M items');
  }
});

/**
 * The program an item route works in (the x-program-id header or the tenant's default, resolved by optionalProgramContext, which already
 * refused an archived program for a write). Answers 409 program_required / 404 program_not_found itself and returns null then.
 */
async function poamProgramId(req: Request, res: Response): Promise<string | null> {
  const program = req.program ?? (req.programId ? await getProgram(req.tenantId!, req.programId) : null);
  if (program) return program.id;
  if (!req.programId) {
    res.status(409).json({ error: 'This tenant has no program yet: create one first', code: 'program_required' });
    return null;
  }
  res.status(404).json({ error: 'Program not found', code: 'program_not_found' });
  return null;
}

/** GET .../vm/poam/:itemId (every role): one item of the program as a row of GET /vm/poam, { item }. Any status. 404 like the PATCH. */
router.get('/poam/:itemId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const itemId = String(req.params.itemId);
  if (!TOKEN_ID_PATTERN.test(itemId)) {
    res.status(404).json({ error: 'POA&M item not found' });
    return;
  }
  try {
    const programId = await poamProgramId(req, res);
    if (!programId) return;
    const item = await getVmPoamRow({ tenantId, programId }, itemId);
    if (!item) {
      res.status(404).json({ error: 'POA&M item not found' });
      return;
    }
    const generatedAt = new Date().toISOString();
    await attachRemediation([item], await loadTierRules(tenantId, generatedAt), Date.parse(generatedAt), null);
    res.json({ item });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to read the POA&M item');
  }
});

/**
 * PATCH .../vm/poam/:itemId (owner / admin, by requireWriteRole). Body { expectedUpdatedAt, owner?, mitigation?, scheduledCompletion?, status?, milestones? }
 * (parseVmPoamPatch; milestones replaces the whole list, #304). 200 { item, changed } (a change that alters nothing: changed false, no event, the stamp stays). 400 invalid_poam_patch
 * with `field` (never the value; `milestones` also for an id the item does not hold), 400 mitigation_required, 404 for a malformed, unknown, other-tenant or other-program id (all look the same),
 * 409 program_required / program_archived / stale_write / finding_still_open. The log line and the events carry ids, statuses and dates only.
 */
router.patch('/poam/:itemId', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const itemId = String(req.params.itemId);
  if (!TOKEN_ID_PATTERN.test(itemId)) {
    res.status(404).json({ error: 'POA&M item not found' });
    return;
  }
  try {
    const programId = await poamProgramId(req, res);
    if (!programId) return;
    const parsed = parseVmPoamPatch(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: 'Invalid ' + parsed.field, code: 'invalid_poam_patch', field: parsed.field });
      return;
    }
    const user = req.user!;
    const result = await updateVmPoamItem({ tenantId, programId }, itemId, parsed.patch, parsed.expectedUpdatedAt, {
      actor: user.name || user.email || user.uid || 'Compliance Assessor',
      userId: user.uid ?? null,
    });
    if (!result) {
      res.status(404).json({ error: 'POA&M item not found' });
      return;
    }
    if (result.changed) console.log('[VM API] ' + user.uid + ' updated POA&M item ' + itemId + ' in ' + tenantId);
    const generatedAt = new Date().toISOString();
    await attachRemediation([result.item], await loadTierRules(tenantId, generatedAt), Date.parse(generatedAt), null);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof StaleWriteError) {
      res.status(409).json({ error: 'This POA&M item was saved by someone else after you loaded it.', code: 'stale_write', current: err.current });
      return;
    }
    if (err instanceof PoamMilestoneError) {
      res.status(400).json({ error: 'Invalid milestones', code: 'invalid_poam_patch', field: 'milestones' });
      return;
    }
    if (err instanceof VmPoamEditError) {
      if (err.code === 'finding_still_open') {
        res.status(409).json({ error: 'The scanner still reports this vulnerability: it cannot be completed yet. Use risk accepted instead.', code: 'finding_still_open' });
      } else {
        res.status(400).json({ error: 'Risk accepted needs a mitigation.', code: 'mitigation_required', field: 'mitigation' });
      }
      return;
    }
    sendError(res, err, 'Failed to update the POA&M item');
  }
});

/** GET .../vm/poam/:itemId/events: the item's history, newest first, at most 100 (every role). { events }. Never the owner or mitigation text. 404 like the PATCH. */
router.get('/poam/:itemId/events', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const itemId = String(req.params.itemId);
  if (!TOKEN_ID_PATTERN.test(itemId)) {
    res.status(404).json({ error: 'POA&M item not found' });
    return;
  }
  try {
    const programId = await poamProgramId(req, res);
    if (!programId) return;
    const scope = { tenantId, programId };
    if (!(await getVmPoamRow(scope, itemId))) {
      res.status(404).json({ error: 'POA&M item not found' });
      return;
    }
    res.json({ events: await listVmPoamItemEvents(scope, itemId, 100) });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the POA&M item history');
  }
});

/** GET .../vm/sources */
router.get('/sources', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const sources = await listSources(req.tenantId!);
    res.json({ tenantId: req.tenantId, totalCount: sources.length, sources });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the sources');
  }
});

/** A positive integer query parameter within [1, max]: undefined when absent, null when it is not valid. */
function limitParam(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/** An asset id from the path that exists in the tenant, else a 404 is sent and null returned. */
async function assetOr404(req: Request, res: Response): Promise<string | null> {
  const assetId = String(req.params.assetId);
  if (!TOKEN_ID_PATTERN.test(assetId) || !(await getAsset(req.tenantId!, assetId))) {
    res.status(404).json({ error: 'Asset not found' });
    return null;
  }
  return assetId;
}

/**
 * GET .../vm/assets/:assetId/inventory: what each source currently reports about the asset (hardware, addresses, operating system), most
 * recently seen first (docs/VULNERABILITY_MANAGEMENT.md, section 5.6). Open to every role, like /findings. Read only: the asset itself is untouched.
 */
router.get('/assets/:assetId/inventory', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const assetId = await assetOr404(req, res);
    if (assetId === null) return;
    res.json({ tenantId: req.tenantId, assetId, observed: await getObservedHosts(req.tenantId!, assetId) });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to read the host inventory');
  }
});

/** GET .../vm/assets/:assetId/software?sourceId=&limit=: the packages the sources report for the asset, by name then version (default 1000, up to 10000). */
router.get('/assets/:assetId/software', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const { sourceId } = req.query;
  if (sourceId !== undefined && (typeof sourceId !== 'string' || !TOKEN_ID_PATTERN.test(sourceId))) {
    res.status(400).json({ error: 'Invalid sourceId' });
    return;
  }
  const limit = limitParam(req.query.limit, 1000, 10000);
  if (limit === null) {
    res.status(400).json({ error: 'Invalid limit: between 1 and 10000' });
    return;
  }
  try {
    const assetId = await assetOr404(req, res);
    if (assetId === null) return;
    const { totalCount, items } = await listObservedSoftware(req.tenantId!, assetId, { sourceId: sourceId as string | undefined, limit });
    res.json({ tenantId: req.tenantId, assetId, totalCount, items });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the installed software');
  }
});

/**
 * The assets of the request's program for the program-wide inventory reads: its declared boundary, or every asset when it declares none
 * (assetIds null = no filter). Answers 409 program_required / 404 program_not_found itself and returns null, like /config/suggestions.
 */
async function programInventoryScope(req: Request, res: Response): Promise<{ programId: string; declared: boolean; assetIds: string[] | null } | null> {
  const tenantId = req.tenantId!;
  const program = req.program ?? (req.programId ? await getProgram(tenantId, req.programId) : null);
  if (!program) {
    if (!req.programId) {
      res.status(409).json({ error: 'This tenant has no program yet: create one first', code: 'program_required' });
      return null;
    }
    res.status(404).json({ error: 'Program not found', code: 'program_not_found' });
    return null;
  }
  const boundary = await getProgramBoundary(tenantId, program.id);
  return { programId: program.id, declared: boundary.declared, assetIds: boundary.declared ? boundary.assetIds : null };
}

/**
 * GET .../vm/inventory/hosts: what the sources report about every asset of the request's program (x-program-id, else the default program):
 * one row per asset and source, by asset then most recently seen first. Open to every role, like the per-asset read. Read only.
 */
router.get('/inventory/hosts', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const scope = await programInventoryScope(req, res);
    if (!scope) return;
    const hosts = await listObservedHostsForAssets(req.tenantId!, scope.assetIds);
    res.json({ tenantId: req.tenantId, programId: scope.programId, declared: scope.declared, hosts });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to read the program host inventory');
  }
});

/**
 * GET .../vm/inventory/software?limit=: the distinct packages the sources report across the request's program, grouped by name, version and
 * vendor (hotfixes left out), with how many assets report each (default limit 10000 groups, up to 20000). Open to every role. Read only.
 */
router.get('/inventory/software', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const limit = limitParam(req.query.limit, 10000, 20000);
  if (limit === null) {
    res.status(400).json({ error: 'Invalid limit: between 1 and 20000' });
    return;
  }
  try {
    const scope = await programInventoryScope(req, res);
    if (!scope) return;
    const { totalGroups, items } = await aggregateObservedSoftware(req.tenantId!, scope.assetIds, { limit });
    res.json({ tenantId: req.tenantId, programId: scope.programId, declared: scope.declared, totalGroups, truncated: totalGroups > items.length, items });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to read the program software inventory');
  }
});

/**
 * GET .../vm/config/scans?assetId=&latest=&limit=: configuration scans, newest first (issue #103). Open to every role, like /findings.
 * latest=true keeps only the newest scan per asset, source, benchmark and profile. The stored raw payload is never served.
 */
router.get('/config/scans', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const { assetId, latest } = req.query;
  if (assetId !== undefined && (typeof assetId !== 'string' || !TOKEN_ID_PATTERN.test(assetId))) {
    res.status(400).json({ error: 'Invalid assetId' });
    return;
  }
  if (latest !== undefined && latest !== 'true' && latest !== 'false') {
    res.status(400).json({ error: 'Invalid latest: true or false' });
    return;
  }
  const limit = limitParam(req.query.limit, 100, 500);
  if (limit === null) {
    res.status(400).json({ error: 'Invalid limit: between 1 and 500' });
    return;
  }
  try {
    const { totalCount, scans } = await listConfigScans(req.tenantId!, { assetId: assetId as string | undefined, latestOnly: latest === 'true', limit });
    res.json({ tenantId: req.tenantId, totalCount, scans });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the configuration scans');
  }
});

/**
 * GET .../vm/config/asset-summaries?assetId=: one row per asset with the result counts of its newest scans and a score (issue #215).
 * Open to every role and tenant-wide, like /config/scans. Ids and counts only: never a host name or address.
 */
router.get('/config/asset-summaries', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const { assetId } = req.query;
  if (assetId !== undefined && (typeof assetId !== 'string' || !TOKEN_ID_PATTERN.test(assetId))) {
    res.status(400).json({ error: 'Invalid assetId' });
    return;
  }
  try {
    const summaries = await summarizeConfigScansByAsset(req.tenantId!, { assetId: assetId as string | undefined });
    res.json({ tenantId: req.tenantId, totalCount: summaries.length, summaries });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to summarise the configuration scans');
  }
});

/** GET .../vm/config/scans/:id/results?result=&limit=: the rule results of one scan, by rule id, with the controls each rule maps to. */
router.get('/config/scans/:id/results', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const id = String(req.params.id);
  if (!TOKEN_ID_PATTERN.test(id)) {
    res.status(404).json({ error: 'Configuration scan not found' });
    return;
  }
  const { result } = req.query;
  if (result !== undefined && !(typeof result === 'string' && (VM_CONFIG_RESULTS as readonly string[]).includes(result))) {
    res.status(400).json({ error: 'Invalid result: ' + VM_CONFIG_RESULTS.join(', ') });
    return;
  }
  const limit = limitParam(req.query.limit, 5000, 5000);
  if (limit === null) {
    res.status(400).json({ error: 'Invalid limit: between 1 and 5000' });
    return;
  }
  try {
    const scan = await getConfigScan(req.tenantId!, id);
    if (!scan) {
      res.status(404).json({ error: 'Configuration scan not found' });
      return;
    }
    const { totalCount, results } = await listConfigResults(req.tenantId!, id, { result: result as VmConfigResult | undefined, limit });
    res.json({
      tenantId: req.tenantId,
      scanId: id,
      totalCount,
      results: results.map(({ scanId: _scanId, ...rest }) => {
        const mapped = mapConfigRule({ ruleId: rest.ruleId, cce: rest.cce });
        return { ...rest, controls: mapped ? { cmmc: mapped.controlId, nist80053: mapped.nist80053 } : null };
      }),
    });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the configuration results');
  }
});

/**
 * GET .../vm/config/suggestions: what the latest configuration scans suggest for the controls of the request's program (x-program-id, else
 * the default program), over that program's boundary. Computed on every read and never stored: nothing here writes a control. Accepting a
 * suggestion is an ordinary control update by a person. SOC 2 and HIPAA programs get supported: false and no controls.
 */
router.get('/config/suggestions', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  try {
    const program = req.program ?? (req.programId ? await getProgram(tenantId, req.programId) : null);
    if (!program) {
      // no program header and no default: the tenant has no program yet
      if (!req.programId) {
        res.status(409).json({ error: 'This tenant has no program yet: create one first', code: 'program_required' });
        return;
      }
      res.status(404).json({ error: 'Program not found', code: 'program_not_found' });
      return;
    }
    const boundary = await getProgramBoundary(tenantId, program.id);
    const inventory = await listAssets(tenantId);
    const members = new Set(boundary.assetIds);
    const assets = (boundary.declared ? inventory.filter((a) => members.has(a.id)) : inventory).map((a) => ({
      id: a.id,
      discoveryStatus: a.discoveryStatus ?? 'ACTIVE',
      cmmcCategory: a.cmmcAssetCategory,
    }));
    const { scans, results } = await loadLatestConfigResults(tenantId, assets.map((a) => a.id));
    const computed = computeConfigSuggestions({
      scans,
      results,
      boundary: { declared: boundary.declared, assets },
      framework: program.frameworkId,
    });
    res.json({
      tenantId,
      programId: program.id,
      frameworkId: program.frameworkId,
      supported: computed.supported,
      boundary: { declared: boundary.declared, inScope: computed.inScope, evaluated: computed.evaluated },
      generatedAt: new Date().toISOString(),
      controls: computed.controls.filter((c) => frameworksDefiningControl(c.controlId).has(program.frameworkId)),
      unmappedRuleCount: computed.unmappedRuleCount,
    });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to compute the configuration suggestions');
  }
});

/**
 * POST .../vm/snapshot (owner / admin, by requireWriteRole): evaluates the three assessor criteria now and writes the
 * evidence and control notes. At most one a minute per tenant (counted only after a success); the scheduler is exempt.
 */
router.post('/snapshot', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const nowMs = Date.now();
  const last = lastManualSnapshotAt(tenantId);
  if (!manualSnapshotAllowed(last, nowMs)) {
    const retryAfterSeconds = Math.max(1, Math.ceil((VM_MANUAL_SNAPSHOT_MIN_INTERVAL_MS - (nowMs - (last as number))) / 1000));
    res.status(429).json({ error: 'vm_snapshot_too_soon', retryAfterSeconds });
    return;
  }
  try {
    // The snapshot belongs to the tenant's VM target program (the default when none is set), whatever x-program-id says.
    const { snapshot } = await runVmSnapshot(tenantId, {
      trigger: 'manual',
      triggeredBy: { actor: req.user?.name || req.user?.email || 'Compliance Assessor', userId: req.user?.uid ?? null },
    });
    noteManualSnapshot(tenantId, Date.now());
    console.log('[VM API] ' + req.user?.uid + ' created snapshot ' + snapshot.id + ' in ' + tenantId);
    res.status(201).json({ snapshot });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to create the snapshot');
  }
});

/** GET .../vm/snapshots: the tenant's snapshots, newest first (at most 100). Open to every role, like /findings. */
router.get('/snapshots', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const snapshots = await listVmSnapshots(req.tenantId!);
    res.json({ tenantId: req.tenantId, totalCount: snapshots.length, snapshots });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to list the snapshots');
  }
});

/** GET .../vm/snapshot/latest: the newest snapshot with its report, after checking the stored file against its recorded sha256. */
router.get('/snapshot/latest', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const latest = await readLatestSnapshot(req.tenantId!);
    if (!latest) {
      res.status(404).json({ error: 'vm_snapshot_not_found' });
      return;
    }
    res.json({ snapshot: latest.snapshot, report: latest.report });
  } catch (err: unknown) {
    sendError(res, err, 'Failed to read the snapshot');
  }
});

// ------------------------------------------------------------------------------------------------ remediation policy and risk decisions (#268)

/** Every error of the remediation routes: { error, reason: '<code>' } (plus the field named by a validation error, never a value). */
function refuse(res: Response, status: number, reason: string, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error, reason, ...extra });
}

function failRemediation(res: Response, err: unknown, fallback: string): void {
  console.error('[VM API]', fallback, errorMessage(err));
  refuse(res, 500, 'server_error', fallback);
}

/** Owner level (Tenant Owner, MSP Admin): sends 403 owner_required and returns false otherwise. */
function ownerOnly(req: Request, res: Response): boolean {
  if (isOwnerLevel(req.tenantRole)) return true;
  refuse(res, 403, 'owner_required', 'Forbidden: this needs owner-level access (Tenant Owner, MSP Admin)', { role: req.tenantRole ?? null });
  return false;
}

/** GET .../vm/remediation-policy (every role): the policy in force, where it comes from, the environment defaults and the fixed known-exploited rule. */
router.get('/remediation-policy', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const stored = await loadStoredPolicy(req.tenantId!);
    const body: VmRemediationPolicyResponse = {
      policy: stored.policy,
      source: stored.source,
      defaults: getDefaultRemediationPolicy(),
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
      kevRule: VM_KEV_RULE_TEXT,
      limits: { ...VM_POLICY_LIMITS },
    };
    res.json(body);
  } catch (err: unknown) {
    failRemediation(res, err, 'Failed to read the remediation policy');
  }
});

/**
 * PUT .../vm/remediation-policy (owner level, on top of requireWriteRole). Body { expectedUpdatedAt: string | null, slaDays, warnOnly, graceDays }.
 * 200 { policy, updatedAt, changed, impact: { openRecomputed, gap, warning } }: a change recomputes the due dates of the open findings in the same
 * transaction and records one event; a save that changes nothing is changed:false with no event. 400 invalid_policy (with `field` and `rule`, never the value),
 * 403 owner_required, 409 stale_write (with `current`). The log line carries ids only.
 */
router.put('/remediation-policy', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res) || !ownerOnly(req, res)) return;
  const tenantId = req.tenantId!;
  const body: unknown = req.body;
  const { expectedUpdatedAt, ...rest } = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (expectedUpdatedAt === undefined || (expectedUpdatedAt !== null && (typeof expectedUpdatedAt !== 'string' || Number.isNaN(Date.parse(expectedUpdatedAt))))) {
    refuse(res, 400, 'invalid_policy', 'Invalid expectedUpdatedAt', { field: 'expectedUpdatedAt', rule: 'type' });
    return;
  }
  const parsed = validateRemediationPolicy(rest);
  if (!parsed.ok) {
    refuse(res, 400, 'invalid_policy', 'Invalid ' + parsed.field, { field: parsed.field, rule: parsed.rule });
    return;
  }
  const user = req.user!;
  try {
    const result = await saveRemediationPolicy(
      tenantId,
      parsed.policy,
      expectedUpdatedAt as string | null,
      { actor: user.name || user.email || user.uid || 'Compliance Assessor', userId: user.uid ?? null, role: req.tenantRole ?? null },
      new Date().toISOString(),
    );
    if (result.changed) console.log('[VM API] ' + user.uid + ' saved the remediation policy in ' + tenantId);
    const out: VmPolicySaveResult = { policy: result.policy, updatedAt: result.updatedAt, changed: result.changed, impact: result.impact };
    res.json(out);
  } catch (err: unknown) {
    if (err instanceof StaleWriteError) {
      refuse(res, 409, 'stale_write', 'The remediation policy was saved by someone else after you loaded it.', { current: err.current });
      return;
    }
    failRemediation(res, err, 'Failed to save the remediation policy');
  }
});

/** GET .../vm/remediation-policy/events?limit=: the policy's history, newest first (default 50, at most 100). Every role. { events }. */
router.get('/remediation-policy/events', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const limit = limitParam(req.query.limit, 50, 100);
  if (limit === null) {
    refuse(res, 400, 'invalid_limit', 'Invalid limit: between 1 and 100');
    return;
  }
  try {
    res.json({ events: await listPolicyEvents(req.tenantId!, limit) });
  } catch (err: unknown) {
    failRemediation(res, err, 'Failed to list the remediation policy history');
  }
});

/**
 * GET .../vm/remediation/summary (every role): how many of the tenant's findings are on track, warnings, gaps or accepted under its policy, the breakdown of
 * the gaps and warnings, the decisions waiting for approval and the ones expiring within 30 days. Counts and ids only.
 */
router.get('/remediation/summary', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  try {
    const generatedAt = new Date().toISOString();
    const s = await summarizeRemediation(req.tenantId!, generatedAt);
    const warningBySeverity: VmRemediationSummary['warningBySeverity'] = {};
    // UNKNOWN is held to the Medium deadline, so it is reported with Medium
    const bySev: Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', number> = {
      CRITICAL: s.tally.warningBySeverity.CRITICAL,
      HIGH: s.tally.warningBySeverity.HIGH,
      MEDIUM: s.tally.warningBySeverity.MEDIUM + s.tally.warningBySeverity.UNKNOWN,
      LOW: s.tally.warningBySeverity.LOW,
    };
    for (const k of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) if (bySev[k] > 0) warningBySeverity[k] = bySev[k];
    const body: VmRemediationSummary = {
      generatedAt,
      policy: s.policy,
      counts: { onTrack: s.tally.onTrack, warning: s.tally.warning, gap: s.tally.gap, accepted: s.tally.accepted },
      warningBySeverity,
      gapCritical: s.tally.gapCritical,
      gapHigh: s.tally.gapHigh,
      gapKev: s.tally.gapKev,
      pendingDecisions: s.pendingDecisions,
      expiringSoon: s.expiringSoon.map(({ view }) => ({
        decisionId: view.decision.id,
        findingId: view.decision.findingId,
        vulnId: view.decision.vulnId,
        assetId: view.decision.assetId,
        assetName: view.assetName,
        kind: view.decision.kind,
        expiresAt: view.decision.expiresAt,
      })),
    };
    res.json(body);
  } catch (err: unknown) {
    failRemediation(res, err, 'Failed to summarise the remediation status');
  }
});

/** Who reads a justification: the write roles and the Assessor. A Viewer gets null and its length. */
const readsJustification = (role: TenantRole | null | undefined): boolean => role === 'ASSESSOR' || canRoleWrite(role);

function decisionJson(view: DecisionView, req: Request): VmDecision {
  const d = view.decision;
  return {
    id: d.id,
    kind: d.kind,
    state: view.state,
    justification: readsJustification(req.tenantRole) ? d.justification : null,
    justificationLength: [...d.justification].length,
    justificationSha256: d.justificationSha256,
    requestedBy: d.requestedBy,
    requestedAt: d.requestedAt,
    requestedByMe: Boolean(req.user?.uid) && d.requestedByUserId === req.user?.uid,
    expiresAt: d.expiresAt,
    approvedBy: view.approvedBy,
    approvedAt: view.approvedAt,
    events: view.events.map((e) => ({ action: e.action, actor: e.actor, actorRole: e.actorRole, createdAt: e.createdAt })),
    findingId: d.findingId,
    vulnId: d.vulnId,
    assetId: d.assetId,
    assetName: view.assetName,
  };
}

const decisionActor = (req: Request): DecisionActor => ({
  name: req.user?.name || req.user?.email || req.user?.uid || 'Compliance Assessor',
  userId: req.user!.uid,
  role: req.tenantRole ?? null,
});

const DECISION_ERRORS: Record<VmDecisionErrorCode, [number, string]> = {
  not_found: [404, 'Not found'],
  finding_not_open: [409, 'The finding is not open, so no decision can be requested'],
  decision_pending: [409, 'A request for this finding is already waiting for approval'],
  decision_not_pending: [409, 'The request was already approved, rejected or withdrawn'],
  decision_expired: [409, 'The request reached its expiry date before it was resolved'],
  decision_not_active: [409, 'The decision is not in force'],
  self_approval_forbidden: [403, 'Forbidden: the person who requested a decision cannot approve it'],
  owner_required: [403, 'Forbidden: this needs owner-level access (Tenant Owner, MSP Admin)'],
  not_requester: [403, 'Forbidden: only the person who requested it can withdraw a request'],
};

/** Sends a decision refusal ({ error, reason }) and returns true; false for any other error. */
function sendDecisionError(res: Response, err: unknown): boolean {
  if (!(err instanceof VmDecisionError)) return false;
  const [status, message] = DECISION_ERRORS[err.code];
  refuse(res, status, err.code, message);
  return true;
}

/**
 * POST .../vm/findings/:findingId/decisions (write roles, by requireWriteRole). Body { kind: RISK_ACCEPTED | FALSE_POSITIVE, justification, expiresAt: 'YYYY-MM-DD' }.
 * 201 { decision } in state PENDING: nothing about the finding changes until another owner-level member approves it. 400 invalid_decision (field, code:
 * required, too_long, range, kind), 404 not_found (unknown, malformed or other-tenant id), 409 decision_pending, 409 finding_not_open.
 * The justification is stored in the decision row only: never logged, never in an event.
 */
router.post('/findings/:findingId/decisions', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const findingId = String(req.params.findingId);
  if (!TOKEN_ID_PATTERN.test(findingId)) {
    refuse(res, 404, 'not_found', 'Finding not found');
    return;
  }
  const nowMs = Date.now();
  const parsed = validateDecisionRequest(req.body, nowMs);
  if (!parsed.ok) {
    refuse(res, 400, 'invalid_decision', 'Invalid ' + parsed.field, { field: parsed.field, code: parsed.code });
    return;
  }
  try {
    const view = await requestDecision(tenantId, findingId, parsed.value, decisionActor(req), new Date(nowMs).toISOString());
    await nameDecisionAssets(tenantId, [view]);
    console.log('[VM API] ' + req.user?.uid + ' requested decision ' + view.decision.id + ' in ' + tenantId);
    res.status(201).json({ decision: decisionJson(view, req) });
  } catch (err: unknown) {
    if (!sendDecisionError(res, err)) failRemediation(res, err, 'Failed to request the decision');
  }
});

/**
 * GET .../vm/findings/:findingId/decisions (every role): the finding's decisions, newest first, each with its state and events. The justification text
 * goes to the write roles and the Assessor; a Viewer gets null and `justificationLength`. 404 not_found for an unknown finding.
 */
router.get('/findings/:findingId/decisions', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const tenantId = req.tenantId!;
  const findingId = String(req.params.findingId);
  if (!TOKEN_ID_PATTERN.test(findingId)) {
    refuse(res, 404, 'not_found', 'Finding not found');
    return;
  }
  try {
    const known = await withVmTenantTx(tenantId, (c) => loadFindingsByIds(tenantId, [findingId], c));
    if (known.length === 0) {
      refuse(res, 404, 'not_found', 'Finding not found');
      return;
    }
    const views = await listDecisionStates(tenantId, new Date().toISOString(), { findingId });
    res.json({ decisions: views.map((v) => decisionJson(v, req)) });
  } catch (err: unknown) {
    failRemediation(res, err, 'Failed to list the decisions');
  }
});

/** GET .../vm/decisions?state=pending|active|expiring|all (every role; default all): the tenant's decisions, newest request first, at most 500. */
router.get('/decisions', async (req: Request, res: Response): Promise<void> => {
  if (!ensureActiveTenant(req, res)) return;
  const state = req.query.state === undefined ? 'all' : req.query.state;
  if (typeof state !== 'string' || !['pending', 'active', 'expiring', 'all'].includes(state)) {
    refuse(res, 400, 'invalid_state', 'Invalid state: pending, active, expiring or all');
    return;
  }
  try {
    const views = await listDecisionStates(req.tenantId!, new Date().toISOString(), { state: state as DecisionListFilter, limit: 500 });
    res.json({ decisions: views.map((v) => decisionJson(v, req)) });
  } catch (err: unknown) {
    failRemediation(res, err, 'Failed to list the decisions');
  }
});

/**
 * POST .../vm/decisions/:id/approve | reject | withdraw | revoke (write roles by requireWriteRole, then): approve needs owner-level access and a person
 * other than the requester (403 self_approval_forbidden; there is no exception for a single owner); reject and revoke need owner-level access (403
 * owner_required); withdraw is the requester's alone (403 not_requester). 200 { decision }. 404 not_found; 409 decision_not_pending, decision_expired
 * (a request past its expiry) or decision_not_active (revoke needs a decision in force). Approving never changes a POA&M item or a control.
 */
for (const action of ['approve', 'reject', 'withdraw', 'revoke'] as const) {
  const done = { approve: 'approved', reject: 'rejected', withdraw: 'withdrew', revoke: 'revoked' }[action];
  router.post('/decisions/:id/' + action, async (req: Request, res: Response): Promise<void> => {
    if (!ensureActiveTenant(req, res)) return;
    const tenantId = req.tenantId!;
    const id = String(req.params.id);
    if (!TOKEN_ID_PATTERN.test(id)) {
      refuse(res, 404, 'not_found', 'Decision not found');
      return;
    }
    try {
      const view = await resolveDecision(tenantId, id, action, decisionActor(req), new Date().toISOString());
      await nameDecisionAssets(tenantId, [view]);
      console.log('[VM API] ' + req.user?.uid + ' ' + done + ' decision ' + id + ' in ' + tenantId);
      res.json({ decision: decisionJson(view, req) });
    } catch (err: unknown) {
      if (!sendDecisionError(res, err)) failRemediation(res, err, 'Failed to ' + action + ' the decision');
    }
  });
}

export default router;
