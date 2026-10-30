import crypto from 'crypto';
import { LOCKOUT_MINUTES, MAX_FAILED_ATTEMPTS, normalizeEmail } from './localUsers';
import { getLocalAuthSecret } from './localAuth';
import { deriveKey } from './mfaCrypto';

/**
 * In-memory sign-in throttle: a per-IP request window plus a per-account failure lock that also covers emails with no
 * account (so a guess against an unknown address locks exactly like one against a real address, and the 429 reveals
 * nothing). State is per process and is lost on restart; the persistent per-account lockout in localUsers still applies
 * to real accounts. Keys are hashes: no email address is ever held in memory here.
 */

/** Stable, non-reversible key for an email address ('acct:' + sha256 hex of the normalised address). Memory only: never logged. */
export function loginAccountKey(email: string): string {
  return 'acct:' + crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

/**
 * Short reference to an account for log lines: an HMAC under a key derived from LOCAL_AUTH_SECRET, so the same account
 * is recognisable across lines but a reader of the logs alone cannot match it against a list of addresses (a plain
 * hash could be). Never the email itself.
 */
export function accountLogRef(email: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = deriveKey(getLocalAuthSecret(env), 'pbc-grc account-log-ref v1');
  return crypto.createHmac('sha256', key).update(normalizeEmail(email)).digest('hex').slice(0, 12);
}

export interface LoginThrottleOptions {
  now?: () => number;
  ipWindowMs?: number;
  ipMax?: number;
  accountMaxFailures?: number;
  accountLockMs?: number;
  maxKeys?: number;
}

interface AccountEntry {
  failures: number;
  /** Epoch ms until which the account is locked; 0 while it is only counting. */
  lockedUntil: number;
  /** Last activity, used to drop stale counts. */
  touched: number;
}

export function createLoginThrottle(options: LoginThrottleOptions = {}) {
  const now = options.now ?? Date.now;
  const ipWindowMs = options.ipWindowMs ?? 60_000;
  const ipMax = options.ipMax ?? 20;
  const accountMaxFailures = options.accountMaxFailures ?? MAX_FAILED_ATTEMPTS;
  const accountLockMs = options.accountLockMs ?? LOCKOUT_MINUTES * 60_000;
  const maxKeys = options.maxKeys ?? 10_000;

  const ipHits = new Map<string, number[]>();
  const accounts = new Map<string, AccountEntry>();

  /** Makes room for one more key: expired entries first, then the oldest by insertion. Never clears the whole map. */
  function makeRoom<V>(map: Map<string, V>, isExpired: (value: V, t: number) => boolean): void {
    if (map.size < maxKeys) return;
    const t = now();
    for (const [key, value] of map) if (isExpired(value, t)) map.delete(key);
    while (map.size >= maxKeys) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  const accountExpired = (entry: AccountEntry, t: number): boolean =>
    entry.lockedUntil > 0 ? entry.lockedUntil <= t : t - entry.touched >= accountLockMs;

  return {
    hitIp(ip: string): { limited: boolean; retryAfterSeconds: number } {
      const t = now();
      const recent = (ipHits.get(ip) ?? []).filter((hit) => t - hit < ipWindowMs);
      recent.push(t);
      if (!ipHits.has(ip)) makeRoom(ipHits, (hits, at) => hits.every((hit) => at - hit >= ipWindowMs));
      ipHits.set(ip, recent);
      return { limited: recent.length > ipMax, retryAfterSeconds: Math.ceil(ipWindowMs / 1000) };
    },

    /** Seconds left on the lock, 0 when the account is not locked. */
    accountLockedFor(key: string): number {
      const entry = accounts.get(key);
      if (!entry || entry.lockedUntil <= now()) return 0;
      return Math.ceil((entry.lockedUntil - now()) / 1000);
    },

    recordAccountFailure(key: string): void {
      const t = now();
      let entry = accounts.get(key);
      if (entry && accountExpired(entry, t)) {
        accounts.delete(key);
        entry = undefined;
      }
      if (!entry) {
        makeRoom(accounts, accountExpired);
        entry = { failures: 0, lockedUntil: 0, touched: t };
        accounts.set(key, entry);
      }
      // A failure while locked neither extends the lock nor restarts the count.
      if (entry.lockedUntil > t) return;
      entry.failures += 1;
      entry.touched = t;
      if (entry.failures >= accountMaxFailures) entry.lockedUntil = t + accountLockMs;
    },

    clearAccount(key: string): void {
      accounts.delete(key);
    },

    reset(): void {
      ipHits.clear();
      accounts.clear();
    },

    sizes(): { ip: number; account: number } {
      return { ip: ipHits.size, account: accounts.size };
    },
  };
}
