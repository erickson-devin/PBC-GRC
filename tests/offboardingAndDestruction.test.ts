/**
 * Enclave Offboarding, NIST SP 800-88 Cryptographic Destruction & Lifecycle Test Suite
 * Validates Super Admin offboarding export, 3-pass cryptographic wipe, and certificate generation.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { Tenant } from '../src/types/tenant';
import {
  generateEnclaveHandoverPackage,
  executeCryptographicDestruction,
} from '../src/data/storage/offboardingEngine';
import { buildProgramHandover } from '../src/data/storage/offboardingPrograms';
import { programFrameworkControls, scopingToOverlays } from '../src/data/programScope';
import { getFrameworkControls } from '../src/data/frameworks';
import { readBrowserOverlayFilters } from '../src/data/browserOverlays';
import type { Program } from '../src/types/program';
import { computeSha256, canonicalJson } from '../src/data/audit/auditLogger';
import { boundaryNarrative, summarizeScope } from '../src/data/telemetry/assetScope';
import { createInitialState } from '../src/services/storageService';
import { NO_CSP_RECORDED } from '../src/data/reports/documentCompilers';
import { NOT_RECORDED, NO_BOUNDARY_RECORDED, NO_ASSESSOR_RECORDED } from '../src/data/reports/documentDefaults';
import { copyText } from '../src/utils/clipboard';

// Polyfill minimal localStorage for Node environment if absent
if (typeof (global as any).localStorage === 'undefined') {
  const store: Record<string, string> = {};
  (global as any).localStorage = {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  };
}
if (typeof (global as any).window === 'undefined') {
  (global as any).window = { localStorage: (global as any).localStorage };
}

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ PASS: ${testName}`);
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    if (detail) {
      console.error(`     Detail: ${detail}`);
    }
  }
}

async function runTests() {
  console.log('====================================================================');
  console.log('🧪 EVENT HORIZON: ENCLAVE OFFBOARDING & NIST SP 800-88 TEST SUITE');
  console.log('====================================================================\n');

  const testTenant: Tenant = {
    id: 'tenant-vanguard-01',
    name: 'Vanguard Defense Systems LLC',
    cageCode: '8K3R1',
    samStatus: 'ACTIVE',
    systemName: 'Defense Contracting Information Network (DCIN)',
    systemOwner: 'Alex Mercer, CMMC CCA',
    industry: 'Defense IT & Systems Integration',
    domain: 'vanguard-defense.us',
    createdAt: '2026-01-15T08:00:00.000Z',
    updatedAt: '2026-01-15T08:00:00.000Z',
    isConfigured: true,
    primaryFramework: 'CMMC_L1',
    enabledFrameworks: ['CMMC_L1', 'CMMC_L2'],
  };

  // Test Group 1: Offboarding Handover Package Compilation
  console.log('📦 Test Group 1: Compliance Offboarding Handover Package Compilation');
  {
    const handoverPackage = await generateEnclaveHandoverPackage(testTenant.id, testTenant);

    assert(
      handoverPackage.schemaVersion === '2.0.0',
      'Package schema version is 2.0.0',
      `Got ${handoverPackage.schemaVersion}`
    );

    assert(
      handoverPackage.packageType === 'DEFENSE_ENCLAVE_OFFBOARDING_HANDOVER',
      'Package type is DEFENSE_ENCLAVE_OFFBOARDING_HANDOVER',
      `Got ${handoverPackage.packageType}`
    );

    assert(
      handoverPackage.tenant.id === testTenant.id && handoverPackage.tenant.name === testTenant.name,
      'Package contains matching tenant metadata and legal name'
    );

    assert(
      Boolean(handoverPackage.reports.systemSecurityPlan),
      'Package includes compiled NIST SP 800-18 System Security Plan (SSP)'
    );

    assert(
      handoverPackage.reports.systemSecurityPlan.sections.length > 0,
      'Compiled SSP contains operational security sections'
    );

    assert(
      Array.isArray(handoverPackage.reports.poamMatrix),
      'Package includes structured POA&M deficiency matrix'
    );

    assert(
      Array.isArray(handoverPackage.evidenceIndex),
      'Package includes evidence metadata index'
    );

    assert(
      Array.isArray(handoverPackage.auditLedger),
      'Package includes cryptographic audit ledger'
    );

    assert(
      Boolean(handoverPackage.integrityChecksum && handoverPackage.integrityChecksum.length === 64),
      'Package integrity checksum is a valid 64-character SHA-256 hash',
      `Got: ${handoverPackage.integrityChecksum}`
    );

    assert(
      handoverPackage.retentionStandard.includes('DFARS 252.204-7012'),
      'Package declares DFARS 252.204-7012 audit retention standard'
    );
  }

  // Test Group 1b: server control states reach the handover package
  console.log('\n🗄️ Test Group 1b: Server Control States in the Handover Package');
  {
    const base = { responsibleRole: 'Owner', lastUpdated: '2026-01-01T00:00:00.000Z', tags: [] as string[] };
    const states = {
      'AC.L1-3.1.1': { ...base, id: 'AC.L1-3.1.1', status: 'MET' as const, implementationNotes: 'SERVER-NOTES-MARKER-55' },
    };
    const withStates = await generateEnclaveHandoverPackage(testTenant.id, testTenant, undefined, states);
    const without = await generateEnclaveHandoverPackage(testTenant.id, testTenant);

    assert(
      JSON.stringify(withStates.reports.systemSecurityPlan).includes('SERVER-NOTES-MARKER-55'),
      'O1: server implementation notes appear in the SSP when controlStates is provided'
    );
    assert(
      !JSON.stringify(without.reports.systemSecurityPlan).includes('SERVER-NOTES-MARKER-55'),
      'O2: SSP does not include the notes when controlStates is omitted'
    );

    const notMet = { ...states, 'AC.L1-3.1.1': { ...states['AC.L1-3.1.1'], status: 'NOT_MET' as const } };
    const overridden = await generateEnclaveHandoverPackage(testTenant.id, testTenant, undefined, notMet);
    assert(
      overridden.complianceSummary.notMetCount !== withStates.complianceSummary.notMetCount
        || overridden.complianceSummary.metCount !== withStates.complianceSummary.metCount,
      'O3: controlStates overrides the cached status in the report summary',
      `met ${withStates.complianceSummary.metCount}->${overridden.complianceSummary.metCount}, notMet ${withStates.complianceSummary.notMetCount}->${overridden.complianceSummary.notMetCount}`
    );
  }

  // Test Group 1c: a live tenant's evidence list comes from the server, not the browser cache
  console.log('\n🗂️ Test Group 1c: Server Evidence List in the Handover Package');
  {
    const srvTenant: Tenant = { ...testTenant, id: 'tenant-srv-evidence-01', serverBacked: true };
    const cached = createInitialState(srvTenant);
    cached.evidenceIndex = [{ id: 'ev-cached-1', tenantId: srvTenant.id, fileName: 'cached.pdf' } as any];
    localStorage.setItem(`pbc_cmmc_assessment_v3_${srvTenant.id}`, JSON.stringify(cached));

    const serverItem = { id: 'ev-srv-1', tenantId: srvTenant.id, fileName: 'server.pdf' } as any;
    const withList = await generateEnclaveHandoverPackage(srvTenant.id, srvTenant, undefined, undefined, [serverItem]);
    assert(
      withList.evidenceIndex.length === 1 && withList.evidenceIndex[0].id === 'ev-srv-1' && withList.complianceSummary.evidenceItemsCount === 1,
      'OB-E1: the evidence list passed in is the one the package holds'
    );
    const withoutList = await generateEnclaveHandoverPackage(srvTenant.id, srvTenant);
    assert(
      withoutList.evidenceIndex.length === 0 && withoutList.complianceSummary.evidenceItemsCount === 0,
      'OB-E2: a server tenant without a passed list gets none of the cached items'
    );
    const dashSrc = readFileSync(join(process.cwd(), 'src/components/admin/SuperAdminDashboard.tsx'), 'utf8').replace(/\r\n/g, '\n');
    assert(
      /ApiClient\.getEvidence\(\s*\w+,\s*\w+\)/.test(dashSrc) && /getControls\(\s*\w+,\s*undefined,\s*\w+\)/.test(dashSrc) && dashSrc.includes('generateEnclaveHandoverPackage(tenant.id, tenant, assets, undefined, undefined, { overlays: readBrowserOverlayFilters(tenant.id) })'),
      'OB-E3: SuperAdminDashboard fetches the server controls and evidence of a chosen program, and keeps the direct call for a browser-only tenant'
    );
  }

  // Test Group 1d: the handover per program (issue #27)
  console.log('\n🧭 Test Group 1d: Handover Package per Program');
  {
    const progTenant: Tenant = { ...testTenant, id: 'tenant-programs-01', serverBacked: true };
    const mk = (over: Partial<Program>): Program => ({
      id: 'p-default', name: 'Default program', description: '', framework: 'CMMC_L1', baseline: null, privacyBaseline: false, boundarySummary: '',
      scoping: {}, vmTarget: false, isDefault: true, archived: false, ...over,
    });
    const nistLow = mk({ id: 'p-nist-low', name: 'NIST Low', framework: 'NIST_800_53_REV5', baseline: 'LOW', isDefault: false });
    const opts = (program: Program) => ({ program, download: false });

    const p1 = await generateEnclaveHandoverPackage(progTenant.id, progTenant, undefined, {}, [], opts(nistLow));
    const expected1 = programFrameworkControls(nistLow, scopingToOverlays({})).length;
    assert(p1.program?.id === 'p-nist-low' && p1.complianceSummary.totalControls === expected1, 'OB-P1: a program package holds that program\'s catalog and names the program', `${p1.complianceSummary.totalControls} vs ${expected1}`);

    const withBoundary = await generateEnclaveHandoverPackage(progTenant.id, progTenant, undefined, {}, [], opts({ ...nistLow, boundarySummary: 'LAB-BOUNDARY-77' }));
    assert(JSON.stringify(withBoundary.reports.systemSecurityPlan).includes('LAB-BOUNDARY-77'), 'OB-P2: the SSP uses the program\'s boundary text');

    const noWireless = { ...nistLow, scoping: { noWireless: true as const } };
    const p3 = await generateEnclaveHandoverPackage(progTenant.id, progTenant, undefined, {}, [], opts(noWireless));
    assert(
      p3.complianceSummary.totalControls === programFrameworkControls(noWireless, scopingToOverlays(noWireless.scoping)).length && p3.complianceSummary.totalControls <= p1.complianceSummary.totalControls,
      'OB-P3: the program\'s overlays narrow its package'
    );

    const plain = await generateEnclaveHandoverPackage(testTenant.id, testTenant, undefined, undefined, undefined, { download: false });
    assert(plain.program === undefined && plain.complianceSummary.totalControls === getFrameworkControls('CMMC_L1').length, 'OB-P4: without a program the package is the tenant\'s primary framework, as before');

    // #122: the handover states no cloud provider or environment of its own
    const plainMeta = plain.reports.systemSecurityPlan.metadata;
    assert(plainMeta.cloudServiceProviders === '' && plainMeta.systemEnvironment === '', 'OB-122a: the handover SSP names no cloud provider or environment the customer did not record', { csp: plainMeta.cloudServiceProviders, env: plainMeta.systemEnvironment });
    const plain13 = (plain.reports.systemSecurityPlan.sections[0].subsections || []).find((s: { title: string }) => s.title.startsWith('1.3'));
    assert(plain13?.content === NO_CSP_RECORDED, 'OB-122b: the handover SSP section 1.3 states that no cloud service provider is recorded');

    // #151: the handover invents no organization, assessor or boundary
    const plain12 = (plain.reports.systemSecurityPlan.sections[0].subsections || []).find((s: { title: string }) => s.title.startsWith('1.2'));
    assert(plain12?.content === NO_BOUNDARY_RECORDED, 'S151-14: the handover SSP boundary says none is recorded when the customer recorded none');
    const plainItems = (plain.reports.systemSecurityPlan.sections[0].subsections || []).flatMap((s: { items?: { label: string; value: string }[] }) => s.items || []);
    assert(plainItems.find((i: { label: string }) => i.label === 'Primary Assessor / Author')?.value === NO_ASSESSOR_RECORDED, 'S151-15: the handover SSP names no assessor the customer did not record');
    const plainJson = JSON.stringify(plain);
    assert(!plainJson.includes('Pitch Black Cyber GRC Engine') && !plainJson.includes('operations and compliance boundary'), 'S151-16: the handover package carries no invented assessor or boundary text');
    const unknownCert = await executeCryptographicDestruction({ tenantId: 'tenant-unknown-151', actorName: 'A', actorEmail: 'a@b.c', clearEvidenceFiles: async () => {} });
    assert(unknownCert.systemName === NOT_RECORDED && unknownCert.cageCode === NOT_RECORDED, 'S151-17: a certificate for an unrecorded system says not recorded');
    const namedCert = await executeCryptographicDestruction({ tenantId: 'tenant-named-151', systemName: 'SYS-151', cageCode: '9Z9Z9', actorName: 'A', actorEmail: 'a@b.c', clearEvidenceFiles: async () => {} });
    assert(namedCert.systemName === 'SYS-151' && namedCert.cageCode === '9Z9Z9', 'S151-18: a certificate carries the recorded system name and CAGE code');

    // #131: a browser-only tenant's handover uses the overlays its matrix uses
    const noOverlays = JSON.stringify({ nonNetworkedOnly: false });
    assert(JSON.stringify(readBrowserOverlayFilters('tenant-no-overlays-01')) === noOverlays, 'OB-P11: a tenant with no saved overlays reads all off');
    localStorage.setItem('pbc_overlay_filters_tenant-ov-01', JSON.stringify({ noWireless: true }));
    const stored = readBrowserOverlayFilters('tenant-ov-01') as any;
    assert(stored.noWireless === true && Object.keys(stored).length === 4, 'OB-P12: saved overlays read back as the full four-key object', JSON.stringify(stored));
    localStorage.setItem('pbc_overlay_filters_tenant-ov-bad', '{not json');
    assert(JSON.stringify(readBrowserOverlayFilters('tenant-ov-bad')) === noOverlays, 'OB-P13: unreadable saved overlays fall back to all off');

    const ov = { nonNetworkedOnly: false, noWireless: true };
    const nistBrowser: Tenant = { ...testTenant, id: 'tenant-browser-nist-01', primaryFramework: 'NIST_800_53_REV5', enabledFrameworks: ['NIST_800_53_REV5'] };
    const p13 = await generateEnclaveHandoverPackage(nistBrowser.id, nistBrowser, undefined, undefined, undefined, { download: false, overlays: ov });
    const p13Unfiltered = getFrameworkControls('NIST_800_53_REV5', 'ALL_CONTROLS', { nonNetworkedOnly: false }).length;
    const p13Expected = getFrameworkControls('NIST_800_53_REV5', 'ALL_CONTROLS', ov).length;
    assert(p13.complianceSummary.totalControls === p13Expected && p13Expected < p13Unfiltered, 'OB-P14: a browser-only NIST handover applies the tenant\'s overlays', `${p13.complianceSummary.totalControls} vs ${p13Expected} of ${p13Unfiltered}`);

    const cmmcBrowser: Tenant = { ...testTenant, id: 'tenant-browser-cmmc-01', primaryFramework: 'CMMC_L2', enabledFrameworks: ['CMMC_L2'] };
    const p15 = await generateEnclaveHandoverPackage(cmmcBrowser.id, cmmcBrowser, undefined, undefined, undefined, { download: false, overlays: ov });
    assert(p15.complianceSummary.totalControls === getFrameworkControls('CMMC_L2').length, 'OB-P15: overlays do not change a CMMC browser-only handover');

    const p16 = await generateEnclaveHandoverPackage(progTenant.id, progTenant, undefined, {}, [], { program: nistLow, download: false, overlays: ov });
    assert(p16.complianceSummary.totalControls === expected1, 'OB-P16: a program wins over the browser overlays', `${p16.complianceSummary.totalControls} vs ${expected1}`);

    const freshId = 'tenant-programs-nocache-01';
    await generateEnclaveHandoverPackage(freshId, { ...progTenant, id: freshId }, undefined, {}, [], opts(nistLow));
    assert(localStorage.getItem(`pbc_cmmc_assessment_v3_${freshId}`) === null, 'OB-P5: a program package neither reads nor writes the browser cache');

    // Fake server: records what is asked
    const programs = [
      mk({ id: 'p-b', name: 'Second', isDefault: false, archived: true }),
      mk({ id: 'p-a', name: 'First', isDefault: true }),
    ];
    const controlCalls: string[] = [];
    const evidenceCalls: string[] = [];
    const deps = {
      listPrograms: async () => programs,
      getControls: async (_t: string, p: string) => { controlCalls.push(p); return []; },
      getEvidence: async (_t: string, p: string) => { evidenceCalls.push(p); return [{ id: `ev-${p}`, tenantId: progTenant.id, fileName: 'f.pdf' } as any]; },
    };
    const all = await buildProgramHandover(progTenant, { kind: 'all' }, undefined, deps);
    assert(
      all.packages.length === 2 && all.packages[0].program?.id === 'p-a' && all.packages[1].program?.archived === true
        && controlCalls.join() === 'p-a,p-b' && all.bundle?.integrityChecksum.length === 64 && all.bundle.programCount === 2,
      'OB-P6: "all programs" builds one package per program (default first, archived flagged) and one bundle',
      controlCalls.join()
    );

    controlCalls.length = 0;
    evidenceCalls.length = 0;
    const one = await buildProgramHandover(progTenant, { kind: 'program', programId: 'p-b' }, undefined, deps);
    assert(
      one.packages.length === 1 && one.bundle === null && controlCalls.join() === 'p-b' && one.packages[0].evidenceIndex[0]?.id === 'ev-p-b' && evidenceCalls.join() === 'p-b',
      'OB-P7: one program fetches only its own controls and evidence'
    );

    // OB-P10: the package states the program's declared assets, or the whole inventory while it declares none (issue #26)
    const bAssets = [
      { id: 'a1', hostName: 'H1', cmmcAssetCategory: 'CUI_ASSET' },
      { id: 'a2', hostName: 'H2', cmmcAssetCategory: 'CUI_ASSET' },
    ] as any[];
    const declaredNarrative = boundaryNarrative(summarizeScope([bAssets[0]]));
    const wholeNarrative = boundaryNarrative(summarizeScope(bAssets));
    const declaredPkg = await buildProgramHandover(progTenant, { kind: 'program', programId: 'p-a' }, bAssets, {
      ...deps, getProgramAssets: async () => ({ declared: true, assetIds: ['a1'] }),
    });
    const undeclaredPkg = await buildProgramHandover(progTenant, { kind: 'program', programId: 'p-a' }, bAssets, {
      ...deps, getProgramAssets: async () => ({ declared: false, assetIds: [] }),
    });
    assert(
      declaredNarrative !== wholeNarrative
        && JSON.stringify(declaredPkg.packages[0].reports.systemSecurityPlan).includes(declaredNarrative)
        && JSON.stringify(undeclaredPkg.packages[0].reports.systemSecurityPlan).includes(wholeNarrative),
      'OB-P10: a declared program states only its assets; an undeclared one states the whole inventory'
    );
    let failedClosed: unknown = null;
    try {
      await buildProgramHandover(progTenant, { kind: 'program', programId: 'p-a' }, bAssets, { ...deps, getProgramAssets: async () => { throw new Error('boom'); } });
    } catch (err) { failedClosed = err; }
    assert(failedClosed instanceof Error, 'OB-P10b: if the declared assets cannot be read the export rejects (no package with the wrong boundary)');

    // #84: a program's package states that program's own SSP details from the server
    const mPkg = await generateEnclaveHandoverPackage(progTenant.id, progTenant, undefined, {}, [], {
      program: nistLow, download: false, sspMetadata: { systemEnvironment: 'ENV-84', cloudServiceProviders: 'CSP-84', systemBoundaryScope: 'BOUNDARY-84' },
    });
    const mMeta = mPkg.reports.systemSecurityPlan.metadata;
    assert(mMeta.systemEnvironment === 'ENV-84' && mMeta.cloudServiceProviders === 'CSP-84', 'OB-M1: a program package carries the SSP environment and cloud providers it was given', JSON.stringify({ env: mMeta.systemEnvironment, csp: mMeta.cloudServiceProviders }));
    assert(JSON.stringify(mPkg.reports.systemSecurityPlan).includes('BOUNDARY-84'), 'OB-M1b: the server\'s SSP boundary text wins over the tenant\'s');
    const sspCalls: string[] = [];
    const sspByProgram: Record<string, { metadata: Record<string, string> | null }> = {
      'p-a': { metadata: { systemEnvironment: 'ENV-A', cloudServiceProviders: 'CSP-A' } },
      'p-b': { metadata: { systemEnvironment: 'ENV-B', cloudServiceProviders: 'CSP-B' } },
    };
    const mAll = await buildProgramHandover(progTenant, { kind: 'all' }, undefined, {
      ...deps, getSspMetadata: async (_t: string, p: string) => { sspCalls.push(p); return sspByProgram[p]; },
    });
    const mEnv = (i: number) => mAll.packages[i].reports.systemSecurityPlan.metadata;
    assert(
      sspCalls.join() === 'p-a,p-b' && mEnv(0).systemEnvironment === 'ENV-A' && mEnv(0).cloudServiceProviders === 'CSP-A' && mEnv(1).systemEnvironment === 'ENV-B' && mEnv(1).cloudServiceProviders === 'CSP-B',
      'OB-M2: every program of the bundle carries its own SSP details, and each program is asked for them', sspCalls.join()
    );
    const mNone = await buildProgramHandover(progTenant, { kind: 'program', programId: 'p-a' }, undefined, deps);
    const mNoneMeta = mNone.packages[0].reports.systemSecurityPlan.metadata;
    assert(mNoneMeta.systemEnvironment === '' && mNoneMeta.cloudServiceProviders === '', 'OB-M3: without a way to read the SSP details the package states none (OB-122a still holds)');
    let sspFailed: unknown = null;
    try {
      await buildProgramHandover(progTenant, { kind: 'program', programId: 'p-a' }, undefined, { ...deps, getSspMetadata: async () => { throw new Error('boom'); } });
    } catch (err) { sspFailed = err; }
    assert(sspFailed instanceof Error, 'OB-M4: if the SSP details cannot be read the export rejects');

    let notFound: unknown = null;
    try { await buildProgramHandover(progTenant, { kind: 'program', programId: 'nope' }, undefined, deps); } catch (err) { notFound = err; }
    assert(notFound instanceof Error && /not found/.test(notFound.message), 'OB-P8: an unknown program rejects with "not found"');

    if (all.bundle) {
      const { integrityChecksum, ...rest } = all.bundle;
      assert(await computeSha256(canonicalJson(rest)) === integrityChecksum, 'OB-P9: the bundle checksum covers everything but itself');
    } else {
      assert(false, 'OB-P9: the bundle checksum covers everything but itself');
    }

    const dialogSrc = readFileSync(join(process.cwd(), 'src/components/admin/OffboardingProgramDialog.tsx'), 'utf8');
    const dashSrc2 = readFileSync(join(process.cwd(), 'src/components/admin/SuperAdminDashboard.tsx'), 'utf8');
    assert(dashSrc2.includes('OffboardingProgramDialog') && dashSrc2.includes('buildProgramHandover('), 'OB-U1: the dashboard opens the program chooser and builds the handover per program');
    assert(dialogSrc.includes('<DialogOverlay') && dialogSrc.includes('includeArchived: true') && dialogSrc.includes('<legend'), 'OB-U2: the chooser is a dialog with a legend, listing archived programs too');
    assert(!/console\./.test(dialogSrc), 'OB-U3: the chooser logs nothing');
    assert(dialogSrc.includes('You are not a member of this tenant') && dashSrc2.includes('NOT_MEMBER_MESSAGE'), 'OB-U4: the not-a-member text is still shown');

    // #134: the dashboard logs an error's name only and shows fixed texts
    const dashNorm = dashSrc2.replace(/\r\n/g, '\n');
    const nameOnly = `err instanceof Error ? err.name : 'unknown error'`;
    const consoleLines = dashNorm.split('\n').filter((l) => /console\.\w+\(/.test(l));
    assert(
      consoleLines.length > 0 && consoleLines.every((l) => !/\berr\b|errorMessage\(|err\.message/.test(l.split(nameOnly).join(''))),
      'OB-L1: no console line of the dashboard carries a raw error'
    );
    assert(
      dashNorm.includes(`console.error('Failed to export offboarding package:', ${nameOnly});`)
        && dashNorm.includes(`console.error('Cryptographic destruction failed:', ${nameOnly});`),
      'OB-L2: the two dashboard error logs state the error name only'
    );
    assert(
      !dashNorm.includes('Failed to export offboarding package: ${errorMessage(err)') && !dashNorm.includes('Destruction protocol failed: ${errorMessage(err)'),
      'OB-L3: the export and destruction toasts no longer show raw error text'
    );
    const engineSrc = readFileSync(join(process.cwd(), 'src/data/storage/offboardingEngine.ts'), 'utf8');
    assert(
      /export const EVIDENCE_CLEAR_FAILED_MESSAGE\b/.test(engineSrc) && /import \{[^}]*EVIDENCE_CLEAR_FAILED_MESSAGE[^}]*\} from '..\/..\/data\/storage\/offboardingEngine'/.test(dashNorm),
      'OB-L4: the engine exports the evidence-clear message and the dashboard imports it'
    );
    assert(
      dashNorm.includes('<ErrorNotice message={destructionError}')
        && dashNorm.includes("role={notificationToast.type === 'error' ? 'alert' : 'status'}")
        && dashNorm.includes('z-[70]')
        && dashNorm.includes('aria-label="Dismiss notification"'),
      'OB-L5: a failed destruction is shown inside the dialog and the toast is an announced, dismissible alert above dialogs'
    );
    assert(
      dashNorm.includes('The invitation link could not be copied')
        && dashNorm.includes('The enclave ID could not be copied')
        && dashNorm.includes('A new invitation link was created but could not be copied'),
      'OB-L6: clipboard failures name what could not be copied, and resend does not claim a copy that failed'
    );
    assert(
      /if \(notificationToast && notificationToast\.type !== 'error'\)/.test(dashNorm),
      'OB-L7: error toasts are not auto-dismissed'
    );

    // #141: the team modal and the dashboard copy through copyText, which never throws and never logs
    const teamNorm = readFileSync(join(process.cwd(), 'src/components/settings/TeamSettingsModal.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const clipNorm = readFileSync(join(process.cwd(), 'src/utils/clipboard.ts'), 'utf8').replace(/\r\n/g, '\n');
    assert(!teamNorm.includes('navigator.clipboard') && !teamNorm.includes('copyToClipboard(') && teamNorm.includes('copyText('), 'S141-1: the team modal has no bare navigator.clipboard and copies through copyText');
    assert(teamNorm.includes('The link could not be copied. Select and copy it from the field.'), 'S141-2: the team modal states a failed copy in fixed text');
    assert(teamNorm.includes('readOnly') && teamNorm.includes('value={copyFailedUrl}') && teamNorm.includes('htmlFor="team-invite-link-fallback"'), 'S141-3: the link is shown in a labelled read-only field');
    assert(!/console\./.test(teamNorm) && !teamNorm.includes("'New invitation link created: ' +"), 'S141-4: the team modal logs nothing and never puts the link into a notice');
    assert(dashNorm.includes('copyText(') && !dashNorm.includes('copyToClipboard(') && !dashNorm.includes('Clipboard write failed'), 'S141-5: the dashboard copies through copyText and logs no clipboard failure');
    const copyTextBody = clipNorm.slice(clipNorm.indexOf('export async function copyText'));
    assert(/export async function copyText\(text: string\): Promise<boolean>/.test(clipNorm) && !copyTextBody.includes('console.'), 'S141-6: copyText returns a boolean and logs nothing');

    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, HTMLElement: g.HTMLElement, log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    const logged: string[] = [];
    const capture = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    const secret = 'https://grc.local/#accept-invite?token=S141-SECRET';
    let execResult = true;
    const field = { value: '', setAttribute() {}, style: { cssText: '' }, focus() {}, select() {}, setSelectionRange() {}, remove() {} };
    let noDom: boolean | string, copied: boolean | string, refused: boolean | string;
    console.log = console.warn = console.error = console.info = console.debug = capture;
    try {
      noDom = await copyText(secret).catch(() => 'rejected');
      g.HTMLElement = class {};
      g.document = { createElement: () => field, body: { appendChild() {} }, activeElement: null, execCommand: () => execResult };
      copied = await copyText(secret).catch(() => 'rejected');
      execResult = false;
      refused = await copyText(secret).catch(() => 'rejected');
    } finally {
      Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error, info: saved.info, debug: saved.debug });
      if (saved.document === undefined) delete g.document; else g.document = saved.document;
      if (saved.HTMLElement === undefined) delete g.HTMLElement; else g.HTMLElement = saved.HTMLElement;
    }
    assert(noDom === false, 'S141-7: with no clipboard and no DOM, copyText resolves false instead of rejecting');
    assert(copied === true, 'S141-8: when the fallback copy succeeds, copyText resolves true');
    assert(refused === false, 'S141-9: when the browser refuses the copy, copyText resolves false');
    assert(logged.length === 0 && !logged.some(l => l.includes('S141-SECRET')), 'S141-10: copyText writes nothing to the console, least of all the text');
    assert(
      dashSrc2.includes('getProgramAssets: (t, p) => ApiClient.getProgramAssets(t, p)') && dialogSrc.includes('declared its assets') && !dialogSrc.includes('Each package states the whole asset inventory'),
      'OB-U5: the handover follows the program\'s declared assets (the dashboard reads them, the chooser says so)'
    );
  }

  // Test Group 2: NIST SP 800-88 Cryptographic Sanitization & Destruction Protocol
  console.log('\n🔥 Test Group 2: NIST SP 800-88 Cryptographic Destruction Protocol');
  {
    const mockTenantId = 'tenant-decom-alpha-09';
    const mockTenant = {
      ...testTenant,
      id: mockTenantId,
      name: 'Alpha Decommissioned Defense Corp',
      cageCode: '1A2B3',
    };

    const cert = await executeCryptographicDestruction({
      tenantId: mockTenant.id,
      systemName: mockTenant.systemName,
      cageCode: mockTenant.cageCode,
      actorName: 'Devin Erickson',
      actorEmail: 'devin@pitchblackcyber.com',
    });

    assert(
      Boolean(cert.certificateId && cert.certificateId.startsWith('CERT-DEST-')),
      'Certificate of Destruction generated with canonical CERT-DEST prefix',
      `Got: ${cert.certificateId}`
    );

    assert(
      cert.tenantId === mockTenantId,
      'Certificate scopes destroyed tenant enclave ID accurately'
    );

    assert(
      cert.cageCode === '1A2B3',
      'Certificate records accurate CAGE code for DoD compliance tracking'
    );

    assert(
      cert.sanitizationMethod.includes('Cryptographic Erase'),
      'Sanitization method complies with NIST SP 800-88 Cryptographic Erase standard'
    );

    assert(
      cert.complianceStandard.includes('DFARS 252.204-7012'),
      'Destruction certificate references DFARS 252.204-7012 compliance standard'
    );

    assert(
      cert.purgedObjectsCount > 0,
      `Purged objects count reflects total sanitized records (count: ${cert.purgedObjectsCount})`
    );

    assert(
      Boolean(cert.certificateSha256 && cert.certificateSha256.length === 64),
      'Certificate of Destruction contains valid 64-character SHA-256 tamper-evident digest',
      `Got: ${cert.certificateSha256}`
    );
  }

  // Test Group 2b: browser evidence files are cleared first, and destruction fails closed
  console.log('\n🧹 Test Group 2b: Evidence File Clearing (fail closed)');
  {
    const base = { actorName: 'Devin Erickson', actorEmail: 'devin@pitchblackcyber.com' };

    const calls: string[] = [];
    let certReturned = false;
    const okCert = await executeCryptographicDestruction({
      ...base,
      tenantId: 'tenant-evidence-spy',
      clearEvidenceFiles: async (id) => { calls.push(id); },
    });
    certReturned = Boolean(okCert.certificateId);
    assert(
      calls.length === 1 && calls[0] === 'tenant-evidence-spy' && certReturned,
      'OD1: evidence clearing is called once with the tenant id and the certificate is still issued',
      `calls=${JSON.stringify(calls)}`
    );

    let threw: unknown = null;
    let failCert: unknown = null;
    try {
      failCert = await executeCryptographicDestruction({
        ...base,
        tenantId: 'tenant-evidence-fail',
        clearEvidenceFiles: async () => { throw new Error('idb down'); },
      });
    } catch (err) {
      threw = err;
    }
    assert(
      failCert === null && threw instanceof Error && /no Certificate of Destruction was issued/.test(threw.message),
      'OD2: a failing evidence clear issues no certificate and surfaces an error',
      String(threw)
    );

    let noIdbCert: { certificateId?: string } | null = null;
    let noIdbErr: unknown = null;
    try {
      noIdbCert = await executeCryptographicDestruction({ ...base, tenantId: 'tenant-evidence-noidb' });
    } catch (err) {
      noIdbErr = err;
    }
    assert(
      typeof (globalThis as any).indexedDB === 'undefined' && noIdbErr === null && Boolean(noIdbCert?.certificateId),
      'OD3: without indexedDB and without an injected function there is nothing to clear and the certificate is issued',
      String(noIdbErr)
    );

    const engineSrc = readFileSync(join(process.cwd(), 'src/data/storage/offboardingEngine.ts'), 'utf8');
    assert(
      !engineSrc.includes('pbc_evidence_${'),
      'OD4: offboardingEngine no longer removes the dead pbc_evidence_<tenant> localStorage key'
    );

    const ctxSrc = readFileSync(join(process.cwd(), 'src/context/TenantContext.tsx'), 'utf8');
    const deleteBody = ctxSrc.slice(ctxSrc.indexOf('const deleteTenant = useCallback'));
    const deleteFn = deleteBody.slice(0, deleteBody.indexOf('}, ['));
    assert(
      deleteFn.includes('EvidenceVault.clearTenant(tenantId)'),
      'OD5: deleteTenant clears the tenant IndexedDB evidence files'
    );

    const vaultSrc = readFileSync(join(process.cwd(), 'src/services/evidenceVault.ts'), 'utf8').replace(/\r\n/g, '\n');
    const strictBody = vaultSrc.slice(vaultSrc.indexOf('async clearTenantStrict('), vaultSrc.indexOf('async clearAll('));
    assert(
      engineSrc.includes('EvidenceVault.clearTenantStrict(') && strictBody.length > 0 && !/catch\s*[({]/.test(strictBody),
      'OD6: destruction defaults to the strict clear, which has no catch (a failure rejects, so no certificate is issued)'
    );
    assert(
      strictBody.includes('legacyEvidenceIds') && strictBody.includes('`${EVIDENCE_STORE_PREFIX}${id}`'),
      'OD7: the strict clear also removes the legacy unpartitioned keys of the tenant evidence ids'
    );
  }

  // Test Group 3: Cryptographic Integrity Verification Check
  console.log('\n🔐 Test Group 3: Cryptographic Digest Consistency');
  {
    const testData = 'Pitch Black Cyber Defense Enclave Cryptographic Audit Ledger';
    const digest1 = await computeSha256(testData);
    const digest2 = await computeSha256(testData);

    assert(
      digest1 === digest2,
      'Cryptographic SHA-256 digest computation is deterministic'
    );

    assert(
      digest1.length === 64,
      'SHA-256 produces exact 256-bit hexadecimal digest (64 chars)'
    );
  }

  console.log('\n====================================================================');
  console.log(`📊 RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('====================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
