import { Router, Request, Response } from 'express';
import type pg from 'pg';
import { getTenantProgram, queryWithTenant } from '../db';
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

  try {
    // Framework segregation: a tenant serves the frameworks of its program. With no framework asked for, its primary one.
    const program = await getTenantProgram(tenantId);
    const asked = req.query.framework_id || req.query.framework;
    const query = !asked && program ? { ...req.query, framework_id: program.primaryFramework } : req.query;
    const { framework, baseline, overlay } = normalizeFrameworkParams(query);
    if (!(await ensureFrameworkEnabled(req, res, framework, program))) return;

    // 1. Resolve canonical controls for the requested framework and overlay
    const frameworkControls = getFrameworkControls(framework, baseline, overlay);
    const targetControlIds = frameworkControls.map(c => c.id);

    // 2. Query tenant assessment records from Cloud SQL (guarded by RLS)
    const result = await queryWithTenant(
      tenantId,
      'SELECT * FROM control_assessments WHERE tenant_id = $1 ORDER BY control_id ASC',
      [tenantId]
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
          const insertRes = await queryWithTenant(
            tenantId,
            `INSERT INTO control_assessments (tenant_id, control_id, status, implementation_notes, responsible_role, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant_id, control_id) DO NOTHING
             RETURNING *`,
            [tenantId, ctrlId, 'NOT_STARTED', '', 'IT / Security Lead', req.user?.name || 'System Initializer']
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
 */
router.put('/:controlId', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;
  const { controlId } = req.params;
  const { status, implementationNotes, responsibleRole, updatedBy } = req.body;

  // Validate status if provided
  const validStatuses = ['NOT_STARTED', 'IN_PROGRESS', 'MET', 'NOT_MET'];
  if (status && !validStatuses.includes(status)) {
    res.status(400).json({
      error: `Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`,
    });
    return;
  }

  const effectiveUser = updatedBy || req.user?.name || req.user?.email || 'Compliance Assessor';

  if (!(await ensureControlInProgram(req, res, String(controlId)))) return;

  try {
    const upsertQuery = `
      INSERT INTO control_assessments (
        tenant_id, control_id, status, implementation_notes, responsible_role, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6
      )
      ON CONFLICT (tenant_id, control_id)
      DO UPDATE SET
        status = COALESCE($3, control_assessments.status),
        implementation_notes = COALESCE($4, control_assessments.implementation_notes),
        responsible_role = COALESCE($5, control_assessments.responsible_role),
        updated_by = $6,
        updated_at = NOW()
      RETURNING *;
    `;

    const result = await queryWithTenant(tenantId, upsertQuery, [
      tenantId,
      controlId,
      status || 'NOT_STARTED',
      implementationNotes ?? '',
      responsibleRole || 'IT / Security Lead',
      effectiveUser,
    ]);

    if (!result.rows.length) {
      res.status(404).json({ error: `Control ${controlId} not found or RLS restricted` });
      return;
    }

    const updated = mapRowToControl(result.rows[0]);
    res.json({
      message: `Control ${controlId} updated successfully`,
      control: updated,
    });
  } catch (err: unknown) {
    console.error(`[Controls API] Error updating control ${controlId} for tenant ${tenantId}:`, err);
    res.status(500).json({
      error: `Failed to update control ${controlId}`,
      details: errorMessage(err),
    });
  }
});

export default router;
