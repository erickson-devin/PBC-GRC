import fs from 'node:fs';
import path from 'node:path';
import catalogJson from '../src/data/frameworks/nist171r3/catalog.generated.json';
import type { GeneratedR3CatalogFile } from '../src/data/frameworks/nist171r3/types';
import { DOD_ODP_DEFAULTS, type DodOdpDefaults } from '../src/data/frameworks/nist171r3/odpDefaults';
import { attachDodDefaults, checkDodDefaults, dodDefaultsMeta } from '../src/data/frameworks/nist171r3/odp';
import { NIST_171_R3_CONTROLS, buildR3Controls } from '../src/data/frameworks/nist171r3/controls';
import { odpDefaultButtonLabel, odpDefaultProvenance } from '../src/data/odpDefaultView';

/**
 * The DoD ODP default values for NIST SP 800-171 Rev. 3 (issue #255): the mechanism, with an empty and unverified table. Values
 * must come from a verified transcription of the DoD memo, never from a model. Pure: does not boot the server.
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

const catalog = catalogJson as unknown as GeneratedR3CatalogFile;

// ---- the committed table
const keys = Object.keys(DOD_ODP_DEFAULTS.values);
assert(keys.every((k) => catalog.odps[k] !== undefined), 'O1: every key of the committed DoD values is an ODP id of the catalog', keys.filter((k) => !catalog.odps[k]));
assert(checkDodDefaults(DOD_ODP_DEFAULTS, catalog.odps).length === 0, 'O2: the committed table passes checkDodDefaults (placement TAG, provenance when verified)', checkDodDefaults(DOD_ODP_DEFAULTS, catalog.odps));
assert(keys.length === 0 && DOD_ODP_DEFAULTS.meta.verified === false, 'O3: the committed DoD table is empty and unverified: values must come from a verified transcription of the DoD memo by people, not be added by a model', { keys: keys.length, verified: DOD_ODP_DEFAULTS.meta.verified });
assert(DOD_ODP_DEFAULTS.meta.date === '' && DOD_ODP_DEFAULTS.meta.url === '' && DOD_ODP_DEFAULTS.meta.sha256 === '', 'O4: no date, url or hash is claimed for a memo nobody has verified');
assert(dodDefaultsMeta() === null, 'O5: dodDefaultsMeta is null while the table is unverified');
assert(NIST_171_R3_CONTROLS.every((c) => (c.parameters ?? []).every((p) => p.defaultValue === undefined && p.defaultSource === undefined)), 'O6: NIST_171_R3_CONTROLS as shipped has no defaultValue anywhere');

// ---- a fixture table
const tagOdps = Object.entries(catalog.odps).filter(([, o]) => o.placement === 'TAG');
const req = catalog.requirements.find((r) => r.odps.length >= 2 && r.odps.every((id) => catalog.odps[id]?.placement === 'TAG'));
assert(!!req, 'O7: the catalog has a requirement with two tagged ODPs to test with');
if (req) {
  const [first, second] = req.odps;
  const fixture: DodOdpDefaults = {
    meta: { ...DOD_ODP_DEFAULTS.meta, date: '2000-01-01', url: 'https://example.invalid/memo', sha256: 'a'.repeat(64), verified: true },
    values: { [first]: { value: 'FIXTURE ONE', page: 1, verified: true }, [second]: { value: 'FIXTURE TWO', page: 2, verified: false } },
  };
  const before = JSON.stringify(buildR3Controls());
  const input = buildR3Controls();
  const out = attachDodDefaults(input, fixture);
  assert(JSON.stringify(input) === before, 'O8: attachDodDefaults does not change its input');
  const c = out.find((x) => x.id === req.id)!;
  const p1 = c.parameters!.find((p) => p.id === `${req.id}#1`)!;
  const p2 = c.parameters!.find((p) => p.id === `${req.id}#2`)!;
  assert(p1.defaultValue === 'FIXTURE ONE' && p1.defaultSource === 'DOD_ODP', 'O9: the verified entry sets defaultValue and defaultSource on parameter #1', p1);
  assert(p2.defaultValue === undefined && p2.defaultSource === undefined, 'O10: the unverified entry sets nothing on parameter #2', p2);
  const withValue = out.flatMap((x) => (x.parameters ?? []).filter((p) => p.defaultValue !== undefined).map((p) => p.id));
  assert(withValue.length === 1 && withValue[0] === `${req.id}#1`, 'O11: only that one parameter in the whole catalog has a default', withValue);
  const off = attachDodDefaults(buildR3Controls(), { ...fixture, meta: { ...fixture.meta, verified: false } });
  assert(off.every((x) => (x.parameters ?? []).every((p) => p.defaultValue === undefined)), 'O12: meta.verified false: no parameter has a defaultValue even with verified entries');
  assert(dodDefaultsMeta(fixture)?.date === '2000-01-01', 'O13: dodDefaultsMeta returns the meta when verified');

  assert(checkDodDefaults(fixture, catalog.odps).length === 0, 'O14: a well-formed verified fixture passes checkDodDefaults');
  assert(checkDodDefaults({ ...fixture, meta: { ...fixture.meta, sha256: '' } }, catalog.odps).length === 1, 'O15: a verified table without a 64-hex sha256 fails checkDodDefaults');
  assert(checkDodDefaults({ ...fixture, meta: { ...fixture.meta, date: '' } }, catalog.odps).length === 1, 'O16: a verified table without a date fails checkDodDefaults');
  assert(checkDodDefaults({ ...fixture, values: { 'A.99.99.99.ODP[01]': { value: 'x', page: 1, verified: true } } }, catalog.odps).length === 1, 'O17: an unknown ODP id fails checkDodDefaults');
}
const notTag = Object.entries(catalog.odps).find(([, o]) => o.placement !== 'TAG');
if (notTag) {
  const bad: DodOdpDefaults = { meta: DOD_ODP_DEFAULTS.meta, values: { [notTag[0]]: { value: 'x', page: 1, verified: true } } };
  assert(checkDodDefaults(bad, catalog.odps).length === 1, 'O18: an ODP with placement NESTED or OBJECTIVES cannot take a default');
}
assert(tagOdps.length > 0, 'O19: the catalog has ODPs with their own statement tag');

// ---- the panel's wording (UI plan case 22)
assert(odpDefaultButtonLabel({}) === null && odpDefaultButtonLabel({ defaultSource: 'DOD_ODP' }) === null, 'O20: no defaultValue: no button label');
assert(odpDefaultButtonLabel({ defaultValue: 'x', defaultSource: 'DOD_ODP' }) === 'Use DoD value (x)', 'O21: a DoD value reads "Use DoD value (x)"');
const long = 'v'.repeat(100);
const longLabel = odpDefaultButtonLabel({ defaultValue: long, defaultSource: 'DOD_ODP' })!;
assert(longLabel.startsWith('Use DoD value (') && longLabel.includes('…') && !longLabel.includes(long) && longLabel === `Use DoD value (${'v'.repeat(60)}…)`, 'O22: a 100-character DoD value is truncated to 60 with an ellipsis', longLabel);
assert(odpDefaultButtonLabel({ defaultValue: 'every 90 days' }) === 'Use baseline (every 90 days)', 'O23: any other default keeps "Use baseline (x)"');
assert(odpDefaultProvenance({ defaultValue: 'x' }, { date: '2000-01-01' }) === null && odpDefaultProvenance({}, null) === null, 'O24: no provenance without DOD_ODP');
const prov = odpDefaultProvenance({ defaultValue: 'x', defaultSource: 'DOD_ODP' }, { date: '2000-01-01' })!;
assert(prov.includes('(2000-01-01)') && prov.includes('Confirm it applies to your contract before using it.'), 'O25: DoD provenance names the memo date and asks the reader to confirm');
assert(!odpDefaultProvenance({ defaultValue: 'x', defaultSource: 'DOD_ODP' }, null)!.includes('('), 'O26: a null meta drops the date');

const panel = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'matrix', 'OdpPanel.tsx'), 'utf8');
assert(panel.includes('odpDefaultButtonLabel(') && panel.includes('odpDefaultProvenance(') && panel.includes("'DOD_ODP'"), 'O27: OdpPanel uses odpDefaultButtonLabel and odpDefaultProvenance');
assert(!panel.includes('Use baseline ('), 'O28: the "Use baseline" wording now lives in odpDefaultView, not in the panel');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
