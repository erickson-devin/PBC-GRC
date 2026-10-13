import type { FakeChatRequest } from './fakeOllama';

/**
 * A scripted stand-in for the language model, shared by the SSP AI tests. It behaves like a competent model unless the
 * document contains a marker that makes it misbehave in one specific, realistic way:
 *   [[HALLUCINATE]] quotes text that is not in the document     [[PARAPHRASE]] "quotes" a paraphrase
 *   [[BADID]]       names a control that does not exist         [[NOTOFFERED]]  names a control it was not offered
 *   [[BADJSON]]     answers with prose                          [[SHAPE]]       answers with the wrong JSON shape
 *   [[GAPFAIL]]     (gap analysis) answers with prose           [[BADEVIDENCE]] (gap analysis, narrative) cites evidence that is not there
 *   [[OFFTOPIC]]    attaches a real sentence to an unrelated control   [[ALLSAME]]  (extractive gap) uses one sentence for every objective
 *   [[FABRICATE]]   (extractive gap) invents a sentence that is not in the document
 *   [[WEAK]]        (extractive gap) picks a real sentence that shares no words with objective a
 *   [[NEARMISS]]    (extractive gap) copies a sentence with a few words changed       [[FAILB]] (extractive gap) fails to answer objective b
 */
export const sentenceAfterHeading = (section: string): string => {
  const body = section.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
  return (body.match(/[^.!?]+[.!?]/)?.[0] ?? body).trim();
};
const grab = (user: string, from: string, to: string): string => user.slice(user.indexOf(from) + from.length, user.lastIndexOf(to)).trim();

export function scriptedModel(req: FakeChatRequest): unknown {
  if (req.system.startsWith('You read one section')) {
    const controls = [...req.user.matchAll(/^- ([A-Z]{2}\.L[12]-3\.\d+\.\d+):/gm)].map((m) => m[1]);
    const section = grab(req.user, '<<<\n', '\n>>>');
    const quote = sentenceAfterHeading(section);
    if (section.includes('[[BADJSON]]')) return { __raw: 'Sure, here you go' };
    if (section.includes('[[SHAPE]]')) return { findings: 'many' };
    if (section.includes('[[BADID]]')) return { findings: [{ controlId: 'ZZ.L9-9.9.9', implementation: 'Made up.', quote, coverage: 'FULL', confidence: 0.9 }] };
    if (section.includes('[[NOTOFFERED]]')) return { findings: [{ controlId: controls.includes('MP.L1-3.8.3') ? 'PE.L1-3.10.5' : 'MP.L1-3.8.3', implementation: 'Not asked about.', quote, coverage: 'FULL', confidence: 0.9 }] };
    const findings: unknown[] = [];
    // [[OFFTOPIC]]: a real sentence of the document attached to the least relevant of the controls it was offered
    if (section.includes('[[OFFTOPIC]]') && controls.length > 0) {
      return { findings: [{ controlId: controls[controls.length - 1], implementation: 'Looks related.', quote, coverage: 'FULL', confidence: 1 }] };
    }
    for (const id of controls) {
      const number = id.slice(id.lastIndexOf('-') + 1);
      const named = section.includes(id) || section.includes(number);
      const keyword = id === 'MP.L1-3.8.3' && /sanitized/.test(section);
      if (!named && !keyword) continue;
      if (section.includes('[[HALLUCINATE]]')) {
        findings.push({ controlId: id, implementation: 'Badge readers are audited.', quote: 'Every visitor is escorted and the escort signs the visitor log at the front desk', coverage: 'FULL', confidence: 0.95 });
      } else if (section.includes('[[PARAPHRASE]]')) {
        findings.push({ controlId: id, implementation: 'Paraphrased.', quote: 'Users may only reach systems after their manager signs off', coverage: 'FULL', confidence: 0.9 });
      } else {
        const q = keyword ? (section.match(/[^.]*sanitized[^.]*\./)?.[0] ?? quote).trim() : quote;
        findings.push({ controlId: id, implementation: `The plan says: ${q.slice(0, 90)}`, quote: q, coverage: 'FULL', confidence: 0.9 });
      }
    }
    return { findings };
  }
  // gap analysis, extractive (the small-model variant): one question per objective, answer with one sentence or NONE
  if (req.system.startsWith('You find one sentence')) {
    const letter = req.user.match(/^OBJECTIVE \[([a-z])\]/)?.[1] ?? 'a';
    const text = grab(req.user, 'EXCERPTS\n<<<\n', '\n>>>');
    if (text.includes('[[GAPFAIL]]')) return { __raw: 'no' };
    if (text.includes('[[FAILB]]') && letter === 'b') return { __raw: 'no' };
    const sentence = sentenceAfterHeading(text);
    if (text.includes('[[WEAK]]') && letter === 'a') return { sentence: 'Accounts are created by the IT lead after manager approval and reviewed every quarter by the security manager.' };
    if (text.includes('[[ALLSAME]]')) return { sentence };
    if (text.includes('[[FABRICATE]]')) return { sentence: letter === 'a' ? 'Every employee completes a security briefing before receiving any laptop' : 'NONE' };
    if (text.includes('[[NEARMISS]]') && letter === 'a') return { sentence: sentence.replace('limited', 'restricted').replace('authorized', 'approved') };
    // a competent model: the first objective is spoken to by the first sentence, the second repeats it, the rest are not covered
    return { sentence: letter === 'a' || letter === 'b' ? sentence : 'NONE' };
  }
  // gap analysis, narrative
  const letters = [...req.user.matchAll(/^\[([a-z])\] /gm)].map((m) => m[1]);
  const excerpts = grab(req.user, 'DOCUMENT EXCERPTS\n<<<\n', '\n>>>');
  if (excerpts.includes('[[GAPFAIL]]')) return { __raw: 'no' };
  const first = sentenceAfterHeading(excerpts);
  return {
    summary: 'The excerpts describe who may have access and how it is reviewed.',
    objectives: letters.map((l, i) => ({
      letter: l.toUpperCase(),
      status: i === 0 ? 'ADDRESSED' : i === 1 ? 'PARTIAL' : 'NOT_ADDRESSED',
      evidence: i === 0 ? first : i === 1 ? (excerpts.includes('[[BADEVIDENCE]]') ? 'The organisation maintains a perfect list of every authorised user at all times' : first) : '',
    })),
    gaps: [{ severity: 'HIGH', objective: letters[letters.length - 1] ?? '', missingElement: 'Device identification', recommendation: 'Say how devices are identified and authenticated.' }],
  };
}
