import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFrameworkControls } from '../src/data/frameworks';
import {
  DOC_KIND_LABELS,
  VENDOR_KIND_LABELS,
  VENDOR_UI_TEXT,
  docRows,
  evidenceChoices,
  filterVendors,
  rebaseVendorForm,
  removeVendorConfirmText,
  reviewAge,
  suggestedVendorDocControl,
  toolsByVendor,
  uploadLinkFailedText,
  validateVendorForm,
  vendorCountCaption,
  vendorEmptyMessage,
  vendorErrorMessage,
  vendorFormFrom,
} from '../src/data/inventory/vendorRegisterView';
import type { InventoryVendor, VendorDocumentLink } from '../src/types/inventory';

/** The vendor register screens: their pure view logic (validate, merge, texts, documents) and source pins for navigation, privacy and the upload flow. */
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

const src = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const mk = (o: Partial<InventoryVendor> = {}): InventoryVendor => ({
  id: 'v1',
  tenantId: 't1',
  name: 'Acme',
  kind: 'VENDOR',
  services: '',
  contractStart: null,
  contractEnd: null,
  renewalDate: null,
  fedrampStatus: 'UNKNOWN',
  fedrampReference: '',
  fedrampVerifiedOn: null,
  crmOnFile: null,
  lastReviewDate: null,
  notes: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: null,
  ...o,
});
const TODAY = '2026-11-19';

// VU1 the vendor form
const ok = { ...vendorFormFrom(null), name: ' Acme ', contractStart: '2026-01-01', contractEnd: '2026-12-31', lastReviewDate: '2026-11-01', crmOnFile: 'yes' as const };
const okRes = validateVendorForm(ok, TODAY);
assert(okRes.input !== null && okRes.input.name === 'Acme' && okRes.input.crmOnFile === true && okRes.input.contractEnd === '2026-12-31', 'VU1 a valid form gives the trimmed input', okRes);
assert(validateVendorForm({ ...ok, name: '  ' }, TODAY).errors.name === 'Enter the vendor name.', 'VU1 a blank name is refused');
assert(
  validateVendorForm({ ...ok, contractStart: '2026-06-01', contractEnd: '2026-05-31' }, TODAY).errors.contractEnd === 'The contract end date must be on or after the start date.',
  'VU1 contract end before start: the exact message'
);
assert(validateVendorForm({ ...ok, contractStart: '2026-06-01', contractEnd: '2026-06-01' }, TODAY).input !== null, 'VU1 contract end on the start date is allowed');
assert(validateVendorForm({ ...ok, lastReviewDate: '2026-11-20' }, TODAY).errors.lastReviewDate === 'The review date cannot be in the future.', 'VU1 a review date in the future is refused');
assert(validateVendorForm({ ...ok, renewalDate: '2027-02-30' }, TODAY).errors.renewalDate !== undefined, 'VU1 an impossible date is refused');
assert(validateVendorForm({ ...ok, fedrampVerifiedOn: '2026-11-20' }, TODAY).errors.fedrampVerifiedOn !== undefined, 'VU1 a FedRAMP check date in the future is refused');
assert(validateVendorForm(vendorFormFrom(null), TODAY).input === null, 'VU1 an empty new form is not savable');
const round = validateVendorForm(vendorFormFrom(mk({ crmOnFile: false, renewalDate: '2027-01-01' })), TODAY).input;
assert(round !== null && round.crmOnFile === false && round.renewalDate === '2027-01-01' && round.contractStart === null, 'VU1 a stored vendor round-trips through the form');

// VU1b stale-write merge
const oldV = mk({ services: 'one', notes: 'n0' });
const newV = mk({ services: 'two', notes: 'n0', updatedAt: '2026-02-01T00:00:00.000Z' });
const merged = rebaseVendorForm(oldV, newV, { ...vendorFormFrom(oldV), name: 'Mine' });
assert(merged.form.services === 'two' && merged.form.name === 'Mine' && merged.conflicts.length === 0, 'VU1b an untouched field takes the server value, an edited one is kept', merged);
const clash = rebaseVendorForm(oldV, newV, { ...vendorFormFrom(oldV), services: 'three' });
assert(clash.form.services === 'three' && clash.conflicts.join() === 'services', 'VU1b both changing a field differently is a conflict', clash);

// VU2 review age
assert(reviewAge(null, TODAY)?.text === 'Never reviewed' && reviewAge(null, TODAY)?.tone === 'slate', 'VU2 never reviewed');
assert(reviewAge('2025-10-15', TODAY)?.tone === 'amber' && reviewAge('2025-10-15', TODAY)?.text === 'Last review over a year ago', 'VU2 about 400 days ago is amber');
assert(reviewAge('2026-11-09', TODAY) === null, 'VU2 10 days ago needs no pill');
assert(reviewAge('2025-11-19', TODAY) === null && reviewAge('2025-11-18', TODAY)?.tone === 'amber', 'VU2 exactly a year is fine, a day more is not');

// VU3 removal text
const rm = removeVendorConfirmText(1, 2);
assert(rm.includes('1 tool is unlinked') && rm.includes('evidence files stay') && rm.includes('every program'), 'VU3 removal text', rm);
assert(removeVendorConfirmText(3, 0).includes('3 tools are unlinked'), 'VU3 plural');
assert(!/Acme/.test(rm), 'VU3 no name in the text');

// VU4 evidence choices and the suggested control
const ev = [
  { id: 'e2', name: 'beta.pdf', controlId: 'AC.L2-3.1.1' },
  { id: 'e1__inh_p2', name: 'inherited.pdf', controlId: 'AC.L2-3.1.1' },
  { id: 'e3', name: 'Alpha.pdf', controlId: 'CA.L2-3.12.4' },
];
assert(evidenceChoices(ev).map((e) => e.id).join() === 'e3,e2', 'VU4 inherited copies are dropped and the rest sorted by name', evidenceChoices(ev));
const idsOf = (fw: string): Set<string> => new Set(getFrameworkControls(fw as Parameters<typeof getFrameworkControls>[0]).map((c) => c.id));
assert(suggestedVendorDocControl('CMMC_L2', idsOf('CMMC_L2')) === 'CA.L2-3.12.4', 'VU4 CMMC L2 suggests CA.L2-3.12.4');
assert(suggestedVendorDocControl('CMMC_L1', idsOf('CMMC_L1')) === null, 'VU4 CMMC L1 suggests nothing');
assert(suggestedVendorDocControl('NIST_800_53_REV5', idsOf('NIST_800_53_REV5')) === 'SA-9', 'VU4 NIST 800-53 suggests SA-9');
assert(suggestedVendorDocControl('CMMC_L2', new Set(['AC.L2-3.1.1'])) === null, 'VU4 a control that is not in the catalog is not suggested');

// VU5 document rows
const links: VendorDocumentLink[] = [
  { vendorId: 'v1', evidenceId: 'e2', docKind: 'CRM', linkedAt: '2026-01-01T00:00:00.000Z', linkedBy: null },
  { vendorId: 'v1', evidenceId: 'gone', docKind: 'CONTRACT', linkedAt: '2026-01-01T00:00:00.000Z', linkedBy: null },
  { vendorId: 'v2', evidenceId: 'e3', docKind: 'SRM', linkedAt: '2026-01-01T00:00:00.000Z', linkedBy: null },
];
const rows = docRows(links, 'v1', ev);
assert(rows.length === 2 && rows[0].evidenceId === 'e2' && !rows[0].missing && rows[0].name === 'beta.pdf', 'VU5 a present file keeps its name', rows);
assert(rows[1].evidenceId === 'gone' && rows[1].missing && rows[1].name === null && rows[1].controlId === null, 'VU5 an unknown evidence id is missing, with no name', rows);

// VU6 error text
const echo = { name: 'ApiError', status: 404, reason: 'evidence_not_found', message: 'MARK-SECRET' };
assert(!vendorErrorMessage(echo, 'link').includes('MARK') && vendorErrorMessage(echo, 'link').includes('no longer in this'), 'VU6 evidence_not_found is fixed text and never echoes', vendorErrorMessage(echo, 'link'));
assert(vendorErrorMessage({ status: 429, reason: 'limit', message: 'MARK' }, 'save').includes('500 vendors'), 'VU6 limit on save names the vendor cap');
assert(vendorErrorMessage({ status: 429, reason: 'limit' }, 'link').includes('50'), 'VU6 limit on link names the document cap');
assert(vendorErrorMessage({ status: 403, message: 'MARK' }, 'save').includes('Tenant Owner or Admin'), 'VU6 403 uses the Owner or Admin wording');
assert(vendorErrorMessage({ status: 409, reason: 'duplicate_name', message: 'MARK' }, 'save').includes('already in the register'), 'VU6 duplicate name');
assert(vendorErrorMessage({ status: 409, reason: 'stale_write' }, 'save') === VENDOR_UI_TEXT.staleVendor, 'VU6 stale write');
assert(vendorErrorMessage({ status: 0 }, 'save').includes('could not be reached'), 'VU6 status 0');
assert(vendorErrorMessage(new Error('MARK'), 'upload') === 'The file could not be uploaded. Try again.', 'VU6 an unknown error gets the default for the action');
assert(!/Tenant Owner or MSP Admin/.test(Object.values(VENDOR_UI_TEXT).join(' ')), 'VU6 no MSP Admin wording');

// VU7 helpers
const tbv = toolsByVendor([
  { id: 't1', name: 'zeta', vendorId: 'v1' },
  { id: 't2', name: 'Alpha', vendorId: 'v1' },
  { id: 't3', name: 'free', vendorId: null },
]);
assert(tbv.v1.join() === 'Alpha,zeta' && Object.keys(tbv).length === 1, 'VU7 toolsByVendor groups and sorts the names', tbv);
const vs = [mk({ id: 'a', name: 'Beta', kind: 'CSP', services: 'hosting' }), mk({ id: 'b', name: 'alpha', kind: 'MSP', services: 'help desk' })];
assert(filterVendors(vs, '', 'ALL').map((v) => v.id).join() === 'b,a', 'VU7 vendors are sorted by name without regard to case');
assert(filterVendors(vs, 'HELP', 'ALL').map((v) => v.id).join() === 'b', 'VU7 search covers the services text');
assert(filterVendors(vs, '', 'CSP').map((v) => v.id).join() === 'a', 'VU7 kind filter');
assert(vendorCountCaption(1, 1) === '1 vendor' && vendorCountCaption(12, 12) === '12 vendors' && vendorCountCaption(3, 12) === '3 of 12 vendors', 'VU7 count caption');
assert(vendorEmptyMessage({ total: 0, canEdit: true }) === VENDOR_UI_TEXT.emptyEditor && vendorEmptyMessage({ total: 0, canEdit: false }) === VENDOR_UI_TEXT.emptyReader && vendorEmptyMessage({ total: 2, canEdit: true }) === VENDOR_UI_TEXT.emptyFiltered, 'VU7 empty messages');
assert(uploadLinkFailedText('CA.3.12.4').includes('CA.3.12.4') && uploadLinkFailedText('X').includes('A file already in the Evidence Vault'), 'VU7 upload-then-link-failed text');
assert(Object.keys(VENDOR_KIND_LABELS).length === 5 && Object.keys(DOC_KIND_LABELS).length === 6, 'VU7 label tables are complete');

// VU8 navigation pins
const sidebar = src('src/components/layout/Sidebar.tsx');
const app = src('src/App.tsx');
assert(sidebar.includes("id: 'tools'") && sidebar.includes("label: 'Tools & Services'"), "VU8 the sidebar has the 'tools' item");
assert(sidebar.indexOf("'Tools & Services'") > sidebar.indexOf("'Asset Inventory & Fleet'"), 'VU8 Tools & Services comes after Asset Inventory & Fleet');
assert(app.includes("{activeTab === 'tools' && <ToolsServicesPage />}") && app.includes('<SoftwareInventoryPanel />'), "VU8 App mounts the page and keeps the software panel");
assert(!src('src/data/programDefaultChoice.ts').includes("'tools'"), 'VU8 the register is tenant-wide, not program-scoped');
assert(src('src/components/inventory/ToolsServicesPage.tsx').includes('<ToolRegisterPanel />') && src('src/components/inventory/ToolsServicesPage.tsx').includes('<VendorRegisterPanel />'), 'VU8 the page stacks both panels');

// VU9 the upload flow
const docs = src('src/components/inventory/VendorDocumentsDialog.tsx');
const upStart = docs.indexOf('uploadEvidence(controlId');
const upCall = docs.slice(upStart, docs.indexOf(')', upStart) + 1);
assert(upStart > 0 && upCall.includes("'Vendor document'") && docs.includes('linkDocument('), 'VU9 upload goes through uploadEvidence with a fixed description, then linkDocument', upCall);
assert(!upCall.includes('vendor.name') && !upCall.includes('file.name'), 'VU9 neither the vendor name nor the file name goes into the upload description');
assert(docs.indexOf('uploadEvidence(controlId') < docs.indexOf('inv.linkDocument('), 'VU9 the upload comes before the link');

// VU10 privacy and dialog cap for the vendor files
const files = [
  'src/components/inventory/VendorRegisterPanel.tsx',
  'src/components/inventory/VendorDialog.tsx',
  'src/components/inventory/VendorDocumentsDialog.tsx',
  'src/components/inventory/ToolsServicesPage.tsx',
  'src/data/inventory/vendorRegisterView.ts',
];
let clean = true;
let capped = true;
for (const f of files) {
  const s = src(f);
  if (/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|\balert\(/.test(s)) {
    clean = false;
    console.error(`    ${f} has a forbidden call`);
  }
  for (const m of s.matchAll(/<DialogOverlay/g)) {
    const chunk = s.slice(m.index ?? 0, (m.index ?? 0) + 900);
    if (!chunk.includes('max-h-[') && !chunk.includes('my-auto')) capped = false;
  }
}
assert(clean, 'VU10 no console, browser storage, alert or raw HTML in the vendor files');
assert(capped, 'VU10 every dialog is height-capped');
assert(!/from '\.\.\/\.\.\/(services|hooks)\//.test(src('src/data/inventory/vendorRegisterView.ts')), 'VU10 the view module imports no hook or service');

console.log(`\n📊 TEST RESULTS: ${passed} / ${total}`);
if (passed !== total) process.exitCode = 1;
