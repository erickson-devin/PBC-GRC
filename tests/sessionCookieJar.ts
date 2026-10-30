/** Test helper (not a suite): reads the pbc_session cookie a response sets, the way a browser's cookie jar would. */
const NAME = 'pbc_session';

/** The whole pbc_session Set-Cookie line of a response, or undefined. */
export function rawSetCookie(headers: Headers): string | undefined {
  return headers.getSetCookie().find((line) => line.startsWith(`${NAME}=`));
}

/** The decoded value of the pbc_session cookie a response sets, or undefined when there is none or it is empty (a cleared cookie). */
export function sessionCookieFrom(headers: Headers): string | undefined {
  const line = rawSetCookie(headers);
  if (!line) return undefined;
  const raw = line.slice(NAME.length + 1).split(';')[0];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw) || undefined;
  } catch {
    return undefined;
  }
}
