/**
 * Date text shown on screens that deal with UTC calendar dates and instants (access end dates, release notes, announcements).
 * Pure: nothing here reads the clock.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-12-31' -> '31 Dec 2026'. A value that is not a real Y-M-D date comes back unchanged. */
export function formatUtcDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return ymd;
  return `${d} ${MONTHS[mo - 1]} ${y}`;
}

/** '2026-11-20T14:05:00.000Z' -> '20 Nov 2026, 14:05 UTC'. An unparsable value comes back unchanged. */
export function formatUtcDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const t = new Date(ms);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** An instant in the viewer's own time zone; `fmt` is injectable so tests do not depend on the machine's locale. */
export function formatLocalDateTime(
  ms: number,
  fmt: (d: Date) => string = (d) => d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
): string {
  return fmt(new Date(ms));
}
