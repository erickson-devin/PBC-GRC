/**
 * Event Horizon: Singularity - Ticket 1.4 Automated Test Suite
 * CMMC & DoD Compliance Safeguards:
 * 1. Cryptographically Verifiable Audit Trail (SHA-256 Hash Chaining & Tamper Detection)
 * 2. Automated SPRS & eMASS Submission Export Engine
 * 3. DFARS 252.204-7012 Data Retention & Cryptographic Data Sanitization (NIST SP 800-88 Rev 1)
 */

import {
  recordAuditEvent,
  verifyAuditChain,
  getAuditLogs,
  exportAuditPackageJson,
  saveLedger,
  describeNotesForLedger,
  GENESIS_HASH,
} from '../src/data/audit/auditLogger';
import {
  calculateSprsScore,
  getSprsPointDeduction,
  generateEmassControlMatrixCsv,
  generateSprsAssessmentSummary,
  sprsAppliesTo,
  emassCsvNotes,
} from '../src/data/reports/sprsCompiler';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import fs from 'fs';
import path from 'path';
import {
  purgeTenantData,
  MIN_RETENTION_DAYS,
} from '../src/data/storage/retentionPolicy';
import * as retentionModule from '../src/data/storage/retentionPolicy';
import { CMMC_LEVEL_2_CONTROLS } from '../src/data/frameworks/cmmcLevel2Controls';
import { ControlState } from '../src/types/cmmc';
import { ReportMetadata } from '../src/types/report';

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passCount++;
  } else {
    console.error(`  ✗ FAIL: ${testName}${detail ? ` (${detail})` : ''}`);
    failCount++;
  }
}

async function runTestSuite() {
  console.log('\n================================================================');
  console.log('🛡️  EVENT HORIZON: SINGULARITY - TICKET 1.4 TEST SUITE');
  console.log('   CMMC & DoD Compliance Safeguards');
  console.log('================================================================\n');

  // ==========================================================================
  // SECTION 1: CRYPTOGRAPHIC AUDIT LEDGER & HASH CHAINING
  // ==========================================================================
  console.log('--- Test Group 1: Immutable SHA-256 Chained Audit Ledger ---');
  const testTenant = 'test-tenant-safeguards-01';
  saveLedger(testTenant, []); // Reset ledger

  // 1.1 First block links to GENESIS_HASH
  const entry1 = await recordAuditEvent({
    tenantId: testTenant,
    actorEmail: 'ciso@defense-prime.com',
    actorRole: 'Tenant Owner',
    actionType: 'CONTROL_STATUS_UPDATED',
    targetEntity: 'AC.L1-3.1.1',
    previousState: 'NOT_STARTED',
    newState: 'MET',
  });

  assert(entry1.sequenceNumber === 1, 'First block sequence number is 1');
  assert(entry1.previousHash === GENESIS_HASH, 'First block previousHash equals GENESIS_HASH');
  assert(entry1.sha256Hash.length === 64, 'First block has 64-character SHA-256 digest');

  // 1.2 Second block points to First Block
  const entry2 = await recordAuditEvent({
    tenantId: testTenant,
    actorEmail: 'ciso@defense-prime.com',
    actorRole: 'Tenant Owner',
    actionType: 'EVIDENCE_UPLOADED',
    targetEntity: 'AC.1.001_mfa_proof.pdf',
    newState: { sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
  });

  assert(entry2.sequenceNumber === 2, 'Second block sequence number is 2');
  assert(entry2.previousHash === entry1.sha256Hash, 'Second block previousHash equals entry1.sha256Hash');

  // 1.3 Third block points to Second Block
  const entry3 = await recordAuditEvent({
    tenantId: testTenant,
    actorEmail: 'auditor@thirdparty-c3pao.org',
    actorRole: 'Lead Assessor',
    actionType: 'DOCUMENT_GENERATED',
    targetEntity: 'NIST_SP_800_18_SSP',
    newState: { version: '1.0.0' },
  });

  assert(entry3.sequenceNumber === 3, 'Third block sequence number is 3');
  assert(entry3.previousHash === entry2.sha256Hash, 'Third block previousHash equals entry2.sha256Hash');

  // 1.4 Traversal Verification on Pristine Chain
  const entries = getAuditLogs(testTenant);
  assert(entries.length === 3, 'Ledger contains exactly 3 entries');

  const verifyResult = await verifyAuditChain(entries);
  assert(verifyResult.isValid === true, 'Untampered chain traverses successfully (isValid = true)');
  assert(verifyResult.totalEntries === 3, 'Verified total entries is 3');
  assert(verifyResult.rootHash === entry1.sha256Hash, 'Root hash matches block 1 digest');
  assert(verifyResult.headHash === entry3.sha256Hash, 'Head hash matches block 3 digest');

  // 1.5 Tamper Detection: Mutating Payload in Entry 2
  const tamperedEntries = JSON.parse(JSON.stringify(entries));
  tamperedEntries[1].newState = { sha256: 'MALICIOUS_TAMPERED_HASH_CONTENT' };

  const tamperResult = await verifyAuditChain(tamperedEntries);
  assert(tamperResult.isValid === false, 'Tampered chain fails cryptographic verification (isValid = false)');
  assert(tamperResult.brokenIndex === 1, 'Tamper detector correctly identifies broken block at index 1');

  // 1.6 Tamper Detection: Mutating Linkage Pointer
  const pointerTamperedEntries = JSON.parse(JSON.stringify(entries));
  pointerTamperedEntries[2].previousHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const pointerResult = await verifyAuditChain(pointerTamperedEntries);
  assert(pointerResult.isValid === false, 'Pointer linkage mutation fails verification');
  assert(pointerResult.brokenIndex === 2, 'Pointer violation detected at index 2');

  // 1.7 JSON Export Certified Bundle
  const exportJson = await exportAuditPackageJson(testTenant, 'Vanguard Defense');
  assert(exportJson.includes('Event Horizon: Singularity'), 'Export JSON includes platform name');
  assert(exportJson.includes('"isValid": true'), 'Export JSON includes verified chain proof');

  // 1.8 Notes-change events record a digest and length only: no notes text in the localStorage-backed ledger
  const g = globalThis as any;
  const hadWindow = 'window' in g;
  const priorWindow = g.window;
  const fakeStore = new Map<string, string>();
  g.window = {
    localStorage: {
      getItem: (k: string) => (fakeStore.has(k) ? fakeStore.get(k)! : null),
      setItem: (k: string, v: string) => { fakeStore.set(k, String(v)); },
      removeItem: (k: string) => { fakeStore.delete(k); },
    },
  };
  try {
    const notesTenant = 'test-tenant-notes-ledger';
    const oldNotes = 'CUI-MARKER-7f3a previous paragraph';
    const newNotes = 'CUI-MARKER-7f3a secret paragraph';
    saveLedger(notesTenant, []);
    const notesEntry = await recordAuditEvent({
      tenantId: notesTenant,
      actorEmail: 'ciso@defense-prime.com',
      actionType: 'CONTROL_NOTES_UPDATED',
      targetEntity: 'AC.L1-3.1.1',
      previousState: await describeNotesForLedger(oldNotes),
      newState: await describeNotesForLedger(newNotes),
    });
    const storedLedger = fakeStore.get(`pbc_audit_ledger_${notesTenant}`) || '';
    assert(storedLedger.length > 0 && storedLedger.includes('CONTROL_NOTES_UPDATED'), 'Notes change is recorded in the persisted ledger');
    assert(!storedLedger.includes('CUI-MARKER-7f3a') && !storedLedger.includes('secret paragraph'), 'Persisted ledger JSON contains no notes text');
    const newStateText = String(notesEntry.newState);
    assert(
      /^sha256:[0-9a-f]{64} \(\d+ chars\)$/.test(newStateText) || /^\(\d+ chars\)$/.test(newStateText),
      'Notes newState is a digest + length (or length-only fallback)',
      newStateText
    );
    assert(newStateText.endsWith(`(${newNotes.length} chars)`), 'Notes newState records the correct length');
    assert(String(notesEntry.previousState).endsWith(`(${oldNotes.length} chars)`), 'Notes previousState records the correct length');
    assert((await describeNotesForLedger('')) === '' && (await describeNotesForLedger('   \n')) === '', 'Empty or whitespace-only notes give an empty string');
  } finally {
    if (hadWindow) g.window = priorWindow; else delete g.window;
  }

  // ==========================================================================
  // SECTION 2: AUTOMATED SPRS & eMASS EXPORT ENGINE
  // ==========================================================================
  console.log('\n--- Test Group 2: DoD SPRS Score & eMASS Submission Generator ---');

  // Completed-SSP fixture: SPRS only scores when the SSP (3.12.4) exists, so every scored case provides one.
  const SSP_META = {
    systemName: 'Vanguard Enclave',
    organizationName: 'Vanguard Defense Systems',
    systemOwner: 'J. Doe, CISO',
    systemBoundaryScope: 'Corporate enclave handling CUI',
  };

  // 2.1 SPRS Point Deduction Weights
  assert(getSprsPointDeduction('AC.L1-3.1.1') === 5, 'AC.L1-3.1.1 carries 5-point deduction');
  assert(getSprsPointDeduction('3.1.1') === 5, 'Normalized 3.1.1 carries 5-point deduction');
  assert(getSprsPointDeduction('AC.L2-3.1.5') === 3, 'AC.L2-3.1.5 carries 3-point deduction');
  assert(getSprsPointDeduction('AC.L2-3.1.3') === 1, 'AC.L2-3.1.3 carries 1-point deduction');

  // 2.2 Perfect SPRS Score Evaluation (110 Points)
  const perfectControlStates: Record<string, ControlState> = {};
  for (const c of CMMC_LEVEL_2_CONTROLS) {
    perfectControlStates[c.id] = {
      id: c.id,
      tenantId: testTenant,
      status: 'MET',
      implementationNotes: 'Enforced via automated Azure Entra ID / GCP Zero Trust policies.',
      responsibleRole: 'CISO',
      lastUpdated: '2026-09-14',
      tags: [],
    };
  }

  const perfectScore = calculateSprsScore(CMMC_LEVEL_2_CONTROLS, perfectControlStates, SSP_META);
  assert(perfectScore.score === 110, 'Full compliance yields maximum 110 SPRS score');
  assert(perfectScore.totalDeductions === 0, 'Zero deductions on fully compliant assessment');
  assert(perfectScore.metCount === 110, 'All 110 controls met');
  assert(perfectScore.completionPercentage === 100, '100% completion percentage');

  // 2.3 Single Critical Deficiency (-5 points)
  const fivePointDeficientStates: Record<string, ControlState> = { ...perfectControlStates };
  fivePointDeficientStates['AC.L1-3.1.1'] = {
    ...fivePointDeficientStates['AC.L1-3.1.1'],
    status: 'NOT_MET',
  };

  const fivePointScore = calculateSprsScore(CMMC_LEVEL_2_CONTROLS, fivePointDeficientStates, SSP_META);
  assert(fivePointScore.score === 105, '110 - 5 = 105 SPRS score for unmet 3.1.1');
  assert(fivePointScore.totalDeductions === 5, 'Total deductions is 5');
  assert(fivePointScore.deductionsByWeight.fivePoint.includes('AC.L1-3.1.1'), 'AC.L1-3.1.1 in 5-point list');

  // 2.4 Multiple Deficiencies (-5 + -3 + -1 = -9 points)
  const multiDeficientStates: Record<string, ControlState> = { ...fivePointDeficientStates };
  multiDeficientStates['AC.L2-3.1.5'] = { ...multiDeficientStates['AC.L2-3.1.5'], status: 'IN_PROGRESS' }; // -3
  multiDeficientStates['AC.L2-3.1.3'] = { ...multiDeficientStates['AC.L2-3.1.3'], status: 'NOT_MET' };     // -1

  const multiScore = calculateSprsScore(CMMC_LEVEL_2_CONTROLS, multiDeficientStates, SSP_META);
  assert(multiScore.score === 101, '110 - (5+3+1) = 101 SPRS score');
  assert(multiScore.totalDeductions === 9, 'Total deductions is 9');

  // 2.4.1 Every requirement except the SSP unmet yields exactly -203 through plain arithmetic (110 - 313)
  const zeroControlStates: Record<string, ControlState> = {};
  for (const c of CMMC_LEVEL_2_CONTROLS) {
    zeroControlStates[c.id] = {
      id: c.id,
      tenantId: testTenant,
      // 3.12.4 is the SSP itself (no point value): it must be MET for any score to exist.
      status: c.id.includes('3.12.4') ? 'MET' : 'NOT_MET',
      implementationNotes: 'Not implemented.',
      responsibleRole: 'CISO',
      lastUpdated: '2026-09-14',
      tags: [],
    };
  }
  const zeroScore = calculateSprsScore(CMMC_LEVEL_2_CONTROLS, zeroControlStates, SSP_META);
  assert(zeroScore.score === -203, 'all 109 weighted requirements unmet yields exactly -203 SPRS score');
  assert(zeroScore.totalDeductions === 313, 'total possible deduction is 313');
  assert(zeroScore.metCount === 1, 'only the SSP requirement (3.12.4) is met');
  assert(zeroScore.minScore === -203, 'minScore is -203');

  // 2.4.2 DoD Assessment Methodology v1.2.1 Annex A distribution: 44 x 5, 14 x 3, 51 x 1, plus 3.12.4 (NA)
  let count5 = 0;
  let count3 = 0;
  let count1 = 0;
  let count0 = 0;
  for (const c of CMMC_LEVEL_2_CONTROLS) {
    const w = getSprsPointDeduction(c.id);
    if (w === 5) count5++;
    else if (w === 3) count3++;
    else if (w === 1) count1++;
    else count0++;
  }
  assert(count5 === 44, `Exactly 44 controls carry 5-point weight (found: ${count5})`);
  assert(count3 === 14, `Exactly 14 controls carry 3-point weight (found: ${count3})`);
  assert(count1 === 51, `Exactly 51 controls carry 1-point weight (found: ${count1})`);
  assert(count0 === 1, `Exactly 1 control (3.12.4 SSP) carries no point value (found: ${count0})`);
  assert(count5 + count3 + count1 + count0 === 110, 'All 110 CMMC Level 2 controls accounted for');
  assert(count5 * 5 + count3 * 3 + count1 === 313, 'weights sum to 313 (= 110 - (-203))');

  // 2.5 eMASS Control Matrix CSV Generator
  const sampleMeta: ReportMetadata = {
    systemName: 'Vanguard Tactical Enclave',
    organizationName: 'Vanguard Defense Solutions',
    cageCode: '9X7B4',
    samStatus: 'ACTIVE',
    systemOwner: 'Devin Erickson',
    primaryAssessor: 'Lead Assessor Chen',
    boundaryDescription: 'Hybrid cloud enclave boundary',
    systemEnvironment: 'GCC High & GCS',
    operationalStatus: 'Operational',
    cloudServiceProviders: 'Google Cloud, Microsoft 365',
    classificationLevel: 'UNCLASSIFIED // CUI',
    assessmentDate: '2026-09-14',
    version: '1.0.0',
    framework: 'CMMC_L2',
  };

  const emassCsv = generateEmassControlMatrixCsv(CMMC_LEVEL_2_CONTROLS, multiDeficientStates, sampleMeta);
  assert(emassCsv.includes('"System ID / Name","CAGE Code","Control ID"'), 'eMASS CSV contains expected headers');
  assert(emassCsv.includes('"9X7B4"'), 'eMASS CSV contains tenant CAGE code');
  assert(emassCsv.includes('"Implemented"'), 'eMASS CSV tracks implemented controls');
  assert(emassCsv.includes('"Planned / In Progress"'), 'eMASS CSV tracks in-progress controls');

  // SP1: SPRS applies to CMMC Level 2 only; the eMASS CSV notes follow
  assert(sprsAppliesTo('CMMC_L2') === true, 'SP1: sprsAppliesTo(CMMC_L2) is true');
  assert(
    [ 'CMMC_L1', 'NIST_800_53_REV5', 'SOC_2_TYPE_II', 'HIPAA_SECURITY', undefined, null ].every((f) => sprsAppliesTo(f) === false),
    'SP1: sprsAppliesTo is false for every other framework and for undefined / null'
  );
  assert(emassCsvNotes('CMMC_L2').length === 1, 'SP1: CMMC L2 eMASS notes: 1 note');
  const l1Notes = emassCsvNotes('CMMC_L1');
  assert(l1Notes.length === 2 && l1Notes[1].includes('SPRS Weight'), 'SP1: CMMC L1 eMASS notes: 2 notes, the second about SPRS Weight');
  const nistNotes = emassCsvNotes('NIST_800_53_REV5');
  assert(nistNotes.length === 3 && nistNotes[2].includes('800-171 Ref'), 'SP1: NIST 800-53 eMASS notes: 3 notes, the third about 800-171 Ref');

  // SP2: the CMMC L2 CSV still carries the point weights
  assert(emassCsv.includes(',"-5",'), 'SP2: CMMC L2 eMASS CSV still has a "-5" weight cell for an unmet 5-point control');
  assert(!emassCsv.includes('"N/A","Not Implemented"'), 'SP2: CMMC L2 eMASS CSV has no N/A weight cell');

  // SP3: eMASS CSV for another framework: one row per control, SPRS Weight and 800-171 Ref read N/A
  const nistControls = getFrameworkControls('NIST_800_53_REV5', 'MOD_MOD_MOD');
  const nistCsv = generateEmassControlMatrixCsv(nistControls, {}, { ...sampleMeta, framework: 'NIST_800_53_REV5' });
  const nistLines = nistCsv.split('\r\n');
  assert(nistLines.length - 2 === nistControls.length, `SP3: NIST 800-53 eMASS CSV has one data row per control (${nistLines.length - 2} / ${nistControls.length})`);
  assert(!nistCsv.includes('"-1"') && !nistCsv.includes('"-3"') && !nistCsv.includes('"-5"'), 'SP3: NIST 800-53 eMASS CSV has no negative SPRS weight cell');
  assert(nistLines.slice(1, -1).every((l) => l.includes('"Not Implemented","N/A",')), 'SP3: NIST 800-53 eMASS CSV SPRS Weight cells all read N/A');
  assert(nistLines.slice(1, -1).every((l) => l.includes(',"N/A","') && /^"[^"]*(?:""[^"]*)*","[^"]*(?:""[^"]*)*","[^"]*(?:""[^"]*)*","N\/A",/.test(l)), 'SP3: NIST 800-53 eMASS CSV 800-171 Ref cells all read N/A');

  // SP3b: CMMC L1 maps to 800-171 but has no SPRS weights
  const l1Controls = getFrameworkControls('CMMC_L1');
  const l1Csv = generateEmassControlMatrixCsv(l1Controls, {}, { ...sampleMeta, framework: 'CMMC_L1' });
  const l1Rows = l1Csv.split('\r\n').slice(1, -1);
  assert(l1Rows.length === l1Controls.length, 'SP3b: CMMC L1 eMASS CSV has one data row per control');
  assert(l1Rows.every((l) => l.includes('"Not Implemented","N/A",')), 'SP3b: CMMC L1 eMASS CSV SPRS Weight cells all read N/A');
  assert(!l1Rows.every((l) => /^"[^"]*(?:""[^"]*)*","[^"]*(?:""[^"]*)*","[^"]*(?:""[^"]*)*","N\/A",/.test(l)), 'SP3b: CMMC L1 eMASS CSV 800-171 Ref is not N/A');

  // SP4 / EX: the export modal gates SPRS on the framework and reports a failed JSON export without leaking the error
  const modalSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'reports', 'ArtifactExportModal.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert(modalSrc.includes('sprsAppliesTo(activeFramework)'), 'SP4: modal derives sprsApplies from the active framework');
  assert(modalSrc.includes("{sprsApplies ? 'SPRS / eMASS' : 'eMASS'}"), 'SP4: modal tab label depends on sprsApplies');
  assert(modalSrc.includes("activeTab === 'sprs' && !sprsApplies"), 'SP4: modal has an eMASS-only panel for non-L2 frameworks');
  assert(modalSrc.includes('downloadEmassCsv(frameworkControls, state.controls, formData)'), 'SP4: modal still offers the eMASS CSV download');
  const modalConsoleLines = modalSrc.split('\n').filter((l) => /console\.\w+\(/.test(l));
  assert(modalConsoleLines.every((l) => !/\berr\b|errorMessage\(|err\.message/.test(l)), 'EX-L1: no console line in the modal passes an error');
  assert(modalSrc.includes('<ErrorNotice message={jsonExportError}') && !modalSrc.includes('Failed to export JSON package'), 'EX-L2: modal shows a fixed-text ErrorNotice for a failed JSON export');
  assert(modalConsoleLines.length === 0, `EX-L3: the modal has no console lines (found: ${modalConsoleLines.length})`);

  // 2.6 Official SPRS Assessment Summary
  const sprsSummary = generateSprsAssessmentSummary(CMMC_LEVEL_2_CONTROLS, multiDeficientStates, sampleMeta);
  assert(sprsSummary.sprsSubmissionHeader.platform.includes('Event Horizon: Singularity'), 'SPRS summary includes platform name');
  assert(sprsSummary.sprsMetrics.activeSprsScore === 101, 'SPRS summary records active score 101');
  assert(sprsSummary.organizationProfile.cageCode === '9X7B4', 'SPRS summary records CAGE code');

  // ==========================================================================
  // SECTION 3: DFARS 252.204-7012 DATA RETENTION & CRYPTOGRAPHIC WIPE
  // ==========================================================================
  console.log('\n--- Test Group 3: DFARS 252.204-7012 Retention & Cryptographic Sanitization ---');

  // 3.1 Minimum Retention Policy
  assert(MIN_RETENTION_DAYS === 1095, 'Minimum audit retention is 1095 days (3 years)');

  // 3.2 Evidence is stored on local disk only: the retention module carries no cloud lifecycle or object-lock helpers
  assert(!('generateGcsLifecyclePolicy' in retentionModule) && !('calculateObjectRetentionHeaders' in retentionModule), 'Retention module exports no cloud lifecycle or object-lock helpers');
  assert(Object.keys(retentionModule).every((k) => !/gcs|bucket|objectretention/i.test(k)), 'Retention module exports nothing cloud-specific');

  // 3.3 Cryptographic Tenant Data Wipe & Certificate of Destruction
  const destructionCert = await purgeTenantData({
    tenantId: testTenant,
    systemName: 'Vanguard Tactical Enclave',
    cageCode: '9X7B4',
    actorName: 'Alex Mercer',
    actorEmail: 'alex.mercer@vanguard-defense.us',
  });

  assert(destructionCert.certificateId.startsWith('CERT-DEST-'), 'Certificate ID has CERT-DEST- prefix');
  assert(destructionCert.sanitizationMethod.includes('Cryptographic Erase'), 'Method is Cryptographic Erase');
  assert(destructionCert.complianceStandard === 'DFARS 252.204-7012', 'Standard is DFARS 252.204-7012');
  assert(destructionCert.certificateSha256.length === 64, 'Certificate includes 64-char SHA-256 signature');

  // 3.4 Verification that destruction was recorded in audit ledger
  const postWipeLogs = getAuditLogs(testTenant);
  const wipeEntry = postWipeLogs.find(l => l.actionType === 'CRYPTOGRAPHIC_WIPE_PERFORMED');
  assert(wipeEntry !== undefined, 'Destruction event recorded in immutable audit ledger');
  assert(wipeEntry?.metadata?.certificateId === destructionCert.certificateId, 'Audit entry references certificate ID');

  // Verify full chain remains cryptographically valid after wipe entry
  const postWipeVerification = await verifyAuditChain(postWipeLogs);
  assert(postWipeVerification.isValid === true, 'Audit chain remains 100% cryptographically valid with wipe block appended');

  // ==========================================================================
  // SUMMARY
  // ==========================================================================
  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passCount} / ${passCount + failCount} TESTS PASSED (${Math.round((passCount / (passCount + failCount)) * 100)}%)`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
