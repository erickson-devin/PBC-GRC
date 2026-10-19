import type pg from 'pg';
import { queryWithTenant } from './db';

/**
 * Read and write access to a tenant's control_assessments rows for the vulnerability-management snapshot. The SQL is copied
 * from the SSP import (server/ssp/runner.ts, server/ssp/commit.ts) on purpose, so the VM module does not depend on it.
 */

/** Mirrors the statuses PUT /controls accepts. */
export const CONTROL_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'MET', 'NOT_MET'] as const;

export interface ControlAssessment {
  status: string;
  notes: string;
  role: string;
  updatedAt: string | null;
}

/** The tenant's current control answers, by control id. */
export async function readControlAssessments(tenantId: string): Promise<Map<string, ControlAssessment>> {
  const res = await queryWithTenant(tenantId, 'SELECT * FROM control_assessments WHERE tenant_id = $1', [tenantId]);
  const map = new Map<string, ControlAssessment>();
  for (const row of res.rows) {
    if (row.tenant_id !== tenantId) continue; // defence in depth: the store already filters by tenant
    map.set(String(row.control_id), {
      status: row.status || 'NOT_STARTED',
      notes: row.implementation_notes || '',
      role: row.responsible_role || 'IT / Security Lead',
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    });
  }
  return map;
}

const UPSERT = `
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

export interface ControlAssessmentWrite {
  controlId: string;
  status: string;
  notes: string;
  role: string;
  updatedBy: string;
}

/** Writes one control's answer. The caller passes the current status and role through unchanged: the memory store overwrites every column. */
export async function upsertControlAssessment(tenantId: string, w: ControlAssessmentWrite): Promise<pg.QueryResultRow> {
  if (!(CONTROL_STATUSES as readonly string[]).includes(w.status)) throw new Error(`Invalid control status: ${w.status}`);
  const written = await queryWithTenant(tenantId, UPSERT, [tenantId, w.controlId, w.status, w.notes, w.role, w.updatedBy]);
  if (!written.rows.length) throw new Error(`Control ${w.controlId} could not be written`);
  return written.rows[0];
}
