/**
 * Development-only mock ID tokens.
 *
 * The API server only honours `mock_pbc_signature` tokens when NODE_ENV !== 'production'.
 * `import.meta.env.DEV` is statically replaced by Vite, so in production bundles this
 * function collapses to `return null` and the forging code is removed entirely.
 */
export function buildDevMockIdToken(
  claims: Record<string, unknown>,
  ttlSeconds: number = 3600
): string | null {
  if (!import.meta.env.DEV) return null;
  const payload = {
    iss: 'https://securetoken.google.com/grc-tool-507203',
    ...claims,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  return `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${btoa(JSON.stringify(payload))}.mock_pbc_signature`;
}
