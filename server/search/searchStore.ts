import { getDbMode, queryWithProgram, type ProgramScope } from '../db';
import { readControlAssessments } from '../controlAssessments';
import { readObjectives } from '../controlObjectives';
import { readControlPoam } from '../controlPoam';
import { listAssets } from '../assets';
import { getProgramAssetIds } from '../programAssets';
import { listTools, listVendors } from '../inventory/registerStore';
import { readProgramInventory } from '../inventory/programInventoryStore';
import { listDocuments } from '../documents/registerStore';
import { readProgramDocuments } from '../documents/programDocumentsStore';
import { loadVmPoamView } from '../vm/findingsStore';
import { stripDelimitedBlocks } from '../vm/snapshot';
import { catalogIndexFor } from './catalogIndex';
import type { Program } from '../programs';
import { cmmcStoredIds } from '../../src/data/cmmcGuide/displayId';
import { likePattern, matchText, rankResults, snippetAround } from '../../src/data/search/searchMatch';
import { SEARCH_KINDS, type SearchKind, type SearchResponse, type SearchResult, type SearchSnippet } from '../../src/types/search';

/**
 * Global search of the open program (#254). One case-insensitive CONTIGUOUS substring: SQL narrows the rows (ILIKE with the wildcards of the query escaped)
 * and the pure matcher (src/data/search/searchMatch.ts) decides, in both stores, so memory mode and PostgreSQL give the same answer. A caller finds only what
 * their own GETs return: no cost fields, no evidence descriptions, no tool, vendor or document notes (B21), and for a read role nothing a write role alone sees.
 * Program kinds read the open program only (RLS plus explicit tenant and program predicates). The tenant-wide registers (assets, tools, vendors, documents)
 * are read whole and each result says whether it belongs to the program.
 *
 * The query and the snippets may be CUI: nothing here logs, stores or throws them; an error carries no text.
 */

export interface SearchOptions {
  kinds: readonly SearchKind[];
  /** Results kept per kind (the route allows 1 to 25). */
  perKind: number;
}

const isMemory = (): boolean => getDbMode() === 'memory';

/** Rows asked of PostgreSQL per kind before the matcher (a few more than the kept ones, so a candidate the matcher refuses does not empty the group). */
const candidateLimit = (perKind: number): number => perKind * 4;

/** The first of the fields that contains the query, with its snippet; null when none does. */
function firstHit(fields: { field: string; text: string }[], q: string): { field: string; snippet: SearchSnippet | null } | null {
  for (const f of fields) {
    if (matchText(f.text, q) >= 0) return { field: f.field, snippet: snippetAround(f.text, q) };
  }
  return null;
}

const shorten = (s: string, max = 120): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// ------------------------------------------------------------------------------------------------ program kinds

async function searchControls(program: Program, q: string, perKind: number): Promise<SearchResult[]> {
  const scope: ProgramScope = { tenantId: program.tenantId, programId: program.id };
  const index = catalogIndexFor(program);
  const stored = new Set(cmmcStoredIds(q));
  const out = new Map<string, SearchResult>();
  for (const c of index.controls) {
    const hit = firstHit([{ field: 'id', text: c.id }, { field: 'id', text: c.displayId }, { field: 'title', text: c.title }], q) ?? (stored.has(c.id) ? { field: 'id', snippet: null } : null);
    if (!hit) continue;
    out.set(c.id, { kind: 'control', id: c.id, title: c.title, subtitle: c.displayId, field: hit.field, snippet: hit.field === 'title' ? hit.snippet : null, nav: { screen: 'control', controlId: c.id } });
  }
  // the notes a person wrote (the vulnerability-management blocks are stripped: they are generated, not written)
  let notes: { controlId: string; notes: string }[];
  if (isMemory()) {
    notes = [...(await readControlAssessments(scope))].map(([controlId, a]) => ({ controlId, notes: a.notes }));
  } else {
    const res = await queryWithProgram(
      scope,
      "SELECT control_id, implementation_notes FROM control_assessments WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL) AND implementation_notes ILIKE $3 ESCAPE '\\' ORDER BY control_id LIMIT $4",
      [scope.tenantId, scope.programId, likePattern(q), candidateLimit(perKind)]
    );
    notes = res.rows.filter((r) => r.tenant_id === undefined || r.tenant_id === scope.tenantId).map((r) => ({ controlId: String(r.control_id), notes: String(r.implementation_notes ?? '') }));
  }
  for (const n of notes) {
    const c = index.byId.get(n.controlId);
    if (!c || out.has(c.id)) continue;
    const text = stripDelimitedBlocks(n.notes);
    if (matchText(text, q) < 0) continue;
    out.set(c.id, { kind: 'control', id: c.id, title: c.title, subtitle: c.displayId, field: 'notes', snippet: snippetAround(text, q), nav: { screen: 'control', controlId: c.id } });
  }
  return [...out.values()];
}

async function searchObjectives(program: Program, q: string, perKind: number): Promise<SearchResult[]> {
  const scope: ProgramScope = { tenantId: program.tenantId, programId: program.id };
  const index = catalogIndexFor(program);
  const out = new Map<string, SearchResult>();
  const push = (id: string, controlId: string, field: string, text: string): void => {
    const c = index.byId.get(controlId);
    if (!c || out.has(id)) return;
    out.set(id, { kind: 'objective', id, title: id, subtitle: c.title, field, snippet: snippetAround(text, q), nav: { screen: 'objective', controlId, objectiveId: id } });
  };
  for (const o of index.objectives) if (matchText(o.text, q) >= 0) push(o.id, o.controlId, 'objective text', o.text);
  let narratives: { objectiveId: string; controlId: string; narrative: string }[];
  if (isMemory()) {
    narratives = (await readObjectives(scope)).map((o) => ({ objectiveId: o.objectiveId, controlId: o.controlId, narrative: o.narrative }));
  } else {
    const res = await queryWithProgram(
      scope,
      "SELECT objective_id, control_id, narrative FROM control_objectives WHERE tenant_id = $1 AND program_id = $2 AND narrative ILIKE $3 ESCAPE '\\' ORDER BY objective_id LIMIT $4",
      [scope.tenantId, scope.programId, likePattern(q), candidateLimit(perKind)]
    );
    narratives = res.rows.map((r) => ({ objectiveId: String(r.objective_id), controlId: String(r.control_id), narrative: String(r.narrative ?? '') }));
  }
  for (const n of narratives) if (matchText(n.narrative, q) >= 0) push(n.objectiveId, n.controlId, 'narrative', n.narrative);
  return [...out.values()];
}

async function searchEvidence(program: Program, q: string, perKind: number): Promise<SearchResult[]> {
  const scope: ProgramScope = { tenantId: program.tenantId, programId: program.id };
  const res = isMemory()
    ? await queryWithProgram(scope, 'SELECT id, control_id, file_name, tenant_id FROM evidence_metadata WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL) ORDER BY uploaded_at DESC', [scope.tenantId, scope.programId])
    : await queryWithProgram(
        scope,
        "SELECT id, control_id, file_name, tenant_id FROM evidence_metadata WHERE tenant_id = $1 AND (program_id = $2 OR program_id IS NULL) AND position('__inh_' in id) = 0 AND file_name ILIKE $3 ESCAPE '\\' ORDER BY uploaded_at DESC LIMIT $4",
        [scope.tenantId, scope.programId, likePattern(q), candidateLimit(perKind)]
      );
  const out: SearchResult[] = [];
  for (const r of res.rows) {
    const id = String(r.id);
    if (r.tenant_id !== scope.tenantId || id.includes('__inh_')) continue; // an inherited copy is the same file: the original is the result
    const name = String(r.file_name ?? '');
    if (matchText(name, q) < 0) continue;
    out.push({ kind: 'evidence', id, title: name, subtitle: String(r.control_id ?? ''), field: 'file name', snippet: snippetAround(name, q), nav: { screen: 'evidence', evidenceId: id, controlId: String(r.control_id ?? '') } });
  }
  return out;
}

async function searchControlPoam(program: Program, q: string): Promise<SearchResult[]> {
  const index = catalogIndexFor(program);
  const out: SearchResult[] = [];
  for (const e of await readControlPoam({ tenantId: program.tenantId, programId: program.id })) {
    const c = index.byId.get(e.controlId);
    if (!c) continue;
    const hit = firstHit([{ field: 'owner', text: e.owner }, { field: 'plan', text: e.plan }, { field: 'required resources', text: e.requiredResources }], q);
    if (hit) out.push({ kind: 'poam_control', id: c.id, title: c.title, subtitle: c.displayId, field: hit.field, snippet: hit.snippet, nav: { screen: 'poam_control', controlId: c.id } });
  }
  return out;
}

async function searchVmPoam(program: Program, q: string, perKind: number): Promise<SearchResult[]> {
  const scope: ProgramScope = { tenantId: program.tenantId, programId: program.id };
  let rows: { id: string; itemNumber: number | null; weakness: string; owner: string; mitigation: string; status: string }[];
  if (isMemory()) {
    const view = await loadVmPoamView(scope, new Date().toISOString(), { openOnly: false, limit: 1000, offset: 0, upcomingLimit: 0, includeFindingWindow: false });
    rows = view.items.map((i) => ({ id: i.id, itemNumber: i.itemNumber, weakness: i.weakness, owner: i.owner, mitigation: i.mitigation, status: i.status }));
  } else {
    const res = await queryWithProgram(
      scope,
      `SELECT id, item_number, weakness, owner, mitigation, status FROM vm_poam_items
        WHERE tenant_id = $1 AND program_id = $2
          AND (weakness ILIKE $3 ESCAPE '\\' OR owner ILIKE $3 ESCAPE '\\' OR mitigation ILIKE $3 ESCAPE '\\' OR ('POAM-VM-' || COALESCE(item_number::text, '')) ILIKE $3 ESCAPE '\\')
        ORDER BY item_number NULLS LAST, id LIMIT $4`,
      [scope.tenantId, scope.programId, likePattern(q), candidateLimit(perKind)]
    );
    rows = res.rows.map((r) => ({ id: String(r.id), itemNumber: r.item_number === null || r.item_number === undefined ? null : Number(r.item_number), weakness: String(r.weakness ?? ''), owner: String(r.owner ?? ''), mitigation: String(r.mitigation ?? ''), status: String(r.status ?? '') }));
  }
  const out: SearchResult[] = [];
  for (const r of rows) {
    const label = r.itemNumber === null ? '' : `POAM-VM-${r.itemNumber}`;
    const hit = firstHit([{ field: 'item number', text: label }, { field: 'weakness', text: r.weakness }, { field: 'owner', text: r.owner }, { field: 'mitigation', text: r.mitigation }], q);
    if (hit) out.push({ kind: 'poam_vm', id: r.id, title: shorten(r.weakness) || label || 'Vulnerability item', subtitle: [label, r.status].filter(Boolean).join(' · '), field: hit.field, snippet: hit.snippet, nav: { screen: 'poam_vm', itemId: r.id } });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ tenant-wide registers

async function searchAssets(program: Program, q: string): Promise<SearchResult[]> {
  const [assets, memberIds] = await Promise.all([listAssets(program.tenantId), getProgramAssetIds(program.tenantId, program.id)]);
  const members = new Set(memberIds);
  const out: SearchResult[] = [];
  for (const a of assets) {
    const hit = firstHit([{ field: 'host name', text: a.hostName }, { field: 'IP address', text: a.ipAddress }, { field: 'MAC address', text: a.macAddress }, { field: 'serial number', text: a.serialNumber }], q);
    if (hit) out.push({ kind: 'asset', id: a.id, title: a.hostName, subtitle: a.cmmcAssetCategory, field: hit.field, snippet: hit.snippet, inProgram: members.size === 0 || members.has(a.id), nav: { screen: 'asset', assetId: a.id } });
  }
  return out;
}

async function searchTools(program: Program, q: string): Promise<SearchResult[]> {
  const scope: ProgramScope = { tenantId: program.tenantId, programId: program.id };
  const [tools, inventory] = await Promise.all([listTools(program.tenantId), readProgramInventory(scope)]);
  const members = new Set(inventory.toolIds);
  const out: SearchResult[] = [];
  for (const t of tools) {
    const hit = firstHit([{ field: 'name', text: t.name }, { field: 'vendor', text: t.vendorName }], q);
    if (hit) out.push({ kind: 'tool', id: t.id, title: t.name, subtitle: t.vendorName, field: hit.field, snippet: hit.snippet, inProgram: !inventory.declared || members.has(t.id), nav: { screen: 'tool', toolId: t.id } });
  }
  return out;
}

async function searchVendors(program: Program, q: string): Promise<SearchResult[]> {
  const scope: ProgramScope = { tenantId: program.tenantId, programId: program.id };
  const [vendors, tools, inventory] = await Promise.all([listVendors(program.tenantId), listTools(program.tenantId), readProgramInventory(scope)]);
  // a vendor is in the program when a tool of its boundary names it, or a vendor document of the program is linked to it
  const members = new Set(inventory.toolIds);
  const inBoundary = new Set(tools.filter((t) => t.vendorId && (!inventory.declared || members.has(t.id))).map((t) => t.vendorId as string));
  for (const d of inventory.vendorDocuments) inBoundary.add(d.vendorId);
  const out: SearchResult[] = [];
  for (const v of vendors) {
    const hit = firstHit([{ field: 'name', text: v.name }, { field: 'services', text: v.services }], q);
    if (hit) out.push({ kind: 'vendor', id: v.id, title: v.name, subtitle: v.kind, field: hit.field, snippet: hit.snippet, inProgram: inBoundary.has(v.id), nav: { screen: 'vendor', vendorId: v.id } });
  }
  return out;
}

async function searchDocuments(program: Program, q: string): Promise<SearchResult[]> {
  const scope: ProgramScope = { tenantId: program.tenantId, programId: program.id };
  const [documents, programDocuments] = await Promise.all([listDocuments(program.tenantId), readProgramDocuments(scope)]);
  const members = new Set(programDocuments.documentIds);
  const out: SearchResult[] = [];
  for (const d of documents) {
    const hit = firstHit([{ field: 'title', text: d.title }, { field: 'reference', text: d.reference }, { field: 'owner', text: d.owner }], q);
    if (hit) out.push({ kind: 'document', id: d.id, title: d.title, subtitle: d.reference ? `${d.kind} · ${d.reference}` : d.kind, field: hit.field, snippet: hit.snippet, inProgram: !programDocuments.declared || members.has(d.id), nav: { screen: 'document', documentId: d.id } });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ entry point

/**
 * Searches the open program for `q` (already normalized by the route: 2 to 100 characters, no control character). Returns one group per requested kind, in
 * the order of SEARCH_KINDS, each with at most `perKind` results (best first) and `truncated` when there were more. `tenantId` must be the program's.
 */
export async function searchProgram(program: Program, tenantId: string, q: string, opts: SearchOptions): Promise<SearchResponse> {
  if (program.tenantId !== tenantId) return { programId: program.id, groups: [] };
  const wanted = SEARCH_KINDS.filter((k) => opts.kinds.includes(k));
  const run = (kind: SearchKind): Promise<SearchResult[]> => {
    switch (kind) {
      case 'control': return searchControls(program, q, opts.perKind);
      case 'objective': return searchObjectives(program, q, opts.perKind);
      case 'evidence': return searchEvidence(program, q, opts.perKind);
      case 'asset': return searchAssets(program, q);
      case 'poam_control': return searchControlPoam(program, q);
      case 'poam_vm': return searchVmPoam(program, q, opts.perKind);
      case 'tool': return searchTools(program, q);
      case 'vendor': return searchVendors(program, q);
      case 'document': return searchDocuments(program, q);
    }
  };
  const groups: SearchResponse['groups'] = [];
  for (const kind of wanted) {
    const ranked = rankResults(await run(kind), q);
    groups.push({ kind, results: ranked.slice(0, opts.perKind), truncated: ranked.length > opts.perKind });
  }
  return { programId: program.id, groups };
}
