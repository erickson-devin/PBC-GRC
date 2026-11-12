/** One RFC 4180 cell: quoted, quotes doubled; TEXT a spreadsheet could read as a formula (= + - @ tab CR) gets a leading apostrophe. Numbers are written as-is. */
export function csvCell(val: string | number | null | undefined): string {
  if (val === undefined || val === null) return '""';
  let text = String(val);
  if (typeof val === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
