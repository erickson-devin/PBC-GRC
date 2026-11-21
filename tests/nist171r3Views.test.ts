import fs from 'fs';
import path from 'path';
import { getFrameworkControls } from '../src/data/frameworks/frameworkRegistry';
import { PROGRAM_FRAMEWORKS, SETUP_FRAMEWORKS } from '../src/data/tenantFrameworkPolicy';
import { normalizeProgramFramework } from '../src/data/programSync';
import { parseServerTenants } from '../src/data/tenantSync';
import { sprsAppliesTo, emassCsvNotes, generateEmassControlMatrixCsv } from '../src/data/reports/sprsCompiler';
import { getDefaultDocumentTypeForFramework } from '../src/data/reports/documentCompilers';
import { onboardingUnit, onboardingAssessedUnder } from '../src/data/onboardingSummary';
import { boundaryInformationPhrase, defaultBoundaryNarrative, refreshBoundaryNarrative } from '../src/data/onboardingDefaults';
import { frameworkGuidance } from '../src/data/frameworkGuidance';
import { guideFor } from '../src/data/guidance/frameworkGuides';
import { getControlObjectives } from '../src/data/cmmcGuide/objectives';
import { isCuiProgram, suggestedCategorization } from '../src/data/ssp/sspSections';
import { computeSspCompleteness } from '../src/data/ssp/sspCompleteness';
import { categorizationSuggestionView, roleRowsView } from '../src/data/ssp/sspBuilderView';
import { cuiRequirementLine, SSP_INVENTORY_TEXT } from '../src/data/ssp/sspInventoryView';
import {
  R3_NEEDS_CUI_CATEGORY,
  CMMC_L2_NEEDS_CUI_CATEGORY,
  NO_CUI_CATEGORIES_SELECTED,
  dataInventorySubsection,
  sspInventoryMarkdown,
  inventoryCompletenessItems,
  type SspInventorySnapshot,
} from '../src/data/inventory/sspInventory';
import objectivesFile from '../src/data/frameworks/nist171r3/objectives.generated.json';
import type { ReportMetadata } from '../src/types/report';

/**
 * NIST SP 800-171 Rev. 3 in the client (#255): framework lists, onboarding text, exports, the SSP CUI classes, guidance, objectives and the
 * source checks of the screens. Pure: no server.
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

const R3 = 'NIST_800_171_R3' as const;
const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

/** One RFC 4180 line into its cells. */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

console.log('\n--- Framework lists ---');
assert(PROGRAM_FRAMEWORKS.includes(R3), 'V1 PROGRAM_FRAMEWORKS has Rev. 3');
assert(!SETUP_FRAMEWORKS.includes(R3), 'V2 SETUP_FRAMEWORKS does not have Rev. 3 (a platform administrator licenses it)');
assert(normalizeProgramFramework(R3) === R3, 'V3 normalizeProgramFramework keeps Rev. 3');
const parsed = parseServerTenants({ tenants: [{ id: 't1', name: 'T', role: 'TENANT_OWNER', enabledFrameworks: ['CMMC_L2', R3], primaryFramework: R3 }] });
assert(parsed.length === 1 && parsed[0].enabledFrameworks.includes(R3) && parsed[0].primaryFramework === R3, 'V4 parseServerTenants keeps Rev. 3', parsed);

console.log('\n--- Scoring and exports ---');
assert(sprsAppliesTo(R3) === false, 'V5 no SPRS for Rev. 3');
assert(sprsAppliesTo('CMMC_L2') === true, 'V5b SPRS stays for CMMC Level 2');
const controls = getFrameworkControls(R3);
const meta = { systemName: 'Enclave', organizationName: 'Org', cageCode: '', framework: R3, assessmentDate: '2026-01-01' } as unknown as ReportMetadata;
const csv = generateEmassControlMatrixCsv(controls.slice(0, 1), {}, meta);
const row = csvCells(csv.split('\r\n')[1]);
assert(controls.length > 0 && row[2] === controls[0].id && row[3] === controls[0].id, 'V6 the eMASS "NIST SP 800-171 Ref" column shows the Rev. 3 id', row.slice(0, 4));
assert(row[7] === 'N/A', 'V6b the SPRS weight is N/A', row[7]);
const notes = emassCsvNotes(R3);
assert(!notes.some((n) => n.includes('does not map')), 'V7 no "does not map to NIST SP 800-171" line for Rev. 3', notes);
assert(notes.some((n) => n.includes('SPRS')), 'V7b the SPRS note stays');
assert(emassCsvNotes('SOC_2_TYPE_II').some((n) => n.includes('does not map to NIST SP 800-171')), 'V7c another framework keeps the "does not map" line');
const cmmcRow = csvCells(generateEmassControlMatrixCsv(getFrameworkControls('CMMC_L2').slice(0, 1), {}, { ...meta, framework: 'CMMC_L2' } as ReportMetadata).split('\r\n')[1]);
assert(/^\d\.\d+\.\d+$/.test(cmmcRow[3]), 'V7d a CMMC Level 2 control keeps its Rev. 2 number in that column', cmmcRow[3]);
assert(getDefaultDocumentTypeForFramework(R3) === 'NIST_SP_800_18_SSP', 'V8 the SSP document type for Rev. 3');

console.log('\n--- Onboarding ---');
assert(onboardingUnit(R3) === 'controls', 'V9 Rev. 3 counts controls');
assert(boundaryInformationPhrase(R3) === 'Controlled Unclassified Information (CUI)', 'V10 the boundary names CUI');
assert(onboardingAssessedUnder(R3) === 'NIST SP 800-171 Rev. 3', 'V11 "assessed under" names Rev. 3');
const narrative = defaultBoundaryNarrative('Acme', R3);
assert(refreshBoundaryNarrative(narrative, 'Acme', 'Beta', 'CMMC_L2') === defaultBoundaryNarrative('Beta', 'CMMC_L2'), 'V12 a proposed Rev. 3 narrative follows an organization rename');

console.log('\n--- Guidance ---');
const g = frameworkGuidance(R3);
assert(g.poamPermitted === true, 'V13 Rev. 3 allows a POA&M');
assert(g.authority.includes('800-171') && !/CMMC|SPRS score of|C3PAO/.test(`${g.bannerTitle} ${g.authority} ${g.poamPolicyText} ${g.scopeDescription} ${g.inProgressGuidance}`), 'V14 the Rev. 3 guidance has no CMMC wording');
assert(frameworkGuidance('CMMC_L2').poamPermitted === true && frameworkGuidance('CMMC_L1').poamPermitted === false, 'V15 the others are delegated unchanged');
const guide = guideFor(R3);
assert(guide.key === 'GENERIC' && !/CMMC/i.test(JSON.stringify(guide.rules)), 'V16 Rev. 3 gets the generic guide, never CMMC wording', guide.key);

console.log('\n--- Objectives ---');
const entry = (objectivesFile as unknown as { objectives: Record<string, { objectives: { text?: string }[] }> }).objectives['03.01.01'];
const expectedCount = entry.objectives.filter((o) => o.text).length;
const objs = getControlObjectives('03.01.01', 'Account management', [], {}, R3);
assert(expectedCount > 0 && objs.length === expectedCount, 'V17 03.01.01 has one objective per determination statement', { objs: objs.length, expectedCount });
assert(objs.every((o) => o.id.startsWith('03.01.01[') && o.controlId === '03.01.01'), 'V18 every objective id is `03.01.01[letter]`');
assert(objs.every((o) => o.prefilledTemplate === '' && !/Entra|Intune/.test(`${o.text} ${o.prefilledTemplate}`)), 'V19 no template and no Entra / Intune text');
const stored = getControlObjectives('03.01.01', 'x', [], { [objs[0].id]: { ...objs[0], status: 'MET', implementationNarrative: 'kept', text: 'stale', prefilledTemplate: 'stale' } }, R3);
assert(stored[0].status === 'MET' && stored[0].implementationNarrative === 'kept' && stored[0].text === objs[0].text && stored[0].prefilledTemplate === '', 'V20 a stored record keeps its status and narrative; text and template are replaced');
const l2 = getControlObjectives('AC.L2-3.1.1', 'x', [], {}, 'CMMC_L2');
assert(l2.length > 0 && l2.every((o) => o.id.startsWith('AC.L2-3.1.1[')), 'V21 a CMMC control is unchanged');

console.log('\n--- Rev. 3 is a CUI program (decision B12) ---');
assert(isCuiProgram(R3) === true && isCuiProgram('CMMC_L2') === true && isCuiProgram('CMMC_L1') === false && isCuiProgram('NIST_800_53_REV5') === false, 'V22 isCuiProgram');
const mod = { confidentiality: 'MODERATE', integrity: 'MODERATE', availability: 'MODERATE' };
assert(JSON.stringify(suggestedCategorization({ framework: R3 })) === JSON.stringify(mod), 'V23 the suggested categorization is Moderate');
const sugg = categorizationSuggestionView({ framework: R3, baseline: null, profile: null });
assert(sugg?.text === 'Suggested for a NIST SP 800-171 Rev. 3 program, which handles CUI: Moderate / Moderate / Moderate.', 'V24 the suggestion text names Rev. 3', sugg?.text);
assert(categorizationSuggestionView({ framework: 'CMMC_L2', baseline: null, profile: null })?.text.startsWith('Suggested for a CMMC Level 2 program, which handles CUI:') === true, 'V24b the CMMC Level 2 text is unchanged');
assert(R3_NEEDS_CUI_CATEGORY === 'A NIST SP 800-171 Rev. 3 program must select at least one CUI category.', 'V25 the Rev. 3 CUI-category text');
const line = cuiRequirementLine(R3, 0);
assert(line?.tone === 'rose' && line.text === R3_NEEDS_CUI_CATEGORY && cuiRequirementLine(R3, 1) === null, 'V26 the requirement line is rose without a category');
assert(SSP_INVENTORY_TEXT.l2Required === CMMC_L2_NEEDS_CUI_CATEGORY && cuiRequirementLine('CMMC_L2', 0)?.text === CMMC_L2_NEEDS_CUI_CATEGORY, 'V26b the CMMC Level 2 line is unchanged');
const empty: SspInventorySnapshot = { supported: true, tools: [], handlesFci: null, categories: [], registryAsOf: null };
const sub = dataInventorySubsection(empty, R3);
assert(sub.content === `${NO_CUI_CATEGORIES_SELECTED} ${R3_NEEDS_CUI_CATEGORY}`, 'V27 section 1.4 states the requirement', sub.content);
assert(sspInventoryMarkdown(empty, R3).includes(R3_NEEDS_CUI_CATEGORY), 'V28 the Markdown SSP states it too');
assert(dataInventorySubsection(empty, 'NIST_800_53_REV5').content === NO_CUI_CATEGORIES_SELECTED, 'V28b another framework has no requirement sentence');
const invItems = inventoryCompletenessItems(R3, { supported: true, tools: [], handlesFci: null, categories: [] });
assert(invItems.find((i) => i.id === 'inventory:cui')?.severity === 'required', 'V29 a CUI category is a required item', invItems.map((i) => `${i.id}:${i.severity}`));
const cmmc2Items = inventoryCompletenessItems('CMMC_L2', { supported: true, tools: [], handlesFci: null, categories: [] });
assert(JSON.stringify(invItems) === JSON.stringify(cmmc2Items), 'V30 the inventory items equal CMMC Level 2');
const base = { metadata: {}, profile: null } as const;
const r3Roles = computeSspCompleteness({ framework: R3, ...base }).sections.flatMap((s) => s.items).find((i) => i.id === 'role:ir_reporting_primary');
assert(r3Roles?.severity === 'required', 'V31 the incident-reporting role is required, as for CMMC Level 2', r3Roles);
const roleRows = roleRowsView({ rows: [], rolesStatus: undefined, teamLoaded: true, members: [], legacy: false, framework: R3 });
assert(roleRows.some((r) => r.row.roleKey === 'ir_reporting_primary' && r.showCertificate), 'V32 CERTIFICATE_FRAMEWORKS gives Rev. 3 the certificate on the incident-reporting rows');

console.log('\n--- Screens (source checks) ---');
const modals = ['src/components/admin/NewTenantModal.tsx', 'src/components/admin/EditEnclaveModal.tsx', 'src/components/settings/TeamSettingsModal.tsx'];
for (const m of modals) assert(read(m).includes("'NIST_800_171_R3'"), `V33 ${path.basename(m)} lists Rev. 3`);
assert(read('src/components/admin/NewTenantModal.tsx').includes('FRAMEWORK_REGISTRY.NIST_800_171_R3.totalControls'), 'V34 the control count comes from the registry');
const tenantCtx = read('src/context/TenantContext.tsx');
assert(/activeFramework === 'NIST_800_53_REV5' \|\| activeFramework === 'nist-800-53-r5' \|\| activeFramework === 'NIST_800_171_R3'\) return;/.test(tenantCtx), 'V35 the stack-template cascade skips Rev. 3');
const form = read('src/components/programs/ProgramFormModal.tsx');
assert(form.includes('Use Copy from Rev. 2 after creating') && form.includes('cloneSources.map') && form.includes('Clone from another Rev. 3 program'), 'V36 the program form: the hint and the Rev. 3 clone list');
assert(read('vite.config.ts').indexOf("'nist-171r3-catalog'") > 0 && read('vite.config.ts').indexOf("'nist-171r3-catalog'") < read('vite.config.ts').indexOf("return 'framework-catalogs'"), 'V37 the Rev. 3 chunk rule comes before the framework-catalogs rule');
for (const f of ['src/data/frameworkGuidance.ts', 'src/components/layout/Sidebar.tsx', 'src/components/dashboard/ComplianceOverview.tsx', 'src/components/ssp/SSPBuilder.tsx', 'src/data/guidance/frameworkGuides.ts']) {
  const text = read(f);
  assert(!/javascript:|Tenant Owner or MSP Admin/.test(text), `V38 ${path.basename(f)} has no banned text`);
}
for (const f of ['src/components/layout/Sidebar.tsx', 'src/components/dashboard/ComplianceOverview.tsx', 'src/components/ssp/SSPBuilder.tsx', 'src/data/guidance/frameworkGuides.ts']) {
  const text = read(f);
  assert(text.includes('frameworkGuidance(') && !text.includes('getFrameworkGuidanceText('), `V39 ${path.basename(f)} uses the guidance wrapper`);
}

console.log('\n================================================================');
console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
console.log('================================================================\n');
process.exit(passed === total ? 0 : 1);
