/**
 * A small, pure Markdown reader for the policy and SSP previews. It understands only what the generators emit (headings,
 * paragraphs, bullet and numbered lists, tables, quotes with GitHub callouts, fenced code, rules, and inline bold / italic /
 * code) and never produces HTML: the preview turns these blocks into React elements, so raw HTML in the text stays text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string };

export type Callout = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: 'paragraph'; lines: Inline[][] }
  | { t: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { t: 'table'; head: Inline[][] | null; rows: Inline[][][] }
  | { t: 'quote'; callout: Callout | null; lines: Inline[][] }
  | { t: 'code'; text: string }
  | { t: 'hr' };

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/** Inline Markdown: `code`, **strong**, *em*. Underscores never emphasise; unmatched delimiters stay literal. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush();
        out.push({ t: 'code', v: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    } else if (ch === '*' && s[i + 1] === '*') {
      if (!isSpace(s[i + 2])) {
        let j = s.indexOf('**', i + 2);
        while (j !== -1 && isSpace(s[j - 1])) j = s.indexOf('**', j + 1);
        if (j !== -1) {
          flush();
          out.push({ t: 'strong', c: parseInline(s.slice(i + 2, j)) });
          i = j + 2;
          continue;
        }
      }
      buf += '**';
      i += 2;
      continue;
    } else if (ch === '*') {
      if (!isSpace(s[i + 1])) {
        let j = -1;
        for (let k = i + 1; k < s.length; k++) {
          if (s[k] === '*' && s[k - 1] !== '*' && s[k + 1] !== '*' && !isSpace(s[k - 1])) {
            j = k;
            break;
          }
        }
        if (j !== -1) {
          flush();
          out.push({ t: 'em', c: parseInline(s.slice(i + 1, j)) });
          i = j + 1;
          continue;
        }
      }
    } else if (ch === '[') {
      const m = /^\[([^\]]*)\]\(([^)]*)\)/.exec(s.slice(i));
      if (m) {
        buf += `${m[1]} (${m[2]})`;
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

const HEADING = /^(#{1,6})\s+(.+)$/;
const RULE = /^(-{3,}|\*{3,})\s*$/;
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const BULLET = /^[-*+]\s+/;
const NUMBERED = /^(\d+)[.)]\s+/;
const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

/** Splits one table row on unescaped pipes; the empty cells outside the outer pipes are dropped. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  const t = line.trim();
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (t[i] === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += t[i];
    }
  }
  cells.push(cur);
  const trimmed = cells.map((c) => c.trim());
  if (trimmed.length > 0 && trimmed[0] === '') trimmed.shift();
  if (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}

export function parseMarkdownBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];

  let para: string[] = [];
  let list = null as { ordered: boolean; start: number; items: string[] } | null;
  let quote: string[] = [];
  let table: string[] = [];
  let code = null as string[] | null;

  const closePara = () => {
    if (para.length > 0) blocks.push({ t: 'paragraph', lines: para.map(parseInline) });
    para = [];
  };
  const closeList = () => {
    if (list) blocks.push({ t: 'list', ordered: list.ordered, start: list.start, items: list.items.map(parseInline) });
    list = null;
  };
  const closeQuote = () => {
    if (quote.length > 0) {
      let callout: Callout | null = null;
      let body = quote;
      const m = CALLOUT.exec(quote[0].trim());
      if (m) {
        callout = m[1].toUpperCase() as Callout;
        body = quote.slice(1);
      }
      blocks.push({ t: 'quote', callout, lines: body.map(parseInline) });
    }
    quote = [];
  };
  const closeTable = () => {
    if (table.length > 0) {
      const hasHead = table.length > 1 && TABLE_SEPARATOR.test(table[1].trim());
      const rowLines = hasHead ? table.slice(2) : table;
      blocks.push({
        t: 'table',
        head: hasHead ? splitRow(table[0]).map(parseInline) : null,
        rows: rowLines.map((r) => splitRow(r).map(parseInline)),
      });
    }
    table = [];
  };
  const closeAll = () => {
    closePara();
    closeList();
    closeQuote();
    closeTable();
  };

  for (const line of lines) {
    if (code) {
      if (line.trim().startsWith('```')) {
        blocks.push({ t: 'code', text: code.join('\n') });
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      closeAll();
      code = [];
      continue;
    }
    if (line.trim() === '') {
      closeAll();
      continue;
    }
    // A list item continues on lines indented two or more spaces
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const text = line.trim();
    const heading = HEADING.exec(text);
    if (heading) {
      closeAll();
      blocks.push({ t: 'heading', level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInline(heading[2].trim()) });
      continue;
    }
    if (RULE.test(text)) {
      closeAll();
      blocks.push({ t: 'hr' });
      continue;
    }
    if (/^>\s?/.test(text)) {
      closePara();
      closeList();
      closeTable();
      quote.push(text.replace(/^>\s?/, ''));
      continue;
    }
    if (text.startsWith('|')) {
      closePara();
      closeList();
      closeQuote();
      table.push(text);
      continue;
    }
    const bullet = BULLET.exec(text);
    const numbered = bullet ? null : NUMBERED.exec(text);
    if (bullet || numbered) {
      closePara();
      closeQuote();
      closeTable();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) closeList();
      if (!list) list = { ordered, start: numbered ? parseInt(numbered[1], 10) : 1, items: [] };
      list.items.push(text.replace(bullet ? BULLET : NUMBERED, ''));
      continue;
    }
    closeList();
    closeQuote();
    closeTable();
    para.push(text);
  }
  if (code) blocks.push({ t: 'code', text: code.join('\n') });
  closeAll();
  return blocks;
}
