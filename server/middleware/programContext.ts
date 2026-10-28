import { Request, Response, NextFunction } from 'express';
import { ensureDefaultProgram, getProgram } from '../programs';
import { errorMessage } from '../../src/utils/errors';

/** The same shape the tenant id has: letters, digits, underscore and hyphen (the ids are UUIDs, or VARCHAR(64) ones). */
const PROGRAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the program (authorization boundary) a request runs in, from the stateless `x-program-id` header, and sets req.programId and
 * req.program. Must run after authMiddleware, which sets req.tenantId.
 *   - header absent: the tenant's default program (created, and the tenant's legacy rows adopted, on first use);
 *   - header malformed: 400; unknown, or another tenant's program: 404 program_not_found (the two are indistinguishable);
 *   - archived program: reads (GET / HEAD / OPTIONS) go through, any other method is refused with 409 program_archived.
 * It is not mounted on /tenants/:tenantId/programs (the programs API works on archived programs and names them in the URL).
 */
export async function programContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantId = req.tenantId;
  if (!tenantId) {
    res.status(401).json({ error: 'Unauthorized: no tenant context' });
    return;
  }
  const raw = req.headers['x-program-id'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header !== undefined && (typeof header !== 'string' || !PROGRAM_ID_PATTERN.test(header))) {
    res.status(400).json({ error: 'Invalid x-program-id header format' });
    return;
  }

  try {
    // Always: it also adopts the tenant's legacy rows (no program yet), which a read counts as the program's own until then
    const defaultProgram = await ensureDefaultProgram(tenantId);
    const program = header === undefined ? defaultProgram : await getProgram(tenantId, header);
    if (!program) {
      res.status(404).json({ error: 'Program not found', code: 'program_not_found' });
      return;
    }
    if (program.archivedAt && !READ_ONLY_METHODS.has(req.method)) {
      res.status(409).json({ error: 'This program is archived: it can be read but not changed', code: 'program_archived' });
      return;
    }
    req.programId = program.id;
    req.program = program;
    next();
  } catch (err: unknown) {
    console.error(`[Program Context] Failed to resolve the program for tenant ${tenantId}:`, errorMessage(err));
    res.status(500).json({ error: 'Failed to resolve the program' });
  }
}
