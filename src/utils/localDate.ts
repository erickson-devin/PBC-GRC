/** The local calendar date, YYYY-MM-DD (not the UTC date: late in the evening toISOString() is already tomorrow). */
export function localDateIso(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
