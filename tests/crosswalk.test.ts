import {
  CROSSWALK_PROVENANCE,
  cmmcIdsForRequirement,
  crosswalkFor171,
  crosswalkFor53,
  crosswalkRequirements,
  requirementNumberOf,
  withdrawnWithoutSuccessor,
} from '../src/data/frameworks/nist80053/crosswalk';
import {
  CANONICAL_CONTROL_MAPPINGS,
  CROSSWALK_MAPPINGS,
  HAND_CURATED_CONTROL_MAPPINGS,
  getCrossFrameworkMappings,
  getEquivalentControlIds,
} from '../src/data/frameworks/controlMappings';
import { NIST_800_53_CONTROLS } from '../src/data/frameworks/nist80053Controls';
import { CMMC_LEVEL_2_CONTROLS } from '../src/data/frameworks/cmmcLevel2Controls';
import { CMMC_LEVEL_1_CONTROLS } from '../src/data/cmmcLevel1Controls';
import { TABLES_SQL } from '../server/schema';

/** SP 800-171 Rev. 2 <-> SP 800-53 Rev. 5 crosswalk: lookups, mapping rows, and that SUBSET rows never feed evidence inheritance. */
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
const ids171 = (id: string) => crosswalkFor171(id).map((c) => c.control);

console.log('--- Requirement numbers ---');
assert(requirementNumberOf('AC.L2-3.1.5') === '3.1.5', 'AC.L2-3.1.5 -> 3.1.5');
assert(requirementNumberOf('AC.L1-3.1.22') === '3.1.22', 'AC.L1-3.1.22 -> 3.1.22');
assert(requirementNumberOf('3.13.11') === '3.13.11', 'a bare number is accepted');
assert(requirementNumberOf('AC-6(1)') === null && requirementNumberOf('CC6.1') === null, 'an SP 800-53 or SOC 2 id is not a requirement');

console.log('\n--- Appendix D facts ---');
const sameSet = (a: string[], b: string[]) => a.length === b.length && b.every((x) => a.includes(x));
assert(sameSet(ids171('AC.L1-3.1.1'), ['AC-2', 'AC-3', 'AC-17']), '3.1.1 -> AC-2, AC-3, AC-17', ids171('AC.L1-3.1.1'));
assert(sameSet(ids171('IA.L2-3.5.3'), ['IA-2(1)', 'IA-2(2)']), '3.5.3 -> IA-2(1), IA-2(2)', ids171('IA.L2-3.5.3'));
assert(sameSet(ids171('SC.L1-3.13.1'), ['SC-7', 'SA-8']), '3.13.1 -> SC-7, SA-8', ids171('SC.L1-3.13.1'));
assert(sameSet(ids171('SC.L2-3.13.11'), ['SC-13']), '3.13.11 -> SC-13', ids171('SC.L2-3.13.11'));
assert(ids171('3.1.1').length === 3, 'a bare requirement number works as well as a CMMC id');
assert(ids171('AC-2').length === 0, 'an SP 800-53 id has no forward crosswalk');
const ia221 = crosswalkFor171('IA.L2-3.5.3').find((c) => c.control === 'IA-2(1)');
assert(ia221?.kind === 'ENHANCEMENT' && ia221.parent === 'IA-2' && ia221.title.length > 0, 'counterparts carry title, kind and parent', ia221);
assert(crosswalkFor171('AC.L1-3.1.1').every((c) => c.kind === 'BASE' && !c.parent), 'base controls have no parent');

console.log('\n--- All 110 requirements ---');
const reqs = crosswalkRequirements();
assert(reqs.length === 110, `110 requirements in the crosswalk (${reqs.length})`);
const l2Reqs = CMMC_LEVEL_2_CONTROLS.map((c) => requirementNumberOf(c.id));
assert(l2Reqs.length === 110 && l2Reqs.every((r) => r !== null), 'every L2 catalog id carries a requirement number');
assert(reqs.every((r) => cmmcIdsForRequirement(r).length === 1), 'every requirement resolves to exactly one CMMC id');
assert(sameSet(reqs, l2Reqs as string[]), 'the crosswalk covers exactly the L2 catalog requirements');
const without = reqs.filter((r) => crosswalkFor171(r).length === 0);
assert(without.length === 1 && without[0] === '3.13.14', 'only 3.13.14 has no counterpart', without);
assert((withdrawnWithoutSuccessor()['3.13.14'] ?? []).includes('SC-19'), '3.13.14 is the documented withdrawn SC-19');
assert(cmmcIdsForRequirement('3.1.1')[0] === 'AC.L1-3.1.1', 'the L1 practice keeps the id the catalog defines');
assert(cmmcIdsForRequirement('9.9.9').length === 0, 'an unknown requirement has no CMMC id');

console.log('\n--- Targets exist in the catalog ---');
const catalogIds = new Set(NIST_800_53_CONTROLS.map((c) => c.id));
const missing = reqs.flatMap((r) => ids171(r)).filter((id) => !catalogIds.has(id));
assert(missing.length === 0, 'every target id exists in the SP 800-53 catalog', missing);
assert(reqs.some((r) => crosswalkFor171(r).some((c) => c.rev4)), 'withdrawn Rev. 4 controls carried to Rev. 5 are flagged with rev4');

console.log('\n--- Inverse lookup ---');
let inverseOk = true;
let pairs = 0;
for (const r of reqs) {
  for (const c of crosswalkFor171(r)) {
    pairs++;
    const inv = crosswalkFor53(c.control);
    const hit = inv.direct.find((d) => d.requirement === r);
    if (!hit || !sameSet(hit.cmmcIds, cmmcIdsForRequirement(r))) inverseOk = false;
  }
}
assert(pairs === 198 && inverseOk, `every forward pair (${pairs}) is listed by the inverse with its CMMC ids`);
const ac61 = crosswalkFor53('AC-6(1)');
assert(ac61.direct.some((d) => d.requirement === '3.1.5'), 'AC-6(1) lists 3.1.5 directly', ac61.direct);
const ac62 = crosswalkFor53('AC-6(2)');
assert(ac62.direct.length === 1 && ac62.direct[0].requirement === '3.1.6', 'AC-6(2) lists 3.1.6 directly', ac62.direct);
assert(ac62.viaParent.some((v) => v.parent === 'AC-6' && v.requirement === '3.1.5' && v.cmmcIds[0] === 'AC.L2-3.1.5'), 'AC-6(2) lists 3.1.5 through its base control AC-6', ac62.viaParent);
assert(ac61.viaParent.length === 0, 'AC-6(1) already lists 3.1.5 directly, so it is not repeated via the parent', ac61.viaParent);
const ac6 = crosswalkFor53('ac-6');
assert(ac6.viaParent.length === 0 && ac6.direct.length > 0, 'a base control has no via-parent entries; ids are case-insensitive');
assert(crosswalkFor53('PM-1').direct.length === 0 && crosswalkFor53('PM-1').viaParent.length === 0, 'a control no requirement maps to has an empty inverse');
assert(crosswalkFor53('AC-6(1)').direct[0].cmmcIds.length === 1, 'inverse entries carry CMMC ids');

console.log('\n--- Mapping rows ---');
const key = (m: { sourceFramework: string; sourceControlId: string; targetFramework: string; targetControlId: string }) => `${m.sourceFramework}|${m.sourceControlId}|${m.targetFramework}|${m.targetControlId}`;
const keys = CANONICAL_CONTROL_MAPPINGS.map(key);
assert(new Set(keys).size === keys.length, `no duplicate (source, target) pair among ${keys.length} mappings`);
assert(new Set(CANONICAL_CONTROL_MAPPINGS.map((m) => m.id)).size === CANONICAL_CONTROL_MAPPINGS.length, 'mapping ids are unique');
assert(CANONICAL_CONTROL_MAPPINGS.every((m) => m.id.length <= 64), 'ids fit VARCHAR(64)');
assert(CANONICAL_CONTROL_MAPPINGS.slice(0, HAND_CURATED_CONTROL_MAPPINGS.length).every((m, i) => m === HAND_CURATED_CONTROL_MAPPINGS[i]), 'the hand-curated rows come first, untouched');
assert(HAND_CURATED_CONTROL_MAPPINGS.length === 52 && HAND_CURATED_CONTROL_MAPPINGS.every((m) => m.mappingType === 'EQUIVALENT' && !m.provenance), 'the 52 hand-curated rows are all EQUIVALENT with no provenance');
assert(HAND_CURATED_CONTROL_MAPPINGS.find((m) => m.id === 'map-ac-1')?.targetControlId === 'AC-2', 'map-ac-1 is unchanged');
assert(CROSSWALK_MAPPINGS.length > 0 && CROSSWALK_MAPPINGS.every((m) => m.mappingType === 'SUBSET' && m.targetFramework === 'NIST_800_53_REV5'), 'every crosswalk row is SUBSET -> NIST_800_53_REV5');
assert(CROSSWALK_MAPPINGS.every((m) => m.provenance?.startsWith(CROSSWALK_PROVENANCE) && (m.notes ?? '').includes('Appendix D')), 'crosswalk rows carry provenance and notes');
assert(CROSSWALK_MAPPINGS.some((m) => /Rev\. 4 .* carried to Rev\. 5/.test(m.provenance ?? '')), 'a carried-over Rev. 4 control says so');
const curatedKeys = new Set(HAND_CURATED_CONTROL_MAPPINGS.map(key));
assert(CROSSWALK_MAPPINGS.every((m) => !curatedKeys.has(key(m))), 'a pair a hand-curated mapping covers is not added again');
const l1Ids = new Set(CMMC_LEVEL_1_CONTROLS.map((c) => c.id));
const l1Rows = CROSSWALK_MAPPINGS.filter((m) => m.sourceFramework === 'CMMC_L1');
assert(l1Rows.length > 0 && l1Rows.every((m) => l1Ids.has(m.sourceControlId)), 'CMMC_L1 rows exist only for L1 practices');
assert(CROSSWALK_MAPPINGS.filter((m) => m.sourceFramework === 'CMMC_L2').length + l1Rows.length === CROSSWALK_MAPPINGS.length, 'rows are sourced from CMMC_L2 and CMMC_L1 only');
const generated = reqs.reduce((n, r) => n + crosswalkFor171(r).length * (l1Ids.has(cmmcIdsForRequirement(r)[0]) ? 2 : 1), 0);
assert(generated - CROSSWALK_MAPPINGS.length === HAND_CURATED_CONTROL_MAPPINGS.filter((m) => m.targetFramework === 'NIST_800_53_REV5' && ids171(m.sourceControlId).includes(m.targetControlId)).length, `crosswalk rows generated ${generated}, ${generated - CROSSWALK_MAPPINGS.length} deduped against hand-curated pairs`);
console.log(`  (${CANONICAL_CONTROL_MAPPINGS.length} mappings: ${HAND_CURATED_CONTROL_MAPPINGS.length} hand-curated + ${CROSSWALK_MAPPINGS.length} crosswalk)`);

console.log('\n--- SUBSET rows never feed evidence inheritance ---');
assert(sameSet(getEquivalentControlIds('AC.L1-3.1.1'), ['AC-2', 'CC6.1', '164.312(a)(1)']), 'AC.L1-3.1.1 inherits only to its three hand-curated equivalents', getEquivalentControlIds('AC.L1-3.1.1'));
assert(getEquivalentControlIds('IA.L2-3.5.3').length === 0, 'IA.L2-3.5.3 has only SUBSET crosswalk rows: nothing inherits');
assert(getEquivalentControlIds('IA-2(1)').length === 0, 'the inverse direction does not inherit either');
assert(getCrossFrameworkMappings('IA.L2-3.5.3').length === 2, 'but the crosswalk rows are visible through getCrossFrameworkMappings');
const equivalentOnly = (rows: typeof CANONICAL_CONTROL_MAPPINGS, id: string) => {
  const up = id.toUpperCase();
  const out = new Set<string>();
  for (const m of rows) {
    if (m.mappingType !== 'EQUIVALENT' && m.mappingType !== 'EXACT') continue;
    if (m.sourceControlId.toUpperCase() === up) out.add(m.targetControlId);
    else if (m.targetControlId.toUpperCase() === up) out.add(m.sourceControlId);
  }
  return [...out];
};
const everyId = new Set(CANONICAL_CONTROL_MAPPINGS.flatMap((m) => [m.sourceControlId, m.targetControlId]));
const drift = [...everyId].filter((id) => !sameSet(getEquivalentControlIds(id), equivalentOnly(HAND_CURATED_CONTROL_MAPPINGS, id)));
assert(drift.length === 0, 'for every control, inheritance is exactly what the hand-curated mappings gave before the crosswalk', drift.slice(0, 5));

console.log('\n--- Migration ---');
const cm = TABLES_SQL.slice(TABLES_SQL.indexOf('CREATE TABLE IF NOT EXISTS control_mappings'));
assert(/ADD COLUMN IF NOT EXISTS provenance TEXT/.test(cm), 'provenance column is added idempotently');
assert(/CREATE INDEX IF NOT EXISTS idx_control_mappings_target ON control_mappings \(target_framework, target_control_id\)/.test(cm), 'target index');
assert(/CREATE INDEX IF NOT EXISTS idx_control_mappings_source ON control_mappings \(source_framework, source_control_id\)/.test(cm), 'source index');
assert(/DROP CONSTRAINT IF EXISTS control_mappings_mapping_type_check/.test(cm) && /CHECK \(mapping_type IN \('EXACT', 'EQUIVALENT', 'SUBSET', 'SUPERSET'\)\)/.test(cm), 'mapping_type check is dropped and re-added');
assert(cm.indexOf('UPDATE control_mappings') < cm.indexOf('ADD CONSTRAINT'), 'existing rows are normalised before the check is added');

console.log(`\nRESULTS: ${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
