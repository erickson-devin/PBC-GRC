import { getAccountDormantDays } from './localAuth';
import { findLocalUserByEmail, disableDormantLocalUser, listDormantCandidates, type LocalUser } from './localUsers';
import { platformAdminEmails } from './platformAdmin';
import { accountLogRef } from './loginThrottle';
import { listStoredPlatformAdminEmails } from '../platformSetup';
import type { AccountEventInput } from './accountEvents';

/**
 * Dormant accounts (NIST SP 800-171 3.5.6, CMMC IA.L2-3.5.6, issue #257): an enabled account whose latest completed sign-in (or creation,
 * or last restore) is older than ACCOUNT_DORMANT_DAYS is disabled. Two paths: the daily sweep (accountRetention.ts) and the sign-in
 * itself (a dormant account with the right password is refused and disabled on the spot). A dormancy disable ends the sessions but KEEPS
 * the second factor; the account is restored through an enable (platform administrator, or a Tenant Owner / MSP Admin for members they
 * manage). The last enabled platform administrator is never disabled here: the installation would have nobody left to restore anyone
 * (the CLI `npm run auth:enable-user` is the break-glass). Logs carry counts, SQLSTATE codes and account references only.
 */

const DAY_MS = 24 * 3_600_000;

type ActivityTimes = Pick<LocalUser, 'lastLoginAt' | 'createdAt' | 'dormancyResetAt'>;

/** True when the latest of the sign-in, creation and restore times is older than `days` before `now`. Never with days <= 0. */
export function isDormant(u: ActivityTimes, now: Date, days: number): boolean {
  if (!(days > 0)) return false;
  const latest = Math.max(u.lastLoginAt?.getTime() ?? 0, u.createdAt.getTime(), u.dormancyResetAt.getTime());
  return latest < now.getTime() - days * DAY_MS;
}

/** One startup line. */
export function describeAccountDormancy(days: number): string {
  return days > 0
    ? `Dormant accounts: accounts with no sign-in for ${days} days are disabled (ACCOUNT_DORMANT_DAYS)`
    : 'Dormant accounts: inactive accounts are never disabled (ACCOUNT_DORMANT_DAYS=0)';
}

export interface DormancySweepResult {
  skipped: boolean;
  disabled: number;
  keptLastAdmin: number;
  errors: number;
}

const sqlState = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
};

/** Account ids of the platform administrators (configured or stored) whose account exists and is enabled. */
async function enabledPlatformAdminIds(): Promise<Set<string>> {
  const emails = new Set<string>([...platformAdminEmails(), ...(await listStoredPlatformAdminEmails())]);
  const enabled = new Set<string>();
  for (const email of emails) {
    const account = await findLocalUserByEmail(email);
    if (!account) continue;
    if (!account.disabled) enabled.add(account.id);
  }
  return enabled;
}

let sweeping = false;

/** Disables every dormant account except the last enabled platform administrator. Never throws; logs counts and SQLSTATE codes only. */
export async function disableDormantAccounts(opts: { now?: Date; days?: number } = {}): Promise<DormancySweepResult> {
  if (sweeping) return { skipped: true, disabled: 0, keptLastAdmin: 0, errors: 0 };
  sweeping = true;
  const result: DormancySweepResult = { skipped: false, disabled: 0, keptLastAdmin: 0, errors: 0 };
  try {
    const days = opts.days ?? getAccountDormantDays();
    if (!(days > 0)) return { skipped: true, disabled: 0, keptLastAdmin: 0, errors: 0 };
    const now = opts.now ?? new Date();
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    const candidates = await listDormantCandidates(cutoff);
    const adminIds = await enabledPlatformAdminIds();
    for (const user of candidates) {
      try {
        if (adminIds.has(user.id) && adminIds.size <= 1) {
          result.keptLastAdmin += 1;
          console.warn(`[Dormancy] kept the last platform administrator enabled (account ${accountLogRef(user.email)})`);
          continue;
        }
        const event: AccountEventInput = {
          actorKind: 'system',
          actorUserId: null,
          targetUserId: user.id,
          action: 'account_disabled',
          details: { reason: 'dormant', via: 'sweep' },
        };
        if (await disableDormantLocalUser(user.id, cutoff, event)) {
          result.disabled += 1;
          adminIds.delete(user.id);
        }
      } catch (err: unknown) {
        result.errors += 1;
        console.error(`[Dormancy] could not disable a dormant account (code ${sqlState(err)})`);
      }
    }
    if (result.disabled > 0 || result.errors > 0) console.log(`[Dormancy] sweep: disabled ${result.disabled} dormant account(s), ${result.errors} error(s)`);
    return result;
  } catch (err: unknown) {
    result.errors += 1;
    console.error(`[Dormancy] sweep failed (code ${sqlState(err)})`);
    return result;
  } finally {
    sweeping = false;
  }
}

/**
 * Sign-in path: disables `user` (already checked against the password by the caller) when it is dormant. True means the account is
 * dormant and the sign-in must be refused. The last enabled platform administrator is kept (false). If the write fails the account is
 * still refused (fail closed) and only the SQLSTATE code is logged.
 */
export async function disableIfDormant(user: LocalUser, now: Date = new Date()): Promise<boolean> {
  let days: number;
  try {
    days = getAccountDormantDays();
  } catch {
    return false; // a bad setting is refused at startup; never lock people out because of it
  }
  if (!isDormant(user, now, days)) return false;
  try {
    const adminIds = await enabledPlatformAdminIds();
    if (adminIds.has(user.id) && adminIds.size <= 1) {
      console.warn(`[Dormancy] kept the last platform administrator enabled (account ${accountLogRef(user.email)})`);
      return false;
    }
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    await disableDormantLocalUser(user.id, cutoff, {
      actorKind: 'system',
      actorUserId: null,
      targetUserId: user.id,
      action: 'account_disabled',
      details: { reason: 'dormant', via: 'sign_in' },
    });
    return true;
  } catch (err: unknown) {
    console.error(`[Dormancy] could not disable a dormant account at sign-in (code ${sqlState(err)})`);
    return true;
  }
}
