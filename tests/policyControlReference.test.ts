import fs from 'fs';
import path from 'path';
import { policyControlReference } from '../src/data/policyControlReference';
import { crosswalkFor53 } from '../src/data/frameworks/nist80053/crosswalk';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { cmmcNumberOf } from '../src/data/cmmcGuide/guide';
import { isFamilyPolicyControl, FAMILY_POLICY_REQUIREMENTS } from '../src/data/reports/familyPolicyControl';

/**
 * Issue #232: the "AC-1" buttons of the policy views open a read-only SP 800-53 reference and never switch the active program.
 * Pure test: the helper plus static checks of the source files. No server, no browser.
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

const root = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const reqs = (r: { practices: Array<{ requirement: string }> }): string[] => [...new Set(r.practices.map((p) => p.requirement))];

console.log('--- CMMC Level 2: AC-1 ---');
{
  const r = policyControlReference('AC-1', 'CMMC_L2', new Set(['AC.L2-3.1.5']));
  assert(r.found, 'AC-1 is found');
  assert(r.title === 'Policy and Procedures', 'AC-1 title', r.title);
  assert(!r.openInMatrix, 'a CMMC program does not open AC-1 itself');
  assert(reqs(r).length === 22 && reqs(r).includes('3.1.1') && reqs(r).includes('3.1.22'), 'practices for 3.1.1 to 3.1.22', reqs(r));
  const p315 = r.practices.find((p) => p.requirement === '3.1.5');
  assert(Boolean(p315) && p315!.via.includes('AC-6'), '3.1.5 maps via AC-6', p315);
  assert(Boolean(p315) && p315!.inProgram, '3.1.5 is in the program');
  assert(r.practices.filter((p) => p.requirement !== '3.1.5').every((p) => !p.inProgram), 'all others are not in the program');
}

console.log('--- CMMC Level 1: AC-1 ---');
{
  const r = policyControlReference('AC-1', 'CMMC_L1', new Set());
  assert(r.practices.length > 0 && r.practices.every((p) => /\.L1-/.test(p.id)), 'every id is a Level 1 practice');
  assert(JSON.stringify(reqs(r)) === JSON.stringify(['3.1.1', '3.1.2', '3.1.20', '3.1.22']), 'Level 1 requirements', reqs(r));
}

console.log('--- other families ---');
{
  const sc = reqs(policyControlReference('SC-1', 'CMMC_L2', new Set()));
  assert(sc.includes('3.8.6') && sc.includes('3.3.7'), 'SC-1 includes 3.8.6 and 3.3.7', sc);
  assert(!sc.includes('3.13.14'), 'SC-1 excludes 3.13.14', sc);
  assert(JSON.stringify(reqs(policyControlReference('CP-1', 'CMMC_L2', new Set()))) === JSON.stringify(['3.8.9']), 'CP-1 maps 3.8.9 only');
  const pm = policyControlReference('PM-1', 'CMMC_L2', new Set());
  assert(pm.found && pm.practices.length === 0, 'PM-1 is found with no practices');
}

console.log('--- NIST program ---');
{
  const a = policyControlReference('AC-1', 'NIST_800_53_REV5', new Set(['AC-1']));
  assert(a.openInMatrix && a.practices.length === 0, 'AC-1 opens in the matrix, no practices');
  assert(!policyControlReference('PM-1', 'NIST_800_53_REV5', new Set(['AC-1'])).openInMatrix, 'PM-1 not recorded: reference only');
}

console.log('--- unknown, families, normalisation ---');
{
  const z = policyControlReference('ZZ-1', 'CMMC_L2', new Set());
  assert(!z.found && z.title === '', 'ZZ-1 is not found');
  for (const f of ['AC', 'AT', 'AU', 'CA', 'CM', 'CP', 'IA', 'IR', 'MA', 'MP', 'PE', 'PL', 'PS', 'RA', 'SA', 'SC', 'SI', 'PM', 'PT', 'SR']) {
    assert(policyControlReference(`${f}-1`, 'CMMC_L2', new Set()).found, `${f}-1 is in the catalog`);
  }
  assert(policyControlReference('ac-1', 'CMMC_L2', new Set()).controlId === 'AC-1', 'lower case id is normalised');
  assert(policyControlReference('AC-1', 'CMMC-L2', new Set()).practices.length === policyControlReference('AC-1', 'CMMC_L2', new Set()).practices.length, 'CMMC-L2 equals CMMC_L2');
  const x = crosswalkFor53('AC-1');
  assert(x.direct.length === 0 && x.viaParent.length === 0, 'Appendix D maps nothing to AC-1 itself');
}

console.log('--- source checks ---');
{
  const dialog = read('src/components/matrix/PolicyControlReferenceDialog.tsx');
  const helper = read('src/data/policyControlReference.ts');
  for (const rel of ['src/views/PolicyLibraryView.tsx', 'src/components/settings/EnclaveSettings.tsx']) {
    const s = read(rel);
    const name = path.basename(rel);
    assert(!s.includes('setActiveFramework'), `${name} does not switch the framework`);
    assert(s.includes('<PolicyControlReferenceDialog'), `${name} renders the reference dialog`);
    assert(s.includes('aria-haspopup="dialog"'), `${name} marks the button as opening a dialog`);
  }
  assert(dialog.includes('z-[60]') && dialog.includes('max-h-[90vh]') && dialog.includes('<DialogTitle') && dialog.includes('Read-only'), 'dialog has its overlay classes, title and read-only text');
  assert(!dialog.includes('setActiveFramework') && !dialog.includes('console.') && !dialog.includes('dangerouslySetInnerHTML'), 'dialog never switches, logs or injects HTML');
  assert(!helper.includes('console.'), 'helper does not log');
}

console.log('--- #289: Living Policy tab ---');
{
  for (const id of ['AC.L1-3.1.1', 'AC.L2-3.1.1', 'SC.L1-3.13.1', 'IA.L1-3.5.1', 'SI.L1-3.14.1', 'AU.L2-3.3.1', 'CM.L2-3.4.1']) {
    assert(isFamilyPolicyControl(id), `${id} offers the Living Policy tab`);
  }
  for (let n = 10; n <= 19; n++) assert(!isFamilyPolicyControl(`AC.L2-3.1.${n}`), `AC.L2-3.1.${n} does not`);
  assert(!isFamilyPolicyControl('IA.L2-3.5.10'), 'IA.L2-3.5.10 does not');
  assert(!isFamilyPolicyControl('IA.L2-3.5.11'), 'IA.L2-3.5.11 does not');
  for (let n = 10; n <= 16; n++) assert(!isFamilyPolicyControl(`SC.L2-3.13.${n}`), `SC.L2-3.13.${n} does not`);
  assert(!isFamilyPolicyControl('SC.L2-3.13.11'), 'SC.L2-3.13.11 does not');
  assert(!isFamilyPolicyControl('AC.L1-3.1.2'), 'AC.L1-3.1.2 does not');
  assert(!isFamilyPolicyControl('AC.L1-b.1.i'), 'AC.L1-b.1.i does not');
  assert(!isFamilyPolicyControl('') && !isFamilyPolicyControl(undefined), 'an empty or missing id does not');

  const l2 = getFrameworkControls('CMMC_L2').map((c) => c.id).filter((id) => isFamilyPolicyControl(id));
  const nums = l2.map((id) => cmmcNumberOf(id) ?? '').sort();
  assert(l2.length === FAMILY_POLICY_REQUIREMENTS.length, 'CMMC L2: one matching control per family', l2);
  assert(JSON.stringify(nums) === JSON.stringify([...FAMILY_POLICY_REQUIREMENTS].sort()), 'CMMC L2: the matching numbers are the family list', nums);
  assert(new Set(l2.map((id) => id.slice(0, 2))).size === l2.length, 'CMMC L2: each has a distinct family prefix', l2);
  const l1 = getFrameworkControls('CMMC_L1').map((c) => c.id).filter((id) => isFamilyPolicyControl(id)).sort();
  assert(JSON.stringify(l1) === JSON.stringify(['AC.L1-3.1.1', 'IA.L1-3.5.1', 'PE.L1-3.10.1', 'SC.L1-3.13.1', 'SI.L1-3.14.1']), 'CMMC L1: the five Level 1 families', l1);

  // The expression this replaced, kept to prove that every other framework behaves as before.
  const legacy = (id: string): boolean => Boolean(
    id && (
      id.endsWith('-1') ||
      id === '3.1.1' || id === '3.2.1' || id === '3.3.1' || id === '3.4.1' || id === '3.5.1' || id === '3.6.1' || id === '3.7.1' ||
      id === '3.8.1' || id === '3.9.1' || id === '3.10.1' || id === '3.11.1' || id === '3.12.1' || id === '3.13.1' || id === '3.14.1' ||
      id.includes('.L2-3.1.1') || id.includes('.L2-3.5.1') || id.includes('.L2-3.14.1') ||
      id.includes('.L2-3.3.1') || id.includes('.L2-3.4.1') || id.includes('.L2-3.13.1')
    )
  );
  const ids = [
    ...['NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY'].flatMap((f) => getFrameworkControls(f).map((c) => c.id)),
    '3.1.1', '3.14.1', '3.1.10', 'AC-1', 'AC-10', 'AC-11', 'AC-2(1)',
  ];
  const mismatches = ids.filter((id) => isFamilyPolicyControl(id) !== legacy(id));
  assert(ids.length > 300 && mismatches.length === 0, 'non-CMMC ids match the old expression', mismatches);
  assert(isFamilyPolicyControl('AC-1') && isFamilyPolicyControl('3.1.1'), 'AC-1 and 3.1.1 are policy controls');
  assert(!isFamilyPolicyControl('AC-10') && !isFamilyPolicyControl('AC-11') && !isFamilyPolicyControl('3.1.10'), 'AC-10, AC-11 and 3.1.10 are not');

  const modal = read('src/components/matrix/InspectDocumentModal.tsx');
  const helper = read('src/data/reports/familyPolicyControl.ts');
  assert(modal.includes('isFamilyPolicyControl(control?.id)') && !modal.includes(".includes('.L2-3."), 'the modal uses the helper, no substring checks');
  assert(!helper.includes('console.'), 'helper does not log');
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
