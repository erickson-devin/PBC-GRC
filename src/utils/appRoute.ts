/**
 * Which screen the URL asks for. This is the application only: there is no public site, so the only routes are
 *   login          /login            the sign-in page
 *   accept-invite  /invite, /accept-invite   the page an invited person opens with their token
 *   app            /app, /dashboard, /programs  the enclave (requires a session); /programs opens its programs page
 *   admin          /admin            platform administration
 *   setup          /setup            the first-time setup wizard (only while the installation has no administrator)
 * Anything else, including "/", is 'root': it never shows a page of its own but is sent to the app when signed in and to
 * the login page otherwise (see resolveRoot). The app navigates with the URL hash (#app, #login, ...), which is honoured too.
 */
export type AppRoute = 'root' | 'login' | 'app' | 'admin' | 'accept-invite' | 'setup';

export interface UrlParts {
  pathname: string;
  hash: string;
  search: string;
}

export function routeFromUrl({ pathname, hash, search }: UrlParts): AppRoute {
  const path = pathname.toLowerCase();
  const h = hash.toLowerCase();
  const q = search.toLowerCase();

  if (path === '/setup' || h.startsWith('#setup') || q.includes('view=setup')) return 'setup';
  if (path === '/admin' || h.startsWith('#admin') || q.includes('view=admin')) return 'admin';
  if (path === '/accept-invite' || path === '/invite' || h.startsWith('#accept-invite') || h.startsWith('#invite') || q.includes('view=accept-invite')) {
    return 'accept-invite';
  }
  if (path === '/login' || h.startsWith('#login') || q.includes('view=login')) return 'login';
  if (path === '/app' || path === '/dashboard' || path === '/programs' || h.startsWith('#app') || h.startsWith('#programs') || q.includes('view=app')) return 'app';
  return 'root';
}

/**
 * The tab of the enclave a URL deep-links to, or null when it names none (the app then keeps its own tab). Only the programs
 * page has an address: "#programs" and "/programs".
 */
export function initialTabFromUrl({ pathname, hash }: Pick<UrlParts, 'pathname' | 'hash'>): 'programs' | null {
  return pathname.toLowerCase() === '/programs' || hash.toLowerCase().startsWith('#programs') ? 'programs' : null;
}

/** Where sign-in lands when it was not asked to return somewhere else (or was asked for somewhere unsafe). */
export const SIGNED_IN_DEFAULT = '/#app';

/** The sign-in address that returns to redirectUrl afterwards (the query lives inside the hash). */
export const loginHref = (redirectUrl: string) => `/#login?redirectUrl=${encodeURIComponent(redirectUrl)}`;

/**
 * A redirect target sign-in may follow, or null. Only a same-origin address that opens the app or administration is
 * accepted: no absolute or protocol-relative URL, scheme, backslash, whitespace or control character.
 */
export function safeRedirectTarget(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 512) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  if (raw[0] !== '/' && raw[0] !== '#') return null;
  if (raw.startsWith('//')) return null;
  let u: URL;
  try {
    u = new URL(raw, 'http://app.invalid');
  } catch {
    return null;
  }
  if (u.origin !== 'http://app.invalid') return null;
  const route = routeFromUrl({ pathname: u.pathname, hash: u.hash, search: u.search });
  if (route !== 'app' && route !== 'admin') return null;
  return u.pathname + u.search + u.hash;
}

/** The redirect target named by a sign-in URL (hash query first, then the search), or the default when absent or unsafe. */
export function redirectFromLocation(loc: { hash: string; search: string }): string {
  const q = loc.hash.indexOf('?');
  const fromHash = q >= 0 ? new URLSearchParams(loc.hash.slice(q + 1)).get('redirectUrl') : null;
  const raw = fromHash ?? new URLSearchParams(loc.search).get('redirectUrl');
  return safeRedirectTarget(raw) ?? SIGNED_IN_DEFAULT;
}

/** Where '/' and every unknown path end up. */
export const resolveRoot = (isAuthenticated: boolean): Exclude<AppRoute, 'root'> => (isAuthenticated ? 'app' : 'login');

/** Where a path route goes when its session ends (sign-out, or the server ended it): the sign-in screen, or null to stay. */
export const routeAfterSessionEnd = (route: AppRoute): 'login' | null => (route === 'admin' ? 'login' : null);
