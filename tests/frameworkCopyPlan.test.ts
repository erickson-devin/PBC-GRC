import { createHash } from 'node:crypto';
import mappingJson from '../src/data/frameworks/nist171r3/r2r3.generated.json';
import catalogJson from '../src/data/frameworks/nist171r3/catalog.generated.json';
import type { GeneratedR2R3File, GeneratedR3CatalogFile } from '../src/data/frameworks/nist171r3/types';
import {
  COPY_MAX_EVIDENCE_BYTES, COPY_MAX_EVIDENCE_FILES, MARKER_KIND_RE, MARKER_SOURCE_KEY_RE, appendCopiedBlock, buildR3Suggestions, copyBlock,
  copyableText, markerKey, normalizeCopyInclude, planDigestInput, planFrameworkCopy, rev2NumberOf, suggestR3Status,
} from '../src/data/frameworkCopy/plan';
import type { FrameworkCopyPlanInput, PlanSourceControl } from '../src/data/frameworkCopy/plan';
import { CMMC_LEVEL_2_CONTROLS } from '../src/data/frameworks/cmmcLevel2Controls';
import { CMMC_LEVEL_1_CONTROLS } from '../src/data/cmmcLevel1Controls';

/**
 * "Copy from Rev. 2" (#255): the pure planner (src/data/frameworkCopy/plan.ts) against small hand-made rows and against the committed
 * Rev. 2 -> Rev. 3 mapping. Pure: does not boot the server. Counts that come from the mapping are computed, never written down.
 */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const mappingFile = mappingJson as unknown as GeneratedR2R3File;
const catalog = catalogJson as unknown as GeneratedR3CatalogFile;
const r3Ids = new Set(catalog.requirements.map((r) => r.id));
const mapping = mappingFile.requirements;

function ctrl(notes: string, status = 'NOT_STARTED', updatedAt: string | null = '2026-01-01T00:00:00.000Z'): PlanSourceControl {
  return { notes, status, updatedAt };
}
function input(over: Partial<FrameworkCopyPlanInput> & { controls?: Record<string, PlanSourceControl> } = {}): FrameworkCopyPlanInput {
  const { controls, ...rest } = over;
  return {
    mapping, newInR3: mappingFile.newInR3, targetCatalog: r3Ids,
    source: { controls: new Map(Object.entries(controls ?? {})), objectives: [], evidence: [], toolLinks: [], documentLinks: [] },
    markers: new Set<string>(),
    ...rest,
  };
}

// ---- notes
const p1 = planFrameworkCopy(input({ controls: { 'AC.L2-3.1.1': ctrl('A') } }));
assert(p1.items.length === 1 && p1.items[0].targetControlId === '03.01.01' && p1.items[0].notes.count === 1 && p1.items[0].notes.chars === 1, 'P1 notes "A" -> one NOTES item for 03.01.01', p1.items);
assert(p1.items[0].ops.length === 1 && p1.items[0].ops[0].kind === 'NOTES' && p1.items[0].ops[0].sourceKey === 'AC.L2-3.1.1' && p1.items[0].sources[0].controlId === 'AC.L2-3.1.1', 'P2 the op names the source control id');
const blk = copyBlock({ kind: 'NOTES', sourceId: 'AC.L2-3.1.1', programName: 'My "CMMC" program', date: '2026-11-20', text: 'A' });
assert(blk === '[Copied from NIST SP 800-171 Rev. 2 AC.L2-3.1.1 (program "My \'CMMC\' program") on 2026-11-20; review against Rev. 3]\nA', 'P3 the copy header line and text', blk);
assert(copyBlock({ kind: 'NOTES', sourceId: 'AC.L2-3.1.1', programName: 'P\nQ', date: '2026-11-20', text: 't' }).split('\n').length === 2, 'P3a a newline in the program name does not add a line');
assert(copyBlock({ kind: 'OBJECTIVE', sourceId: 'AC.L2-3.1.1[a]', programName: 'x', date: '2026-11-20', text: 'n' }) === '[Rev. 2 objective AC.L2-3.1.1[a]]\nn', 'P4 an objective block starts with [Rev. 2 objective <id>]');

const p2 = planFrameworkCopy(input({ controls: { 'AC.L2-3.1.1': ctrl('A') }, markers: new Set([markerKey('NOTES', '03.01.01', 'AC.L2-3.1.1')]) }));
assert(p2.items.length === 0 && p2.totals.alreadyCopied === 1 && p2.copiedKeys.length === 1, 'P5 with the marker present: 0 items, alreadyCopied 1', p2.totals);
assert(planFrameworkCopy(input({ controls: { 'AC.L2-3.1.1': ctrl('') } })).items.length === 0, 'P6 empty source notes: 0 items, no marker');
assert(planFrameworkCopy(input({ controls: { 'AC.L2-3.1.1': ctrl('  \n\t ') } })).items.length === 0, 'P6a whitespace-only notes: 0 items');
const strip = (t: string) => t.replace(/<!--VM-->[\s\S]*?<!--\/VM-->/g, '');
assert(planFrameworkCopy(input({ controls: { 'AC.L2-3.1.1': ctrl('<!--VM-->snapshot<!--/VM-->') }, stripNotes: strip })).items.length === 0, 'P7 notes that are only a machine block (after stripNotes): 0 items');
const p3 = planFrameworkCopy(input({ controls: { 'AC.L2-3.1.1': ctrl('keep<!--VM-->snapshot<!--/VM-->') }, stripNotes: strip }));
assert(p3.items[0]?.notes.chars === 4 && copyableText('keep<!--VM-->s<!--/VM-->', strip) === 'keep', 'P7a the stripped text is what is measured');
assert(planFrameworkCopy(input({ controls: { 'AC.L2-3.1.1': ctrl('A') }, include: { notes: false } })).items.length === 0, 'P8 include.notes false: no notes op');
assert(planFrameworkCopy(input({ controls: { 'AC.L1-3.1.1': ctrl('A') } })).items[0]?.targetControlId === '03.01.01', 'P9 a Level 1 id ("AC.L1-3.1.1") maps like a Level 2 id');
assert(rev2NumberOf('AC.L2-3.1.1') === '3.1.1' && rev2NumberOf('AC.L1-3.1.1') === '3.1.1' && rev2NumberOf('3.13.8') === '3.13.8' && rev2NumberOf('AC-2') === null && rev2NumberOf('03.01.01') === null, 'P10 rev2NumberOf');

// ---- changed since copy
const chg = planFrameworkCopy(input({ controls: { 'AC.L2-3.1.1': { ...ctrl('A'), notesSha256: sha('B') } }, markers: new Map([[markerKey('NOTES', '03.01.01', 'AC.L2-3.1.1'), sha('A')]]) }));
assert(chg.items.length === 0 && chg.totals.changedSinceCopy === 1 && chg.changedKeys.length === 1, 'P11 a source text that changed after it was copied is listed, not re-copied', chg.totals);
const unchg = planFrameworkCopy(input({ controls: { 'AC.L2-3.1.1': { ...ctrl('A'), notesSha256: sha('A') } }, markers: new Map([[markerKey('NOTES', '03.01.01', 'AC.L2-3.1.1'), sha('A')]]) }));
assert(unchg.totals.changedSinceCopy === 0 && unchg.totals.alreadyCopied === 1, 'P12 an unchanged copied source is not "changed"');

// ---- mapping: merged, not carried, skipped, new
const r2WithTargets = (pred: (e: GeneratedR2R3File['requirements'][string]) => boolean) => Object.entries(mapping).find(([, e]) => pred(e));
const merged = r2WithTargets((e) => e.withdrawn === true && e.targets.length > 0);
const idOf = (r2: string) => CMMC_LEVEL_2_CONTROLS.find((c) => rev2NumberOf(c.id) === r2)!.id;
assert(merged !== undefined, 'M0 the mapping has a withdrawn requirement that is merged into another');
if (merged) {
  const [r2, e] = merged;
  const pm = planFrameworkCopy(input({ controls: { [idOf(r2)]: ctrl('X') } }));
  assert(same(pm.items.map((i) => [i.targetControlId, i.sources[0].relation]), e.targets.map((t) => [t.id, t.relation]).sort((a, b) => (a[0] < b[0] ? -1 : 1))), 'M1 a merged requirement lands on its Rev. 3 target(s) with the mapping relation', pm.items);
  assert(pm.mergedInto.length === 1 && pm.mergedInto[0].r2 === r2 && same(pm.mergedInto[0].targets, e.targets.map((t) => t.id).sort()), 'M2 it is listed in mergedInto');
}
const r313 = mapping['3.1.13'];
const p313 = planFrameworkCopy(input({ controls: { [idOf('3.1.13')]: ctrl('X') } }));
assert(p313.items.length === 1 && p313.items[0].targetControlId === r313.targets[0].id && p313.items[0].sources[0].relation === r313.targets[0].relation && r313.targets[0].relation !== 'SAME', 'M3 3.1.13 lands on its mapped target with a non-SAME relation', p313.items);

const nc = r2WithTargets((e) => e.withdrawn === true && e.targets.length === 0)!;
const pnc = planFrameworkCopy(input({ controls: { [idOf(nc[0])]: ctrl('X') } }));
assert(pnc.items.length === 0 && same(pnc.notCarried, [{ r2: nc[0], cmmcId: idOf(nc[0]) }]) && pnc.mergedInto.length === 0, 'M4 a withdrawn requirement without a successor is "not carried" and copies nothing', pnc);

const targeted = new Set(Object.values(mapping).flatMap((e) => e.targets.map((t) => t.id)));
assert(same(p1.newInR3, [...r3Ids].filter((id) => !targeted.has(id)).sort()) && p1.newInR3.length > 0, 'M5 newInR3 equals the Rev. 3 ids minus the mapping targets', p1.newInR3);
const smallCatalog = new Set([...r3Ids].filter((id) => id !== '03.01.01'));
const psk = planFrameworkCopy(input({ controls: { 'AC.L2-3.1.1': ctrl('A') }, targetCatalog: smallCatalog }));
assert(psk.items.length === 0 && same(psk.skippedTargets, [{ controlId: 'AC.L2-3.1.1', targetId: '03.01.01' }]), 'M6 a target outside the catalog is skipped and reported', psk);
assert(planFrameworkCopy(input({ controls: { 'XX.L2-9.9.9': ctrl('A') } })).items.length === 0, 'M7 a control that is not a Rev. 2 requirement is ignored');

// ---- objectives, evidence, tools, documents
const rich = planFrameworkCopy(input({
  controls: { 'AC.L2-3.1.1': ctrl('') },
  source: {
    controls: new Map([['AC.L2-3.1.1', ctrl('')]]),
    objectives: [
      { objectiveId: 'AC.L2-3.1.1[a]', controlId: 'AC.L2-3.1.1', narrative: 'abc' },
      { objectiveId: 'AC.L2-3.1.1[b]', controlId: 'AC.L2-3.1.1', narrative: ' ' },
    ],
    evidence: [
      { id: 'e1', controlId: 'AC.L2-3.1.1', sizeBytes: 10, fileHash: sha('1'), copyable: true },
      { id: 'e2', controlId: 'AC.L2-3.1.1', sizeBytes: 99, copyable: false },
      { id: 'e3', controlId: 'AC.L2-3.1.1', sizeBytes: 5, copyable: true, available: false },
    ],
    toolLinks: [{ toolId: 't1', controlId: 'AC.L2-3.1.1' }],
    documentLinks: [{ documentId: 'd1', controlId: 'AC.L2-3.1.1' }],
  },
}));
const it0 = rich.items[0];
assert(rich.items.length === 1 && it0.objectives.count === 1 && it0.objectives.chars === 3 && it0.evidence.count === 1 && it0.evidence.bytes === 10 && it0.evidence.unavailable === 1 && it0.tools === 1 && it0.documents === 1 && it0.notes.count === 0, 'O1 objectives, evidence (unavailable counted, non-copyable ignored), tools and documents', it0);
assert(same(it0.ops.map((o) => o.kind), ['OBJECTIVE', 'EVIDENCE', 'TOOL', 'DOCUMENT']), 'O2 ops come in a fixed kind order', it0.ops.map((o) => o.kind));
assert(rich.totals.evidenceFiles === 1 && rich.totals.evidenceBytes === 10 && rich.totals.evidenceUnavailable === 1 && rich.totals.tooLarge === false, 'O3 totals');
const allOps = rich.items.flatMap((i) => i.ops);
assert(allOps.every((o) => MARKER_KIND_RE.test(o.kind) && MARKER_SOURCE_KEY_RE.test(o.sourceKey)), 'O4 every marker kind and key matches the database patterns');
assert(MARKER_SOURCE_KEY_RE.test('AC.L2-3.1.1[a]') && !MARKER_SOURCE_KEY_RE.test('a b') && !MARKER_SOURCE_KEY_RE.test('') && !MARKER_KIND_RE.test('notes'), 'O5 the patterns accept brackets and refuse spaces, empty and lower case');
assert(planFrameworkCopy(input({ source: { controls: new Map(), objectives: [], evidence: [], toolLinks: [{ toolId: 't1', controlId: 'AC.L2-3.1.1' }], documentLinks: [] }, include: { tools: false } })).items.length === 0, 'O6 include.tools false: no tool op');
assert(planFrameworkCopy(input({ source: { controls: new Map(), objectives: [], evidence: [], toolLinks: [], documentLinks: [{ documentId: 'd1', controlId: 'AC.L2-3.1.1' }] }, include: { documents: false } })).items.length === 0, 'O7 include.documents false: no document op');
assert(same(normalizeCopyInclude(undefined), { notes: true, objectives: true, evidence: true, tools: true, documents: true }) && normalizeCopyInclude({ evidence: false }).evidence === false && normalizeCopyInclude({ evidence: false }).notes === true, 'O8 normalizeCopyInclude defaults every flag to true');
// the same tool linked from two Rev. 2 controls that merge into one Rev. 3 control: one op
const twoIn = Object.entries(mapping).filter(([, e]) => e.targets.length === 1).reduce<Record<string, string[]>>((acc, [r2, e]) => { (acc[e.targets[0].id] ??= []).push(r2); return acc; }, {});
const mergePair = Object.entries(twoIn).find(([, list]) => list.length >= 2 && list.every((r2) => CMMC_LEVEL_2_CONTROLS.some((c) => rev2NumberOf(c.id) === r2)));
if (mergePair) {
  const [tgt, list] = mergePair;
  const links = list.map((r2) => ({ toolId: 'tool-x', controlId: idOf(r2) }));
  const pd = planFrameworkCopy(input({ source: { controls: new Map(), objectives: [], evidence: [], toolLinks: links, documentLinks: [] } }));
  const item = pd.items.find((i) => i.targetControlId === tgt);
  assert(item?.tools === 1 && item.ops.length === 1, 'O9 one tool reaching a Rev. 3 control from several Rev. 2 controls is one op', item);
} else {
  assert(true, 'O9 (no two single-target Rev. 2 requirements share a Rev. 3 target: nothing to check)');
}
const bigFiles = planFrameworkCopy(input({ source: { controls: new Map(), objectives: [], evidence: Array.from({ length: COPY_MAX_EVIDENCE_FILES + 1 }, (_, i) => ({ id: `e${i}`, controlId: 'AC.L2-3.1.1', sizeBytes: 1, copyable: true })), toolLinks: [], documentLinks: [] } }));
const bigBytes = planFrameworkCopy(input({ source: { controls: new Map(), objectives: [], evidence: [{ id: 'e', controlId: 'AC.L2-3.1.1', sizeBytes: COPY_MAX_EVIDENCE_BYTES + 1, copyable: true }], toolLinks: [], documentLinks: [] } }));
const okFiles = planFrameworkCopy(input({ source: { controls: new Map(), objectives: [], evidence: Array.from({ length: COPY_MAX_EVIDENCE_FILES }, (_, i) => ({ id: `e${i}`, controlId: 'AC.L2-3.1.1', sizeBytes: 1, copyable: true })), toolLinks: [], documentLinks: [] } }));
assert(COPY_MAX_EVIDENCE_FILES === 200 && COPY_MAX_EVIDENCE_BYTES === 1024 ** 3 && bigFiles.totals.tooLarge && bigBytes.totals.tooLarge && !okFiles.totals.tooLarge, 'O10 tooLarge above 200 files or 1 GiB, not at the limit');

// ---- append
const b = 'BLOCK';
assert(appendCopiedBlock('X', b) === 'X\n\n' + b && appendCopiedBlock('', b) === b && appendCopiedBlock('X', b).startsWith('X'), 'A1 appendCopiedBlock: existing + blank line + block; block alone when empty; existing text kept as the prefix');
const twice = appendCopiedBlock(appendCopiedBlock('keep', 'b1'), 'b2');
assert(twice === 'keep\n\nb1\n\nb2' && twice.startsWith('keep'), 'A2 several blocks append in order');

// ---- suggestions
const S = (status: string, relation = 'SAME', changeType?: string, newOdp?: boolean) => ({ status, relation, changeType, newOdp });
assert(suggestR3Status([]) === null, 'S1 no sources -> null');
assert(same(suggestR3Status([S('MET', 'SAME', 'NO_SIGNIFICANT_CHANGE'), S('NOT_MET', 'SAME', 'NO_SIGNIFICANT_CHANGE')]), { suggested: 'NOT_MET', reasonCode: 'any_not_met' }), 'S2 [MET, NOT_MET] -> NOT_MET / any_not_met');
assert(same(suggestR3Status([S('MET'), S('MET')]), { suggested: 'IN_PROGRESS', reasonCode: 'all_met_changed' }), 'S3 [MET, MET] without a change type -> IN_PROGRESS / all_met_changed');
assert(same(suggestR3Status([S('MET', 'SAME', 'NO_SIGNIFICANT_CHANGE'), S('MET', 'SAME', 'MINOR_CHANGE')]), { suggested: 'MET', reasonCode: 'all_met_unchanged' }), 'S4 [MET, MET] all SAME and non-significant -> MET / all_met_unchanged');
assert(suggestR3Status([S('MET', 'SAME', 'SIGNIFICANT_CHANGE')])?.suggested === 'IN_PROGRESS', 'S5 a significant change -> IN_PROGRESS');
assert(suggestR3Status([S('MET', 'SAME', 'NO_SIGNIFICANT_CHANGE', true)])?.reasonCode === 'all_met_changed', 'S6 a new ODP -> not unchanged');
assert(suggestR3Status([S('MET', 'INCORPORATED_INTO', 'NO_SIGNIFICANT_CHANGE')])?.suggested === 'IN_PROGRESS' && suggestR3Status([S('MET', 'ADDRESSED_BY', 'MINOR_CHANGE')])?.suggested === 'IN_PROGRESS', 'S7 a merged relation is never MET');
assert(same(suggestR3Status([S('MET', 'SAME', 'NO_SIGNIFICANT_CHANGE'), S('IN_PROGRESS')]), { suggested: 'IN_PROGRESS', reasonCode: 'partial' }) && suggestR3Status([S('IN_PROGRESS')])?.reasonCode === 'partial', 'S8 any MET or IN_PROGRESS -> IN_PROGRESS / partial');
assert(same(suggestR3Status([S('MET', 'SAME', 'NO_SIGNIFICANT_CHANGE'), S('NOT_STARTED')]), { suggested: 'IN_PROGRESS', reasonCode: 'partial' }), 'S9 a NOT_STARTED source stops "all MET"');
assert(suggestR3Status([S('NOT_STARTED')]) === null && suggestR3Status([S('NOT_APPLICABLE')]) === null && suggestR3Status([S('NOT_STARTED'), S('NOT_APPLICABLE')]) === null, 'S10 statuses outside MET / IN_PROGRESS / NOT_MET contribute nothing');
assert(same(suggestR3Status([S('NOT_APPLICABLE'), S('NOT_MET')]), { suggested: 'NOT_MET', reasonCode: 'any_not_met' }), 'S11 NOT_APPLICABLE next to NOT_MET changes nothing');

const sugg = buildR3Suggestions({ mapping, targetCatalog: r3Ids, sourceStatuses: new Map([['AC.L2-3.1.1', 'MET'], ['AC.L2-3.1.2', 'NOT_STARTED']]) });
const s1 = sugg.find((s) => s.controlId === '03.01.01');
const s2 = sugg.find((s) => s.controlId === '03.01.02');
assert(s1 !== undefined && s1.sources.length === 1 && s1.sources[0].status === 'MET' && s1.sources[0].relation === 'SAME' && s1.sources[0].changeType === mapping['3.1.1'].changeType, 'S12 an entry carries its sources with status, relation and change type', s1);
assert(s2 !== undefined && s2.suggested === null && s2.reasonCode === null, 'S13 a control whose sources give no suggestion still has an entry with null', s2);
assert(sugg.every((s, i) => i === 0 || sugg[i - 1].controlId < s.controlId), 'S14 entries are sorted by control id');
const allL2 = new Map(CMMC_LEVEL_2_CONTROLS.map((c) => [c.id, 'MET']));
const suggAll = buildR3Suggestions({ mapping, targetCatalog: r3Ids, sourceStatuses: allL2 });
assert(same(suggAll.map((s) => s.controlId), [...targeted].filter((id) => r3Ids.has(id)).sort()), 'S15 one entry for every Rev. 3 control that has Rev. 2 sources');

// ---- digest
const dIn = input({
  controls: { 'AC.L2-3.1.1': ctrl('A', 'MET', 'T1'), 'AC.L2-3.1.2': ctrl('B', 'MET', 'T2'), 'AU.L2-3.3.1': ctrl('C', 'MET', 'T3') },
  source: {
    controls: new Map([['AC.L2-3.1.1', ctrl('A', 'MET', 'T1')], ['AC.L2-3.1.2', ctrl('B', 'MET', 'T2')], ['AU.L2-3.3.1', ctrl('C', 'MET', 'T3')]]),
    objectives: [], evidence: [{ id: 'e1', controlId: 'AC.L2-3.1.1', sizeBytes: 1, fileHash: sha('f'), copyable: true }], toolLinks: [], documentLinks: [],
  },
});
const base = planFrameworkCopy(dIn);
const reversed = { ...base, items: [...base.items].reverse().map((i) => ({ ...i, ops: [...i.ops].reverse() })), notCarried: [...base.notCarried].reverse() };
assert(base.items.length >= 3 && planDigestInput(base) === planDigestInput(reversed), 'G1 the digest input does not depend on the order of the items');
assert(sha(planDigestInput(base)) === sha(planDigestInput(planFrameworkCopy(dIn))) && /^[0-9a-f]{64}$/.test(sha(planDigestInput(base))), 'G2 the digest is stable and a SHA-256 hex');
const bumped = new Map(dIn.source.controls);
bumped.set('AC.L2-3.1.1', ctrl('A', 'MET', 'T1-later'));
assert(planDigestInput(planFrameworkCopy({ ...dIn, source: { ...dIn.source, controls: bumped } })) !== planDigestInput(base), 'G3 a source updatedAt change changes the digest');
const ev2 = { ...dIn, source: { ...dIn.source, evidence: [{ id: 'e1', controlId: 'AC.L2-3.1.1', sizeBytes: 1, fileHash: sha('g'), copyable: true }] } };
assert(planDigestInput(planFrameworkCopy(ev2)) !== planDigestInput(base), 'G4 an evidence hash change changes the digest');
assert(planDigestInput(planFrameworkCopy({ ...dIn, markers: new Set([markerKey('NOTES', '03.01.02', 'AC.L2-3.1.2')]) })) !== planDigestInput(base), 'G5 an existing marker changes the digest');
assert(planDigestInput(planFrameworkCopy({ ...dIn, source: { ...dIn.source, evidence: [{ id: 'e1', controlId: 'AC.L2-3.1.1', sizeBytes: 1, fileHash: sha('f'), copyable: true, available: false }] } })) !== planDigestInput(base), 'G6 an evidence file turning unavailable changes the digest');
const digestText = planDigestInput(base);
assert(!digestText.includes('"A"') && !/\nA\n/.test(digestText), 'G7 the digest input holds no source text');

// ---- the committed mapping end to end
const allControls = Object.fromEntries(CMMC_LEVEL_2_CONTROLS.map((c) => [c.id, ctrl(`note ${c.id}`, 'MET')]));
const real = planFrameworkCopy(input({ controls: allControls }));
assert(real.items.length > 0 && real.items.every((i) => r3Ids.has(i.targetControlId)), 'R1 every target id of a real plan is a Rev. 3 requirement id of the catalog');
assert(real.items.every((i) => i.ops.every((o) => r3Ids.has(o.targetControlId))), 'R2 so is every op target');
assert(real.skippedTargets.length === 0, 'R3 no mapping target is missing from the catalog', real.skippedTargets);
const wws = Object.keys(mappingFile.withdrawnWithoutSuccessor).sort();
assert(same(real.notCarried.map((n) => n.r2).sort(), wws) && real.notCarried.every((n) => n.cmmcId === idOf(n.r2)), 'R4 notCarried equals withdrawnWithoutSuccessor mapped to source ids', real.notCarried);
assert(real.mergedInto.length === Object.values(mapping).filter((e) => e.withdrawn && e.targets.length > 0).length, 'R5 mergedInto counts every withdrawn requirement with a successor');
assert(real.notCarried.length + real.mergedInto.length + Object.values(mapping).filter((e) => !e.withdrawn).length === CMMC_LEVEL_2_CONTROLS.length, 'R6 every Level 2 control is carried, merged or not carried');
assert(same(real.items.map((i) => i.targetControlId), [...targeted].sort()), 'R7 a plan over all Level 2 notes touches exactly the mapping targets');
assert(real.items.every((i) => i.sources.length > 0 && i.sources.every((s) => s.relation === mapping[rev2NumberOf(s.controlId)!].targets.find((t) => t.id === i.targetControlId)?.relation)), 'R8 each source ref carries the mapping relation');
const l1 = planFrameworkCopy(input({ controls: Object.fromEntries(CMMC_LEVEL_1_CONTROLS.map((c) => [c.id, ctrl('x')])) }));
assert(l1.items.length > 0 && l1.items.length <= CMMC_LEVEL_1_CONTROLS.length && l1.items.every((i) => r3Ids.has(i.targetControlId)), 'R9 a Level 1 program plans onto Rev. 3 ids too');
const keys = real.items.flatMap((i) => i.ops.map((o) => markerKey(o.kind, o.targetControlId, o.sourceKey)));
assert(new Set(keys).size === keys.length, 'R10 marker keys are unique across the plan');
const again = planFrameworkCopy(input({ controls: allControls, markers: new Set(keys) }));
assert(again.items.length === 0 && again.totals.alreadyCopied === keys.length, 'R11 with every marker present the plan is empty (a re-run copies nothing)', again.totals);

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
