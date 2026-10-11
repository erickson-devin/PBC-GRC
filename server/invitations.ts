import crypto from 'crypto';
import type pg from 'pg';
import { getDbMode, getMemoryTenantName, getTenantRole, pool, upsertTenantMember } from './db';
import { isTenantRole, maxRole } from '../src/utils/roles';
import type { TenantRole } from '../src/types/tenant';

/**
 * Tenant invitations.
 *
 * Security model:
 *  - The invitation secret is 256 random bits. Only its SHA-256 hash is stored, so a database leak yields no working
 *    invitations; the plaintext exists once, in the response to the inviter.
 *  - An invitation is single-use: it is consumed with a conditional UPDATE inside the same transaction that adds the
 *    member, so two simultaneous accepts cannot both succeed, and a failure part-way leaves it unconsumed.
 *  - It is bound to an email address, expires, and can be revoked. Accepting never lowers an existing role.
 *  - Redemption works before the user belongs to any tenant through RLS policies keyed on the hash of the presented
 *    token (see DISCOVERY_POLICIES in schema.ts); a request without the token can see none of these rows.
 */

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface InvitationRecord {
  id: string;
  tenantId: string;
  email: string;
  role: TenantRole;
  createdBy: string;
  createdByUserId: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedByUserId: string | null;
  revokedAt: string | null;
  status: InvitationStatus;
}

export type InvitationErrorCode = 'not_found' | 'accepted' | 'revoked' | 'limit';

export class InvitationError extends Error {
  readonly code: InvitationErrorCode;
  constructor(code: InvitationErrorCode, message: string) {
    super(message);
    this.name = 'InvitationError';
    this.code = code;
  }
}

export const DEFAULT_INVITE_DAYS = 14;
export const MAX_INVITE_DAYS = 30;
export const MAX_PENDING_PER_TENANT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export const generateInviteToken = (): string => `inv_${crypto.randomBytes(32).toString('base64url')}`;
export const hashInviteToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

const clampDays = (days: number | undefined): number =>
  Number.isFinite(days) ? Math.min(MAX_INVITE_DAYS, Math.max(1, Math.floor(days as number))) : DEFAULT_INVITE_DAYS;

export function statusOf(r: { acceptedAt: string | null; revokedAt: string | null; expiresAt: string }, now = Date.now()): InvitationStatus {
  if (r.acceptedAt) return 'ACCEPTED';
  if (r.revokedAt) return 'REVOKED';
  return new Date(r.expiresAt).getTime() <= now ? 'EXPIRED' : 'PENDING';
}

// ------------------------------------------------------------------------------------------------ memory store

interface MemoryInvitation extends Omit<InvitationRecord, 'status'> {
  tokenHash: string;
}
const memoryInvitations = new Map<string, MemoryInvitation>(); // key: id

const withStatus = (m: MemoryInvitation): InvitationRecord => {
  const { tokenHash: _tokenHash, ...rest } = m;
  return { ...rest, status: statusOf(m) };
};

/** Test hook. */
export function __resetMemoryInvitationsForTests(): void {
  memoryInvitations.clear();
}

/** Test hook (in-memory mode only): makes an invitation expired as of an hour ago. */
export function __expireInvitationForTests(id: string): void {
  const m = memoryInvitations.get(id);
  if (m) m.expiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

// ------------------------------------------------------------------------------------------------ PostgreSQL helpers

function rowToRecord(row: pg.QueryResultRow): InvitationRecord {
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const base = {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    email: row.email as string,
    role: row.role as TenantRole,
    createdBy: row.created_by as string,
    createdByUserId: (row.created_by_user_id as string | null) ?? null,
    createdAt: iso(row.created_at) as string,
    expiresAt: iso(row.expires_at) as string,
    acceptedAt: iso(row.accepted_at),
    acceptedByUserId: (row.accepted_by_user_id as string | null) ?? null,
    revokedAt: iso(row.revoked_at),
  };
  return { ...base, status: statusOf(base) };
}

/** Runs `fn` in a transaction with the tenant's RLS context set. */
async function inTenantTx<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const isMemory = (): boolean => getDbMode() === 'memory';
const normEmail = (email: string): string => email.trim().toLowerCase();

// ------------------------------------------------------------------------------------------------ tenant-scoped operations

export interface NewInvitation {
  email: string;
  role: TenantRole;
  createdBy: string;
  createdByUserId: string | null;
  expiresInDays?: number;
}

/**
 * Creates an invitation and returns it together with the one-time plaintext token. Any earlier PENDING invitation
 * for the same email in this tenant is revoked, so only the newest link works.
 */
export async function createInvitation(tenantId: string, input: NewInvitation): Promise<{ invitation: InvitationRecord; token: string }> {
  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);
  const email = normEmail(input.email);
  const expiresAt = new Date(Date.now() + clampDays(input.expiresInDays) * DAY_MS).toISOString();

  if (isMemory()) {
    const pending = [...memoryInvitations.values()].filter((m) => m.tenantId === tenantId && statusOf(m) === 'PENDING');
    if (pending.length >= MAX_PENDING_PER_TENANT) throw new InvitationError('limit', 'Too many pending invitations for this tenant');
    const now = new Date().toISOString();
    for (const m of pending) if (m.email === email) m.revokedAt = now;
    const record: MemoryInvitation = {
      id: `inv_${crypto.randomBytes(8).toString('hex')}`,
      tenantId, email, role: input.role, createdBy: input.createdBy, createdByUserId: input.createdByUserId,
      createdAt: now, expiresAt, acceptedAt: null, acceptedByUserId: null, revokedAt: null, tokenHash,
    };
    memoryInvitations.set(record.id, record);
    return { invitation: withStatus(record), token };
  }

  const invitation = await inTenantTx(tenantId, async (client) => {
    const pending = await client.query(
      'SELECT count(*)::int AS n FROM tenant_invitations WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()',
      [tenantId]
    );
    if (pending.rows[0].n >= MAX_PENDING_PER_TENANT) throw new InvitationError('limit', 'Too many pending invitations for this tenant');
    await client.query(
      'UPDATE tenant_invitations SET revoked_at = NOW() WHERE tenant_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL',
      [tenantId, email]
    );
    const res = await client.query(
      `INSERT INTO tenant_invitations (tenant_id, token_hash, email, role, created_by, created_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenantId, tokenHash, email, input.role, input.createdBy, input.createdByUserId, expiresAt]
    );
    return rowToRecord(res.rows[0]);
  });
  return { invitation, token };
}

export async function listInvitations(tenantId: string): Promise<InvitationRecord[]> {
  if (isMemory()) {
    return [...memoryInvitations.values()]
      .filter((m) => m.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(withStatus);
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query('SELECT * FROM tenant_invitations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500', [tenantId]);
    return res.rows.map(rowToRecord);
  });
}

async function getOwned(tenantId: string, id: string): Promise<InvitationRecord | null> {
  if (isMemory()) {
    const m = memoryInvitations.get(id);
    return m && m.tenantId === tenantId ? withStatus(m) : null;
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query('SELECT * FROM tenant_invitations WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  });
}

/** An invitation that is already accepted or revoked can no longer be changed. */
function assertMutable(r: InvitationRecord): void {
  if (r.status === 'ACCEPTED') throw new InvitationError('accepted', 'This invitation has already been accepted');
  if (r.status === 'REVOKED') throw new InvitationError('revoked', 'This invitation has been revoked');
}

export async function revokeInvitation(tenantId: string, id: string): Promise<InvitationRecord> {
  const current = await getOwned(tenantId, id);
  if (!current) throw new InvitationError('not_found', 'Invitation not found');
  if (current.status === 'ACCEPTED') throw new InvitationError('accepted', 'An accepted invitation cannot be revoked; remove the member instead');
  if (current.status === 'REVOKED') return current;

  if (isMemory()) {
    const m = memoryInvitations.get(id)!;
    m.revokedAt = new Date().toISOString();
    return withStatus(m);
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query(
      'UPDATE tenant_invitations SET revoked_at = NOW() WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL RETURNING *',
      [id, tenantId]
    );
    if (res.rows.length === 0) throw new InvitationError('accepted', 'This invitation was accepted in the meantime');
    return rowToRecord(res.rows[0]);
  });
}

/** Issues a NEW token (the old one stops working) and restarts the expiry clock. Used by "resend". */
export async function rotateInvitation(tenantId: string, id: string, expiresInDays?: number): Promise<{ invitation: InvitationRecord; token: string }> {
  const current = await getOwned(tenantId, id);
  if (!current) throw new InvitationError('not_found', 'Invitation not found');
  assertMutable(current);

  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + clampDays(expiresInDays) * DAY_MS).toISOString();

  if (isMemory()) {
    const m = memoryInvitations.get(id)!;
    m.tokenHash = tokenHash;
    m.expiresAt = expiresAt;
    return { invitation: withStatus(m), token };
  }
  const invitation = await inTenantTx(tenantId, async (client) => {
    const res = await client.query(
      'UPDATE tenant_invitations SET token_hash = $3, expires_at = $4 WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING *',
      [id, tenantId, tokenHash, expiresAt]
    );
    if (res.rows.length === 0) throw new InvitationError('accepted', 'This invitation can no longer be changed');
    return rowToRecord(res.rows[0]);
  });
  return { invitation, token };
}

/** Pushes the expiry out by `days` from the later of now and the current expiry. The token stays the same. */
export async function extendInvitation(tenantId: string, id: string, days: number): Promise<InvitationRecord> {
  const current = await getOwned(tenantId, id);
  if (!current) throw new InvitationError('not_found', 'Invitation not found');
  assertMutable(current);
  const base = Math.max(Date.now(), new Date(current.expiresAt).getTime());
  const expiresAt = new Date(base + clampDays(days) * DAY_MS).toISOString();

  if (isMemory()) {
    const m = memoryInvitations.get(id)!;
    m.expiresAt = expiresAt;
    return withStatus(m);
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query(
      'UPDATE tenant_invitations SET expires_at = $3 WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING *',
      [id, tenantId, expiresAt]
    );
    if (res.rows.length === 0) throw new InvitationError('accepted', 'This invitation can no longer be changed');
    return rowToRecord(res.rows[0]);
  });
}

/** Changes the email or role of an invitation that has not been used yet. */
export async function updateInvitation(tenantId: string, id: string, patch: { email?: string; role?: TenantRole }): Promise<InvitationRecord> {
  const current = await getOwned(tenantId, id);
  if (!current) throw new InvitationError('not_found', 'Invitation not found');
  assertMutable(current);
  const email = patch.email ? normEmail(patch.email) : current.email;
  const role = patch.role ?? current.role;

  if (isMemory()) {
    const m = memoryInvitations.get(id)!;
    m.email = email;
    m.role = role;
    return withStatus(m);
  }
  return inTenantTx(tenantId, async (client) => {
    const res = await client.query(
      'UPDATE tenant_invitations SET email = $3, role = $4 WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING *',
      [id, tenantId, email, role]
    );
    if (res.rows.length === 0) throw new InvitationError('accepted', 'This invitation can no longer be changed');
    return rowToRecord(res.rows[0]);
  });
}

// ------------------------------------------------------------------------------------------------ redemption (token holder)

export interface InvitationPreview {
  tenantId: string;
  tenantName: string;
  email: string;
  role: TenantRole;
  expiresAt: string;
  status: InvitationStatus;
  createdBy: string;
}

/** What the accept page shows before sign-in. Needs only the token; returns null for an unknown token. */
export async function previewInvitation(token: string): Promise<InvitationPreview | null> {
  const tokenHash = hashInviteToken(token);

  if (isMemory()) {
    const m = [...memoryInvitations.values()].find((i) => i.tokenHash === tokenHash);
    if (!m) return null;
    return { tenantId: m.tenantId, tenantName: getMemoryTenantName(m.tenantId) ?? m.tenantId, email: m.email, role: m.role, expiresAt: m.expiresAt, status: statusOf(m), createdBy: m.createdBy };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.invite_token_hash', tokenHash]);
    const res = await client.query(
      `SELECT i.*, t.name AS tenant_name FROM tenant_invitations i LEFT JOIN tenants t ON t.id = i.tenant_id WHERE i.token_hash = $1`,
      [tokenHash]
    );
    await client.query('COMMIT');
    if (res.rows.length === 0) return null;
    const rec = rowToRecord(res.rows[0]);
    return { tenantId: rec.tenantId, tenantName: res.rows[0].tenant_name ?? rec.tenantId, email: rec.email, role: rec.role, expiresAt: rec.expiresAt, status: rec.status, createdBy: rec.createdBy };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type RedeemResult =
  | { ok: true; tenantId: string; role: TenantRole; previousRole: TenantRole | null; invitationId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'revoked' | 'email_mismatch' };

function checkRedeemable(r: InvitationRecord, userEmail: string | undefined): RedeemResult | null {
  if (r.status === 'REVOKED') return { ok: false, reason: 'revoked' };
  if (r.status === 'ACCEPTED') return { ok: false, reason: 'used' };
  if (r.status === 'EXPIRED') return { ok: false, reason: 'expired' };
  // Bound to the invited address: a forwarded link must not grant access to whoever clicks it.
  if (!userEmail || normEmail(userEmail) !== r.email) return { ok: false, reason: 'email_mismatch' };
  return null;
}

/**
 * Consumes the invitation and adds the user to the tenant, atomically.
 * The user gets the invited role, or keeps a higher role they already hold.
 */
export async function redeemInvitation(token: string, user: { uid: string; email?: string; name?: string }): Promise<RedeemResult> {
  const tokenHash = hashInviteToken(token);

  if (isMemory()) {
    const m = [...memoryInvitations.values()].find((i) => i.tokenHash === tokenHash);
    if (!m) return { ok: false, reason: 'invalid' };
    const blocked = checkRedeemable(withStatus(m), user.email);
    if (blocked) return blocked;

    const previousRole = await getTenantRole(user.uid, m.tenantId);
    const role = maxRole(previousRole, m.role);
    m.acceptedAt = new Date().toISOString(); // consumed first: nothing below can run twice
    m.acceptedByUserId = user.uid;
    await upsertTenantMember(m.tenantId, { userId: user.uid, email: normEmail(user.email!), name: user.name || user.email!.split('@')[0], role });
    return { ok: true, tenantId: m.tenantId, role, previousRole, invitationId: m.id };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.invite_token_hash', tokenHash]);
    const found = await client.query('SELECT * FROM tenant_invitations WHERE token_hash = $1', [tokenHash]);
    if (found.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid' };
    }
    const rec = rowToRecord(found.rows[0]);
    const blocked = checkRedeemable(rec, user.email);
    if (blocked) {
      await client.query('ROLLBACK');
      return blocked;
    }

    // From here on act as the tenant: the member row and the consumption are tenant-scoped writes.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', rec.tenantId]);
    const consumed = await client.query(
      `UPDATE tenant_invitations SET accepted_at = NOW(), accepted_by_user_id = $2
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() RETURNING id`,
      [rec.id, user.uid]
    );
    if (consumed.rows.length === 0) {
      await client.query('ROLLBACK'); // lost a race with another accept / revoke
      return { ok: false, reason: 'used' };
    }

    const existing = await client.query('SELECT role FROM tenant_users WHERE tenant_id = $1 AND user_id = $2', [rec.tenantId, user.uid]);
    const previousRole = existing.rows[0] && isTenantRole(existing.rows[0].role) ? (existing.rows[0].role as TenantRole) : null;
    const role = maxRole(previousRole, rec.role);
    await client.query(
      `INSERT INTO tenant_users (user_id, user_email, user_name, tenant_id, role) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, tenant_id) DO UPDATE
         SET role = EXCLUDED.role, user_email = EXCLUDED.user_email, user_name = EXCLUDED.user_name, updated_at = NOW()`,
      [user.uid, normEmail(user.email!), user.name || user.email!.split('@')[0], rec.tenantId, role]
    );
    await client.query('COMMIT');
    return { ok: true, tenantId: rec.tenantId, role, previousRole, invitationId: rec.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
