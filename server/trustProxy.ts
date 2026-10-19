/**
 * Parses the TRUST_PROXY environment variable for `app.set('trust proxy', value)`.
 *
 * Express honours X-Forwarded-* headers (client address, protocol) only from the addresses named here. A boolean or a hop
 * count would let a client that reaches the app port directly forge those headers, so both are refused: name the proxy.
 * Accepts an IP, a CIDR, a comma-separated list of them, or a proxy-addr subnet name such as `loopback`. Express / proxy-addr
 * validates the entries themselves.
 */
export function parseTrustProxy(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  if (/^(true|false)$/i.test(value) || /^\d+$/.test(value)) {
    throw new Error('TRUST_PROXY must be the proxy address (IP, CIDR or comma-separated list), not a boolean or hop count');
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean).join(',');
}
