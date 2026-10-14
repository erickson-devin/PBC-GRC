import type { ControlParameter } from '../../types/framework';
import { parameterValue, setParameterValue } from './parameters';

/**
 * The statement of an SP 800-53 control is a list of lettered items (a., b., c. ...), each of which an SSP has to answer:
 *
 *     a. Define and document the types of accounts allowed and specifically prohibited for use within the system;
 *     b. Assign account managers;
 *     c. Require [Assignment: organization-defined prerequisites and criteria] for group and role membership;
 *
 * The SSP editor shows one field per item. Nothing new is stored: the answers live in the control's ordinary implementation
 * narrative, in a block per item that starts with a line "Statement a:". Text before the first block is the overview, which
 * belongs to no item. Everything that reads the narrative (exports, search, the assessor) still sees one piece of text, and
 * "Parameter: label = value" lines stay wherever they are.
 */

export interface StatementItem {
  /** "a", "b", ... */
  label: string;
  /** The item as written, with its nested lines (indentation kept) and its [Assignment: ...] / [Selection: ...] tags. */
  text: string;
  /** Where the item lies in the statement; parameter positions (ControlParameter.start / end) are in the same coordinates. */
  start: number;
  end: number;
}

export interface ItemizedStatement {
  /** Lines before the first lettered item ("The organization:"), usually none. */
  intro: string;
  items: StatementItem[];
}

/** The lettered items of a statement, or null when it has fewer than two (then the control is answered as a whole). */
export function statementItems(statement: string | undefined): ItemizedStatement | null {
  if (!statement) return null;
  const starts: Array<{ label: string; start: number }> = [];
  let pos = 0;
  for (const line of statement.split('\n')) {
    const m = line.match(/^([a-z])\.\s+\S/); // a top-level item: no indentation
    if (m) starts.push({ label: m[1], start: pos });
    pos += line.length + 1;
  }
  if (starts.length < 2) return null;
  const items = starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].start : statement.length;
    return { label: s.label, start: s.start, end, text: statement.slice(s.start, end).replace(/\s+$/, '') };
  });
  return { intro: statement.slice(0, starts[0].start).trim(), items };
}

/** The statement parameters (tags in the control text) that lie inside an item. */
export const parametersOfItem = (item: StatementItem, params: readonly ControlParameter[]): ControlParameter[] =>
  params.filter((p) => p.source === 'STATEMENT' && p.start !== undefined && p.start >= item.start && p.start < item.end);

// ------------------------------------------------------------------------------------------------ the answers in the narrative

export interface ItemNotes {
  /** The overview: text that is not under any "Statement x:" line. */
  general: string;
  /** The answer for each item, by label. */
  items: Record<string, string>;
  /** Labels in the order they appear in the narrative. */
  order: string[];
}

const MARKER = /^Statement ([a-z]{1,2}):[ \t]*$/gim;
const BLOCK_GAP = '\n\n';

/** Splits a narrative into its overview and the answer to each statement item. Exact: serializeItemNotes gives the text back. */
export function parseItemNotes(notes: string): ItemNotes {
  const markers = [...notes.matchAll(MARKER)].map((m) => ({ label: m[1].toLowerCase(), start: m.index ?? 0, bodyStart: (m.index ?? 0) + m[0].length + 1 }));
  if (markers.length === 0) return { general: notes, items: {}, order: [] };
  const cut = (text: string, followed: boolean): string => (followed && text.endsWith(BLOCK_GAP) ? text.slice(0, -BLOCK_GAP.length) : text);
  const items: Record<string, string> = {};
  const order: string[] = [];
  markers.forEach((m, i) => {
    const next = markers[i + 1];
    const body = cut(notes.slice(Math.min(m.bodyStart, notes.length), next ? next.start : notes.length), Boolean(next));
    if (m.label in items) items[m.label] += BLOCK_GAP + body;
    else {
      items[m.label] = body;
      order.push(m.label);
    }
  });
  return { general: cut(notes.slice(0, markers[0].start), true), items, order };
}

/** Joins the overview and the answers into a narrative. Labels in `order` come first, in that order; any others follow. */
export function serializeItemNotes(parts: ItemNotes, order: readonly string[]): string {
  const labels = [...order, ...parts.order.filter((l) => !order.includes(l))];
  const blocks: string[] = [];
  if (parts.general !== '') blocks.push(parts.general);
  for (const l of labels) {
    const text = parts.items[l];
    if (text !== undefined && text !== '') blocks.push(`Statement ${l}:\n${text}`);
  }
  return blocks.join(BLOCK_GAP);
}

/** The narrative with the answer to one item replaced. */
export function setItemNote(notes: string, label: string, text: string, order: readonly string[]): string {
  const parsed = parseItemNotes(notes);
  return serializeItemNotes({ ...parsed, items: { ...parsed.items, [label]: text }, order: parsed.order.includes(label) ? parsed.order : [...parsed.order, label] }, order);
}

/** The narrative with the overview replaced. */
export function setOverviewNote(notes: string, text: string, order: readonly string[]): string {
  return serializeItemNotes({ ...parseItemNotes(notes), general: text }, order);
}

/**
 * Records a parameter value in the answer of the item that holds the parameter. A "Parameter:" line that already exists is
 * changed where it is (wherever the narrative keeps it); a new one goes at the end of the item's answer.
 */
export function setItemParameterValue(notes: string, label: string, param: ControlParameter, value: string, order: readonly string[]): string {
  const direct = setParameterValue(notes, param, value);
  const parsed = parseItemNotes(notes);
  // an existing line (or removing one) is handled in place; the end-of-narrative append of setParameterValue is not wanted here
  const existed = parameterValue(param, notes) !== undefined;
  if (existed || value.trim() === '') return direct;
  return setItemNote(notes, label, setParameterValue(parsed.items[label] ?? '', param, value), order);
}
