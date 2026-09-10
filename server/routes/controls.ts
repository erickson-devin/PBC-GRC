import { Router, Request, Response } from 'express';
import { queryWithTenant } from '../db';

const router = Router();

// Canonical list of all 17 CMMC 2.0 Level 1 Security Controls (FAR 52.204-21)
export const CMMC_L1_CONTROL_IDS = [
  'AC.L1-3.1.1',
  'AC.L1-3.1.2',
  'AC.L1-3.1.20',
  'AC.L1-3.1.22',
  'IA.L1-3.5.1',
  'IA.L1-3.5.2',
  'MP.L1-3.8.3',
  'PE.L1-3.10.1',
  'PE.L1-3.10.3',
  'PE.L1-3.10.4',
  'PE.L1-3.10.5',
  'SC.L1-3.13.1',
  'SC.L1-3.13.5',
  'SI.L1-3.14.1',
  'SI.L1-3.14.2',
  'SI.L1-3.14.4',
  'SI.L1-3.14.5',
];

/**
 * Format DB row into client-compatible ControlState
 */
function mapRowToControl(row: any) {
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
 * GET /api/v1/controls
 * Fetches all 17 CMMC Level 1 control statuses for the active user's tenant_id.
 * If controls do not exist yet for this tenant, seeds all 17 controls automatically.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.tenantId!;

  try {
    const result = await queryWithTenant(
      tenantId,
      'SELECT * FROM control_assessments WHERE tenant_id = $1 ORDER BY control_id ASC',
      [tenantId]
    );

    const existingMap = new Map<string, any>();
    for (const row of result.rows) {
      existingMap.set(row.control_id, row);
    }

    // Ensure all 17 CMMC Level 1 controls exist for this tenant
    const controlsList: any[] = [];
    const missingControls: string[] = [];

    for (const ctrlId of CMMC_L1_CONTROL_IDS) {
      if (existingMap.has(ctrlId)) {
        controlsList.push(mapRowToControl(existingMap.get(ctrlId)));
      } else {
        missingControls.push(ctrlId);
      }
    }

    // Seed any missing controls into PostgreSQL under the tenant's RLS boundary
    if (missingControls.length > 0) {
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
        } catch (insertErr) {
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
    }

    // Sort consistently
    controlsList.sort((a, b) => a.id.localeCompare(b.id));

    res.json({
      tenantId,
      totalCount: controlsList.length,
      controls: controlsList,
    });
  } catch (err: any) {
    console.error(`[Controls API] Error fetching controls for tenant ${tenantId}:`, err);
    res.status(500).json({
      error: 'Failed to fetch control assessments',
      details: err.message,
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
  } catch (err: any) {
    console.error(`[Controls API] Error updating control ${controlId} for tenant ${tenantId}:`, err);
    res.status(500).json({
      error: `Failed to update control ${controlId}`,
      details: err.message,
    });
  }
});

export default router;
