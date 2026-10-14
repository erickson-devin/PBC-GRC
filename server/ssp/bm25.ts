/**
 * BM25, a standard keyword ranking: no model, no embeddings, no extra download. Shared by the retrieval of the CMMC catalogs
 * (retrieval.ts) and of the much larger NIST SP 800-53 catalog (retrieval53.ts).
 */
const STOPWORDS = new Set(
  'the and for are was were that this with from have has had not but all any can will shall may must should would could into onto upon such than then them they their there these those its our out who whom whose which what when where while how also been being both each other more most some only own same very just over under between through during before after above below again further once here about against because does did doing done get got per via use used using'.split(' ')
);

export const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [])
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)); // crude plural folding

export interface IndexedControl {
  id: string;
  title: string;
  /** What the control requires, in plain words (shown to the model). */
  requirement: string;
  tf: Map<string, number>;
  length: number;
}
export interface Index {
  controls: IndexedControl[];
  idf: Map<string, number>;
  avgLength: number;
}

const K1 = 1.5;
const B = 0.75;

export interface Document {
  id: string;
  title: string;
  requirement: string;
  /** The text that is indexed. */
  text: string;
}

export function buildIndexFrom(docs: Document[]): Index {
  const controls: IndexedControl[] = docs.map((d) => {
    const tokens = tokenize(d.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { id: d.id, title: d.title, requirement: d.requirement, tf, length: tokens.length };
  });
  const df = new Map<string, number>();
  for (const c of controls) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = controls.length;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
  return { controls, idf, avgLength: controls.reduce((s, c) => s + c.length, 0) / Math.max(1, n) };
}

export const QUERY_CHARS = 4000;

/** Score of every document of the index against `text`, highest first. */
export function scoreIndex(idx: Index, text: string): Array<{ id: string; score: number }> {
  const query = new Set(tokenize(text.slice(0, QUERY_CHARS)));
  return idx.controls
    .map((c) => {
      let score = 0;
      for (const term of query) {
        const f = c.tf.get(term);
        if (!f) continue;
        score += (idx.idf.get(term) ?? 0) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * c.length) / idx.avgLength)));
      }
      return { id: c.id, score };
    })
    .sort((a, b) => b.score - a.score);
}
