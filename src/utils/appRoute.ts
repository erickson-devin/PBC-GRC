/**
 * Which screen the URL asks for. This is the application only: there is no public site, so the only routes are
 *   login          /login            the sign-in page
 *   accept-invite  /invite, /accept-invite   the page an invited person opens with their token
 *   app            /app, /dashboard  the enclave (requires a session)
 *   admin          /admin            platform administration
 * Anything else, including "/", is 'root': it never shows a page of its own but is sent to the app when signed in and to
 * the login page otherwise (see resolveRoot). The app navigates with the URL hash (#app, #login, ...), which is honoured too.
 */
export type AppRoute = 'root' | 'login' | 'app' | 'admin' | 'accept-invite';

export interface UrlParts {
  pathname: string;
  hash: string;
  search: string;
}

export function routeFromUrl({ pathname, hash, search }: UrlParts): AppRoute {
  const path = pathname.toLowerCase();
  const h = hash.toLowerCase();
  const q = search.toLowerCase();

  if (path === '/admin' || h.startsWith('#admin') || q.includes('view=admin')) return 'admin';
  if (path === '/accept-invite' || path === '/invite' || h.startsWith('#accept-invite') || h.startsWith('#invite') || q.includes('view=accept-invite')) {
    return 'accept-invite';
  }
  if (path === '/login' || h.startsWith('#login') || q.includes('view=login')) return 'login';
  if (path === '/app' || path === '/dashboard' || h.startsWith('#app') || q.includes('view=app')) return 'app';
  return 'root';
}

/** Where '/' and every unknown path end up. */
export const resolveRoot = (isAuthenticated: boolean): Exclude<AppRoute, 'root'> => (isAuthenticated ? 'app' : 'login');
