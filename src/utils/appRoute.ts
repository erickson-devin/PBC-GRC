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

/** Where '/' and every unknown path end up. */
export const resolveRoot = (isAuthenticated: boolean): Exclude<AppRoute, 'root'> => (isAuthenticated ? 'app' : 'login');
