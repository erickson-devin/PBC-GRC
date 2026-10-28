import { Router, Request, Response } from 'express';
import type pg from 'pg';
import { getTenantProgram, queryWithProgram, type ProgramScope } from '../db';
import { CONTROL_STATUSES, listControlAssessmentEvents, writeControlAssessment } from '../controlAssessments';
import { ensureControlInProgram, ensureFrameworkEnabled } from '../middleware/frameworkGuard';
import { requireWriteRole } from '../middleware/roleGuard';
import {
  ComplianceFramework,
  BaselineTier,
  OverlayParameter,
} from '../../src/types/framework';
import {
  getFrameworkControls,
  FRAMEWORK_REGISTRY,
  CANONICAL_CONTROL_MAPPINGS,
  getCrossFrameworkMappings,
} from '../../src/data/frameworks';
import { errorMessage } from '../../src/utils/errors';

const router = Router();

// Read-only roles (ASSESSOR, VIEWER) may GET but never POST / PUT / DELETE.
router.use(requireWriteRole);

/** The tenant and program of the request (set by authMiddleware and the programContext middleware that is mounted before this router). */
const scopeOf = (req: Request): ProgramScope => ({ tenantId: req.tenantId!, programId: req.programId! });

/**
 * Format DB row into client-compatible ControlState
 */
function mapRowToControl(row: pg.QueryResultRow) {
  return {
    id: row.control_id,
    tenantId: row.tenant_id,
    status: row.status || 'NOT_STARTED',
    implementationNotes: row.implementation_notes || '',
    responsibleRole: row.responsible_role || 'IT / Security Lead',
    tags: Array.isArray(row.tags) ? row.tags : [],
    updatedBy: row.updated_by || '',
    lastUpdated: row.updated_at || new Date().toISOString(),
  };
}

/**
 * Normalize framework, baseline, and overlay parameters from query
 */
function normalizeFrameworkParams(query: Request['query']): {
  framework: ComplianceFramework;
  baseline: BaselineTier;
  overlay: OverlayParameter;
} {
  const rawFramework = (query.framework_id || query.framework || 'CMMC_L1').toString().toUpperCase();
  const rawBaseline = (query.baseline || '').toString().toUpperCase();
  const rawOverlay = (query.overlay || '').toString().toUpperCase();

  let framework: ComplianceFramework = 'CMMC_L1';
  let baseline: BaselineTier = 'LOW_LOW_LOW';
  let overlay: OverlayParameter = 'NONE';

  // Framework normalization & aliases
  if (rawFramework === 'CMMC_L2') {
    framework = 'CMMC_L2';
  } else if (rawFramework === 'NIST_800_53_REV5' || rawFramework === 'NIST_800_53' || rawFramework === 'NIST_SP_800_53') {
    framework = 'NIST_800_53_REV5';
    baseline = rawBaseline === 'LOW_LOW_LOW' || rawBaseline === 'LOW_LOW_MOD' ? (rawBaseline as BaselineTier) : 'MOD_MOD_MOD';
  } else if (rawFramework === 'NIST_800_53_MOD') {
    framework = 'NIST_800_53_REV5';
    baseline = 'MOD_MOD_MOD';
  } else if (rawFramework === 'NIST_800_53_LOW') {
    framework = 'NIST_800_53_REV5';
    baseline = 'LOW_LOW_LOW';
  } else if (rawFramework === 'SOC_2_TYPE_II' || rawFramework === 'SOC2' || rawFramework === 'SOC_2') {
    framework = 'SOC_2_TYPE_II';
  } else if (rawFramework === 'HIPAA_SECURITY' || rawFramework === 'HIPAA') {
    framework = 'HIPAA_SECURITY';
  } else {
    framework = 'CMMC_L1';
  }

  // Baseline normalization
  if (rawBaseline === 'MOD_MOD_MOD') baseline = 'MOD_MOD_MOD';
  else if (rawBaseline === 'LOW_LOW_MOD') baseline = 'LOW_LOW_MOD';
  else if (rawBaseline === 'LOW_LOW_LOW') baseline = 'LOW_LOW_LOW';

  // Overlay normalization (tactical / non-networked systems)
  if (rawOverlay === 'NON_NETWORKED' || rawOverlay === 'TACTICAL_NON_NETWORKED' || rawOverlay === 'TACTICAL') {
    overlay = 'NON_NETWORKED';
  }

  return { framework, baseline, overlay };
}

/**
 * GET /api/v1/controls/frameworks
 * Returns metadata, supported baselines, and statistics for all available compliance frameworks
 */
router.get('/frameworks', (_req: Request, res: Response): void => {
  res.json({
    // The registry also holds aliases (e.g. 'nist-800-53-r5'); list each framework once, by canonical id.
    frameworks: Object.entries(FRAMEWORK_REGISTRY)
      .filter(([key, f]) => key === f.id)
      .map(([, f]) => ({
      id: f.id,
      name: f.name,
      shortName: f.shortName,
      version: f.version,
      authority: f.authority,
      description: f.description,
      totalControls: f.totalControls,
      defaultBaseline: f.defaultBaseline,
      supportedBaselines: f.supportedBaselines || [],
      supportsNonNetworkedOverlay: f.supportsNonNetworkedOverlay,
      domainCount: Object.keys(f.domains).length,
    })),
  });
});

/**
 * GET /api/v1/controls/mappings
 * Returns cross-framework control mappings, optionally filtered by control_id or framework_id
 */
router.get('/mappings', (req: Request, res: Response): void => {
  const { control_id, framework_id } = req.query;

  if (control_id) {
    const mappings = getCrossFrameworkMappings(control_id.toString());
    res.json({
      controlId: control_id,
      totalCount: mappings.length,
      mappings,
    });
    return;
  }

  if (framework_id) {
    const fId = framework_id.toString().toUpperCase();
    const mappings = CANONICAL_CONTROL_MAPPINGS.filter(
      m => m.sourceFramework === fId || m.targetFramework === fId
    );
    res.json({
      frameworkId: framework_id,
      totalCount: mappings.length,
      mappings,
    });
    return;
  }

  res.json({
    totalCount: CANONICAL_CONTROL_MAPPINGS.length,
    mappings: CANONICAL_CONTROL_MAPPINGS,
  });
});

/**
 * GET /api/v1/controls
 * Dynamically queries controls for the specified framework, baseline, and overlay parameters.
 * Default: CMMC Level 1 (17 controls).
 * Supports:
 *   ?framework=CMMC_L2
 *   ?framework=NIST_800_53_MOD&overlay=NON_NETWORKED
 *   ?framework=SOC_2_TYPE_II
 *   ?framework=HIPAA_SECURITY
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const scope = scopeOf(req);

  try {
    // Framework segregation: a tenant serves the frameworks of its assessment program (the allow-list); a framework asked for
    // explicitly stays allowed under it (the crosswalk view). With none asked for, the active program's own framework.
    const program = await getTenantProgram(tenantId);
    const asked = req.query.framework_id || req.query.framework;
    const query = !asked && req.program ? { ...req.query, framework_id: req.program.frameworkId } : req.query;
    const { framework, baseline, overlay } = normalizeFrameworkParams(query);
    if (!(await ensureFrameworkEnabled(req, res, framework, program))) return;

    // 1. Resolve canonical controls for the requested framework and overlay
    const frameworkControls = getFrameworkControls(framework, baseline, overlay);
    const targetControlIds = frameworkControls.map(c => c.id);

    // 2. Query the active program's assessment records from PostgreSQL (guarded by RLS; a legacy row with no program counts as its own until backfilled)
    const result = await queryWithProgram(
      scope,
      'SELECT * FROM control_assessments WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL) ORDER BY control_id ASC',
      [tenantId, scope.programId]
    );

    const existingMap = new Map<string, pg.QueryResultRow>();
    for (const row of result.rows) {
      existingMap.set(row.control_id, row);
    }

    const controlsList: ReturnType<typeof mapRowToControl>[] = [];
    const missingControls: string[] = [];

    for (const ctrl of frameworkControls) {
      if (existingMap.has(ctrl.id)) {
        controlsList.push(mapRowToControl(existingMap.get(ctrl.id)!));
      } else {
        missingControls.push(ctrl.id);
      }
    }

    // 3. For CMMC L1 (or default), seed missing controls into database under tenant RLS boundary
    if (framework === 'CMMC_L1' && missingControls.length > 0) {
      for (const ctrlId of missingControls) {
        try {
          const insertRes = await queryWithProgram(
            scope,
            `INSERT INTO control_assessments (tenant_id, control_id, status, implementation_notes, responsible_role, updated_by, program_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (tenant_id, program_id, control_id) DO NOTHING
             RETURNING *`,
            [tenantId, ctrlId, 'NOT_STARTED', '', 'IT / Security Lead', req.user?.name || 'System Initializer', scope.programId]
          );

          if (insertRes.rows.length > 0) {
            controlsList.push(mapRowToControl(insertRes.rows[0]));
          } else {
            controlsList.push({
              id: ctrlId,
              tenantId,
              status: 'NOT_STARTED',
              implementationNotes: '',
              responsibleRole: 'IT / Security Lead',
              tags: [],
              updatedBy: 'System Initializer',
              lastUpdated: new Date().toISOString(),
            });
          }
        } catch {
          controlsList.push({
            id: ctrlId,
            tenantId,
            status: 'NOT_STARTED',
            implementationNotes: '',
            responsibleRole: 'IT / Security Lead',
            tags: [],
            updatedBy: 'System Initializer',
            lastUpdated: new Date().toISOString(),
          });
        }
      }
    } else {
      // For other frameworks, synthesize NOT_STARTED records for controls not yet recorded
      for (const ctrlId of missingControls) {
        controlsList.push({
          id: ctrlId,
          tenantId,
          status: 'NOT_STARTED',
          implementationNotes: '',
          responsibleRole: 'IT / Security Lead',
          tags: [],
          updatedBy: 'System Initializer',
          lastUpdated: new Date().toISOString(),
        });
      }
    }

    // Consistent sort order matching framework definitions
    const idOrderMap = new Map<string, number>();
    targetControlIds.forEach((id, idx) => idOrderMap.set(id, idx));
    controlsList.sort((a, b) => (idOrderMap.get(a.id) ?? 0) - (idOrderMap.get(b.id) ?? 0));

    res.json({
      tenantId,
      framework,
      baseline,
      overlay,
      totalCount: controlsList.length,
      controls: controlsList,
    });
  } catch (err: unknown) {
    console.error(`[Controls API] Error fetching controls for tenant ${tenantId}:`, err);
    res.status(500).json({
      error: 'Failed to fetch control assessments',
      details: errorMessage(err),
    });
  }
});

/**
 * PUT /api/v1/controls/:controlId
 * Updates implementation notes, status (MET / NOT_MET / IN_PROGRESS / NOT_STARTED), and timestamp.
 * A field left out (or null) keeps its stored value; an empty status or role also keeps it; an empty string for the notes clears them.
 * The change is recorded in the control's history under the signed-in user, never under the name in the body.
 */
router.put('/:controlId', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const { controlId } = req.params;
  const { status, implementationNotes, responsibleRole, updatedBy } = req.body ?? {};

  // Validate status if provided
  if (status !== undefined && status !== null && status !== '' && !(CONTROL_STATUSES as readonly unknown[]).includes(status)) {
    res.status(400).json({
      error: `Invalid status: ${status}. Must be one of: ${CONTROL_STATUSES.join(', ')}`,
    });
    return;
  }
  if (implementationNotes !== undefined && implementationNotes !== null && typeof implementationNotes !== 'string') {
    res.status(400).json({ error: 'implementationNotes must be text' });
    return;
  }
  if (responsibleRole !== undefined && responsibleRole !== null && typeof responsibleRole !== 'string') {
    res.status(400).json({ error: 'responsibleRole must be text' });
    return;
  }

  const effectiveUser = updatedBy || req.user?.name || req.user?.email || 'Compliance Assessor';

  if (!(await ensureControlInProgram(req, res, String(controlId)))) return;

  try {
    const written = await writeControlAssessment(
      scopeOf(req),
      String(controlId),
      () => ({
        status: status || null,
        notes: implementationNotes ?? null,
        role: responsibleRole || null,
        updatedBy: effectiveUser,
      }),
      { source: 'human', actor: req.user?.name || req.user?.email || 'Compliance Assessor', userId: req.user?.uid ?? null }
    );

    if (!written) {
      res.status(404).json({ error: `Control ${controlId} not found or RLS restricted` });
      return;
    }

    const updated = mapRowToControl(written);
    res.json({
      message: `Control ${controlId} updated successfully`,
      control: updated,
    });
  } catch (err: unknown) {
    console.error(`[Controls API] Error updating control ${controlId} for tenant ${tenantId}:`, errorMessage(err));
    res.status(500).json({
      error: `Failed to update control ${controlId}`,
      details: errorMessage(err),
    });
  }
});

/**
 * GET /api/v1/controls/:controlId/history?limit=
 * Who changed the control and when, newest first. Carries the SHA-256 and length of the notes, never their text. Every role may read it.
 */
router.get('/:controlId/history', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const controlId = String(req.params.controlId);
  if (!(await ensureControlInProgram(req, res, controlId))) return;

  const rawLimit = typeof req.query.limit === 'string' ? req.query.limit : '';
  const limit = /^\d+$/.test(rawLimit) ? Math.min(200, Math.max(1, Number(rawLimit))) : 50;
  try {
    const events = await listControlAssessmentEvents(scopeOf(req), controlId, limit);
    res.json({ tenantId, controlId, totalCount: events.length, events });
  } catch (err: unknown) {
    console.error(`[Controls API] Error reading the history of ${controlId} for tenant ${tenantId}:`, err);
    res.status(500).json({ error: 'Failed to load the control history' });
  }
});

export default router;
