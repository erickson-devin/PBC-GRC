/**
 * Test stand-in for the browser's cookie jar. The real session is an HttpOnly `pbc_session` cookie the browser attaches itself;
 * the browser client only sends the `X-PBC-Session` marker. In these suites the session reference IS the JWT, so the bridge copies
 * the marker's value into a `Cookie: pbc_session=<ref>` header on the way out (unless the request already has a Cookie header).
 */
let installed = false;

export function installSessionCookieBridge(): void {
  if (installed) return;
  installed = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
    const ref = headers.get('X-PBC-Session');
    if (ref && !headers.has('Cookie')) {
      headers.set('Cookie', `pbc_session=${ref}`);
      return realFetch(input as RequestInfo, { ...init, headers });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}
