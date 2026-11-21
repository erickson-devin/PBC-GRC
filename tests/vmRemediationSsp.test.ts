import fs from 'node:fs';
import path from 'node:path';
import { compileNistSSP, compileReportDocument } from '../src/data/reports/documentCompilers';
import { generateEmassControlMatrixCsv } from '../src/data/reports/sprsCompiler';
import { getFrameworkControls } from '../src/data/frameworks';
import { cmmcDisplayId } from '../src/data/cmmcGuide/displayId';
import { composeImplementationStatement } from '../src/data/cmmcGuide/sspStatement';
import { VM_POLICY_SSP_CONTROLS, VM_POLICY_SSP_LABEL_PREFIX, appendRemediationPolicyParagraph, remediationPolicySspParagraph } from '../src/data/vmRemediation';
import type { VmRemediationPolicy } from '../src/data/vmRemediation';
import type { ReportMetadata } from '../src/types/report';
import type { ControlState } from '../src/types/cmmc';

/**
 * The generated remediation-policy paragraph of the CMMC SSP (#268): what it says for each policy shape, that it is appended (labelled, at export time)
 * to RA.L2-3.11.3 and SI.L1-3.14.1 only, in the SSP document and the eMASS control matrix, only for CMMC Level 1 and 2 and only when the policy is given,
 * and that it never touches a control state or the recorded narrative. Pure: no server, no database.
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

const DEF: VmRemediationPolicy = { slaDays: { CRITICAL: 15, HIGH: 30, MEDIUM: 90, LOW: 180 }, warnOnly: ['MEDIUM', 'LOW'], graceDays: 0 };
const AS_OF = '2026-11-19';
const RA = 'RA.L2-3.11.3';
const SI = 'SI.L1-3.14.1';
const AC = 'AC.L1-3.1.1';

const DEF_PARAGRAPH =
  "[Generated from the vulnerability remediation policy as of 2026-11-19; not part of the recorded narrative] Vulnerabilities reported by the organization's scanners must be remediated within these deadlines, counted from when each is first seen: Critical 15 days, High 30 days, Medium 90 days, Low 180 days; unknown severity is treated as Medium. A known exploited vulnerability (CISA KEV) is due within the Critical deadline, or its own deadline if that is shorter. A Critical or High vulnerability, or a known exploited one, that is still open after its deadline is recorded as a POA&M item; Medium and Low vulnerabilities past their deadline are tracked as warnings on the Vulnerability Remediation screen. A finding may be accepted as a risk or marked as a false positive only with a written justification, approved by an owner-level administrator (Tenant Owner, MSP Admin) other than the person who requested it, for at most 365 days.";

console.log('--- SSP1: the paragraph ---');
assert(remediationPolicySspParagraph(RA, DEF, AS_OF) === DEF_PARAGRAPH, 'SSP1 the default policy gives the pinned paragraph', remediationPolicySspParagraph(RA, DEF, AS_OF));
assert(remediationPolicySspParagraph(SI, DEF, AS_OF) === DEF_PARAGRAPH, 'SSP1 the same paragraph for SI.L1-3.14.1');
assert(DEF_PARAGRAPH.startsWith(VM_POLICY_SSP_LABEL_PREFIX) && VM_POLICY_SSP_CONTROLS.join() === `${RA},${SI}`, 'SSP1 it starts with the generated label, and the two controls are RA.L2-3.11.3 and SI.L1-3.14.1');
const low = remediationPolicySspParagraph(RA, { ...DEF, warnOnly: ['LOW'] }, AS_OF) as string;
assert(low.includes('A Critical, High or Medium vulnerability, or a known exploited one, that is still open after its deadline is recorded as a POA&M item; Low vulnerabilities past their deadline are tracked as warnings on the Vulnerability Remediation screen.') && !low.includes('Medium and Low vulnerabilities past'), 'SSP1 only Low warn-only: Medium becomes a gap severity', low);
const none = remediationPolicySspParagraph(RA, { ...DEF, warnOnly: [] }, AS_OF) as string;
assert(none.includes('A Critical, High, Medium or Low vulnerability, or a known exploited one, that is still open after its deadline is recorded as a POA&M item. A finding may be accepted') && !none.includes('warnings'), 'SSP1 no warn-only severity: every overdue vulnerability is a POA&M item and nothing is a warning', none);
const grace = remediationPolicySspParagraph(RA, { ...DEF, graceDays: 7 }, AS_OF) as string;
assert(grace.includes('Vulnerability Remediation screen. A grace period of 7 days applies before a vulnerability counts as overdue, except a known exploited one. A finding may be accepted'), 'SSP1 a grace period is stated after the POA&M sentence', grace);
assert(remediationPolicySspParagraph(RA, { slaDays: { CRITICAL: 7, HIGH: 14, MEDIUM: 45, LOW: 120 }, warnOnly: ['MEDIUM', 'LOW'], graceDays: 1 }, AS_OF)!.includes('Critical 7 days, High 14 days, Medium 45 days, Low 120 days') && remediationPolicySspParagraph(RA, { ...DEF, graceDays: 1 }, AS_OF)!.includes('A grace period of 1 day applies'), 'SSP1 the saved deadlines are the ones printed');
assert(remediationPolicySspParagraph(AC, DEF, AS_OF) === null && remediationPolicySspParagraph('AC-2', DEF, AS_OF) === null, 'SSP1 no paragraph for any other control');

console.log('\n--- SSP2-SSP4, SSP6-SSP7: the SSP document ---');
const meta = (framework: ReportMetadata['framework'], withPolicy: boolean): ReportMetadata => ({
  systemName: 'Test enclave',
  organizationName: 'Test organization',
  cageCode: '1ABC2',
  samStatus: 'ACTIVE',
  systemOwner: 'Owner',
  primaryAssessor: 'Assessor',
  boundaryDescription: 'Boundary',
  systemEnvironment: 'Environment',
  operationalStatus: 'Operational',
  cloudServiceProviders: 'None',
  classificationLevel: 'UNCLASSIFIED // CUI',
  assessmentDate: '2026-11-19',
  version: '1.0.0',
  framework,
  ...(withPolicy ? { vmRemediationPolicy: { policy: DEF, asOf: AS_OF } } : {}),
});
const state = (notes: string): ControlState => ({ status: 'IN_PROGRESS', implementationNotes: notes }) as unknown as ControlState;
const l2 = getFrameworkControls('CMMC_L2').filter((c) => [RA, SI, AC].includes(c.id));
const states: Record<string, ControlState> = { [RA]: state('We scan every host weekly.'), [SI]: state('Patches are applied monthly.'), [AC]: state('Accounts are reviewed.') };
const statesBefore = JSON.stringify(states);
const cell = (doc: ReturnType<typeof compileNistSSP>, display: string): string => {
  const rows = (doc.sections.find((s) => s.id === 'sec-3-control-narratives')?.subsections ?? []).flatMap((s) => ((s.table?.rows ?? []) as unknown as Array<(string | number)[] | { cells: (string | number)[] }>).map((r) => (Array.isArray(r) ? r : r.cells)));
  return String(rows.find((r) => r[0] === display)?.[4] ?? '');
};
const composed = (id: string) => composeImplementationStatement(id, states[id].implementationNotes, undefined, 'CMMC_L2').text;
assert(l2.length === 3, 'the CMMC Level 2 catalog has the three controls the cases use', l2.map((c) => c.id));

const withPolicy = compileNistSSP(meta('CMMC_L2', true), l2, states, []);
const without = compileNistSSP(meta('CMMC_L2', false), l2, states, []);
const dRA = cmmcDisplayId(RA, 'CMMC_L2');
const dSI = cmmcDisplayId(SI, 'CMMC_L2');
const dAC = cmmcDisplayId(AC, 'CMMC_L2');
assert(cell(withPolicy, dRA) === `${composed(RA)}\n\n${DEF_PARAGRAPH}` && cell(withPolicy, dSI) === `${composed(SI)}\n\n${DEF_PARAGRAPH}`, 'SSP2 with the policy the RA and SI narrative cells are the composed statement, a blank line and the paragraph', [cell(withPolicy, dRA).slice(0, 80)]);
assert(cell(without, dRA) === composed(RA) && cell(without, dSI) === composed(SI) && composed(RA) === 'We scan every host weekly.', 'SSP3 without the policy the cells are the composed statement byte for byte');
const empty = compileNistSSP(meta('CMMC_L2', false), l2, { [RA]: state('') }, []);
const emptyWith = compileNistSSP(meta('CMMC_L2', true), l2, { [RA]: state('') }, []);
assert(cell(empty, dRA) === 'No implementation narrative documented.' && cell(emptyWith, dRA) === `No implementation narrative documented.\n\n${DEF_PARAGRAPH}`, 'SSP3 with no recorded narrative the placeholder stays and the labelled paragraph follows it');
assert(cell(withPolicy, dAC) === cell(without, dAC) && cell(withPolicy, dAC) === 'Accounts are reviewed.', 'SSP7 another control (AC.L1-3.1.1) is unchanged');
assert(JSON.stringify(states) === statesBefore, 'SSP6 compiling never changes a control state');
const nistControls = getFrameworkControls('NIST_800_53_REV5').slice(0, 5);
const nistWith = compileNistSSP(meta('NIST_800_53_REV5', true), nistControls, {}, []);
const nistWithout = compileNistSSP(meta('NIST_800_53_REV5', false), nistControls, {}, []);
assert(JSON.stringify(nistWith.sections) === JSON.stringify(nistWithout.sections) && !JSON.stringify(nistWith.sections).includes(VM_POLICY_SSP_LABEL_PREFIX), 'SSP4 a NIST 800-53 SSP is unchanged by the policy');
assert(appendRemediationPolicyParagraph('Text', RA, 'NIST_800_53_REV5', { policy: DEF, asOf: AS_OF }) === 'Text' && appendRemediationPolicyParagraph('Text', RA, 'SOC_2_TYPE_II', { policy: DEF, asOf: AS_OF }) === 'Text' && appendRemediationPolicyParagraph('Text', RA, 'HIPAA_SECURITY', { policy: DEF, asOf: AS_OF }) === 'Text', 'SSP4 SOC 2 and HIPAA are unchanged too');
assert(appendRemediationPolicyParagraph('Text', RA, 'CMMC_L2') === 'Text' && appendRemediationPolicyParagraph('Text', AC, 'CMMC_L2', { policy: DEF, asOf: AS_OF }) === 'Text', 'SSP4 no policy, or another control: the narrative as it is');
const l1 = getFrameworkControls('CMMC_L1').filter((c) => c.id === SI);
const l1doc = compileNistSSP(meta('CMMC_L1', true), l1, { [SI]: state('Patches are applied monthly.') }, []);
assert(cell(l1doc, cmmcDisplayId(SI, 'CMMC_L1')).endsWith(DEF_PARAGRAPH), 'SSP2 a CMMC Level 1 SSP carries it on SI.L1-3.14.1');
const viaReport = compileReportDocument('NIST_SP_800_18_SSP', meta('CMMC_L2', true), l2, states, []);
assert(cell(viaReport as ReturnType<typeof compileNistSSP>, dRA).endsWith(DEF_PARAGRAPH), 'SSP2 compileReportDocument (what the export screen calls) carries it as well');

console.log('\n--- SSP5: the eMASS control matrix ---');
const csvWith = generateEmassControlMatrixCsv(l2, states, meta('CMMC_L2', true));
const csvWithout = generateEmassControlMatrixCsv(l2, states, meta('CMMC_L2', false));
const csvRow = (csv: string, display: string): string => csv.split('\r\n').find((l) => l.includes(`"${display}"`) || l.includes(`,${display},`)) ?? '';
assert(csvRow(csvWith, dSI).includes(VM_POLICY_SSP_LABEL_PREFIX) && csvRow(csvWith, dRA).includes(VM_POLICY_SSP_LABEL_PREFIX) && csvRow(csvWith, dSI).includes('Patches are applied monthly.'), 'SSP5 the eMASS row of SI.L1-3.14.1 (and RA.L2-3.11.3) holds the narrative and the labelled paragraph');
assert(!csvRow(csvWith, dAC).includes(VM_POLICY_SSP_LABEL_PREFIX) && csvRow(csvWith, dAC) === csvRow(csvWithout, dAC) && !csvWithout.includes(VM_POLICY_SSP_LABEL_PREFIX), 'SSP5 other rows, and a matrix built without the policy, are unchanged');
assert(JSON.stringify(states) === statesBefore, 'SSP6 building the matrix never changes a control state either');

console.log('\n--- SSP8: wording and wiring ---');
// The same phrasings tests/roleScreens.test.ts (S7) forbids in any source file: the approvers are owner-level access, never "Owner or MSP Admin"
const OLD_WRITE_WORDING = /Tenant Owner (or|\/|and) MSP Admin|owners? (or|\/|and) (an? )?MSP admin(istrator)?s?|only a tenant owner can resolve|TENANT_OWNER (\/|and|or) MSP_ADMIN|owner \/ MSP( only)?\b/i;
const variants = [DEF, { ...DEF, warnOnly: ['LOW'] as VmRemediationPolicy['warnOnly'] }, { ...DEF, warnOnly: [] }, { ...DEF, graceDays: 7 }].map((p) => remediationPolicySspParagraph(RA, p, AS_OF) as string);
assert(variants.every((v) => !OLD_WRITE_WORDING.test(v) && v.includes('owner-level administrator (Tenant Owner, MSP Admin) other than the person who requested it')), 'SSP8 no variant uses a phrasing the wording guard forbids; each names owner-level approval by someone other than the requester');
const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const compilers = src('src/data/reports/documentCompilers.ts');
const sprs = src('src/data/reports/sprsCompiler.ts');
assert(compilers.split('composeImplementationStatement(').length - 1 === 1 && sprs.split('composeImplementationStatement(').length - 1 === 1, 'SSP8 each compiler still composes the statement once (the paragraph is appended after it)');
assert(compilers.includes('appendRemediationPolicyParagraph(narrative, ctrl.id, metadata.framework, metadata.vmRemediationPolicy)') && sprs.includes('metadata.vmRemediationPolicy'), 'SSP8 both compilers pass metadata.vmRemediationPolicy');
assert(!/(console\.|localStorage|sessionStorage|dangerouslySetInnerHTML)/.test(src('src/data/vmRemediation.ts')), 'SSP8 the pure module has no console, storage or raw HTML');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
process.exit(passed === total ? 0 : 1);
