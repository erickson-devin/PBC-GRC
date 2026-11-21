import type { GeneratedR2R3Entry } from '../frameworks/nist171r3/types';
import type {
  FrameworkCopyInclude, FrameworkCopyItem, FrameworkCopyKind, FrameworkCopyOp, FrameworkCopyPlan, FrameworkCopySourceRef,
  R3StatusSource, R3StatusSuggestion, R3SuggestedStatus, R3SuggestionReason,
} from '../../types/frameworkCopy';

/**
 * "Copy from Rev. 2" (#255): the pure planner. It decides, from a CMMC program's rows and the generated Rev. 2 -> Rev. 3 mapping, what
 * would be appended to which Rev. 3 control. No fetch, no DOM, no node-only import: the server and the browser both use it. The caller
 * reads the rows, applies what the plan says (an append only ever adds text after the existing text), and hashes planDigestInput.
 * Output holds ids, counts and lengths only, never narrative text or file names.
 */

/** One copy carries at most this many evidence files and bytes (the server answers 413 copy_too_large above it). */
export const COPY_MAX_EVIDENCE_FILES = 200;
export const COPY_MAX_EVIDENCE_BYTES = 1024 ** 3;

export const DEFAULT_COPY_INCLUDE: FrameworkCopyInclude = { notes: true, objectives: true, evidence: true, tools: true, documents: true };

/** The database patterns of program_framework_copy_items (kind and source key); the key's PostgreSQL class "[][A-Za-z0-9._-]" is spelled "[\][...]" in JavaScript. */
export const MARKER_KIND_RE = /^[A-Z][A-Z_]{0,15}$/;
export const MARKER_SOURCE_KEY_RE = /^[\][A-Za-z0-9._-]{1,128}$/;

const KIND_ORDER: FrameworkCopyKind[] = ['NOTES', 'OBJECTIVE', 'EVIDENCE', 'TOOL', 'DOCUMENT'];

/** Missing flags default to included. */
export function normalizeCopyInclude(include?: Partial<FrameworkCopyInclude> | null): FrameworkCopyInclude {
  const i = include ?? {};
  return {
    notes: i.notes !== false,
    objectives: i.objectives !== false,
    evidence: i.evidence !== false,
    tools: i.tools !== false,
    documents: i.documents !== false,
  };
}

// ----- text blocks

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The text a source contributes: the caller's stripper applied (the server passes stripDelimitedBlocks), then trimmed. '' means nothing to copy. */
export function copyableText(raw: string, strip?: (text: string) => string): string {
  const text = typeof raw === 'string' ? raw : '';
  return (strip ? strip(text) : text).trim();
}

/**
 * One block to append to a Rev. 3 control's notes. NOTES: a header line naming the Rev. 2 control, the source program and the date, then
 * the text. OBJECTIVE: "[Rev. 2 objective <objectiveId>]", then the narrative. `date` is YYYY-MM-DD.
 */
export function copyBlock(input: { kind: 'NOTES' | 'OBJECTIVE'; sourceId: string; programName: string; date: string; text: string }): string {
  if (input.kind === 'OBJECTIVE') return `[Rev. 2 objective ${input.sourceId}]\n${input.text}`;
  return `[Copied from NIST SP 800-171 Rev. 2 ${input.sourceId} (program "${oneLine(input.programName).replace(/"/g, "'")}") on ${input.date}; review against Rev. 3]\n${input.text}`;
}

/** existing + a blank line + block (the block alone when there is no existing text). The existing text is never changed. */
export function appendCopiedBlock(existing: string, block: string): string {
  return existing ? `${existing}\n\n${block}` : block;
}

// ----- ids and keys

const REV2_NUMBER_RE = /(?:^|-)(3\.\d{1,2}\.\d{1,2})$/;

/** "AC.L2-3.1.1" or "AC.L1-3.1.1" or "3.1.1" -> "3.1.1" (the mapping key); null for anything else. Same rule as requirementNumberOf in nist80053/crosswalk.ts, without its catalog imports. */
export function rev2NumberOf(controlId: string): string | null {
  const m = REV2_NUMBER_RE.exec((controlId ?? '').trim());
  return m ? m[1] : null;
}

/** The idempotency key of one copied item within a (target program, source program) pair: "<KIND>|<target control>|<source key>". */
export function markerKey(kind: FrameworkCopyKind, targetControlId: string, sourceKey: string): string {
  return `${kind}|${targetControlId}|${sourceKey}`;
}

// ----- the plan

export interface PlanSourceControl {
  /** The stored notes (the plan strips them with `stripNotes`). */
  notes: string;
  status: string;
  updatedAt: string | null;
  /** The caller's SHA-256 of copyableText(notes, stripNotes), compared with the marker's to find "changed since copy". */
  notesSha256?: string;
}

export interface PlanSourceObjective {
  objectiveId: string;
  controlId: string;
  narrative: string;
  updatedAt?: string | null;
  narrativeSha256?: string;
}

export interface PlanSourceEvidence {
  id: string;
  controlId: string;
  sizeBytes: number;
  fileHash?: string;
  /** False for rows that are never copied (inherited, VM snapshot): the plan ignores them. */
  copyable: boolean;
  /** False when the file is missing or its hash does not match (counted as unavailable, not copied). Default true. */
  available?: boolean;
}

export interface FrameworkCopyPlanInput {
  /** The `requirements` record of r2r3.generated.json. */
  mapping: Record<string, GeneratedR2R3Entry>;
  /** `newInR3` of r2r3.generated.json. */
  newInR3: readonly string[];
  /** Every control id of the Rev. 3 catalog. */
  targetCatalog: ReadonlySet<string>;
  source: {
    /** Stored control id ("AC.L2-3.1.1") -> row. */
    controls: ReadonlyMap<string, PlanSourceControl>;
    objectives: readonly PlanSourceObjective[];
    evidence: readonly PlanSourceEvidence[];
    toolLinks: readonly { toolId: string; controlId: string }[];
    documentLinks: readonly { documentId: string; controlId: string }[];
  };
  /** Markers of earlier runs for this (target, source) pair: key -> the source_sha256 stored with it (null when none). A Set is accepted when no digests are kept. */
  markers: ReadonlyMap<string, string | null> | ReadonlySet<string>;
  include?: Partial<FrameworkCopyInclude> | null;
  /** Removes the delimited machine blocks (VM snapshots) from notes: pass stripDelimitedBlocks from server/vm/snapshot. */
  stripNotes?: (notes: string) => string;
}

function markerHas(markers: FrameworkCopyPlanInput['markers'], key: string): boolean {
  return markers.has(key);
}

function markerSha(markers: FrameworkCopyPlanInput['markers'], key: string): string | null {
  return markers instanceof Map ? (markers.get(key) ?? null) : null;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function planFrameworkCopy(input: FrameworkCopyPlanInput): FrameworkCopyPlan {
  const include = normalizeCopyInclude(input.include);
  const { mapping, targetCatalog, source, markers } = input;

  const objectivesByControl = new Map<string, PlanSourceObjective[]>();
  for (const o of source.objectives) {
    const list = objectivesByControl.get(o.controlId) ?? [];
    list.push(o);
    objectivesByControl.set(o.controlId, list);
  }
  const evidenceByControl = new Map<string, PlanSourceEvidence[]>();
  for (const e of source.evidence) {
    const list = evidenceByControl.get(e.controlId) ?? [];
    list.push(e);
    evidenceByControl.set(e.controlId, list);
  }
  const toolsByControl = new Map<string, string[]>();
  for (const l of source.toolLinks) toolsByControl.set(l.controlId, [...(toolsByControl.get(l.controlId) ?? []), l.toolId]);
  const docsByControl = new Map<string, string[]>();
  for (const l of source.documentLinks) docsByControl.set(l.controlId, [...(docsByControl.get(l.controlId) ?? []), l.documentId]);

  const sourceIds = new Set<string>(source.controls.keys());
  for (const m of [objectivesByControl, evidenceByControl, toolsByControl, docsByControl]) for (const id of m.keys()) sourceIds.add(id);

  const itemsByTarget = new Map<string, FrameworkCopyItem>();
  const seenKeys = new Set<string>();
  const copiedKeys = new Set<string>();
  const changedKeys = new Set<string>();
  const skippedTargets: { controlId: string; targetId: string }[] = [];
  const notCarried: { r2: string; cmmcId: string }[] = [];
  const mergedInto: { r2: string; cmmcId: string; targets: string[] }[] = [];
  let evidenceUnavailable = 0;
  let alreadyCopiedTotal = 0;
  let changedTotal = 0;

  for (const sourceId of [...sourceIds].sort(cmpStr)) {
    const r2 = rev2NumberOf(sourceId);
    const entry = r2 ? mapping[r2] : undefined;
    if (!r2 || !entry) continue;
    if (entry.withdrawn) {
      if (entry.targets.length === 0) notCarried.push({ r2, cmmcId: sourceId });
      else mergedInto.push({ r2, cmmcId: sourceId, targets: entry.targets.map((t) => t.id).sort(cmpStr) });
    }
    for (const target of entry.targets) {
      if (!targetCatalog.has(target.id)) {
        skippedTargets.push({ controlId: sourceId, targetId: target.id });
        continue;
      }
      const targetId = target.id;
      const ref: FrameworkCopySourceRef = { controlId: sourceId, relation: target.relation };
      if (entry.changeType) ref.changeType = entry.changeType;
      if (entry.newOdp !== undefined) ref.newOdp = entry.newOdp;

      const item = itemsByTarget.get(targetId) ?? {
        targetControlId: targetId, sources: [], notes: { count: 0, chars: 0 }, objectives: { count: 0, chars: 0 },
        evidence: { count: 0, bytes: 0, unavailable: 0 }, tools: 0, documents: 0, alreadyCopied: 0, changedSinceCopy: 0, ops: [],
      };
      const opsBefore = item.ops.length;

      // Returns true when the op is new work; a pair already marked counts as copied (and as changed when its text differs).
      const consider = (op: FrameworkCopyOp, currentSha?: string): boolean => {
        const key = markerKey(op.kind, op.targetControlId, op.sourceKey);
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        if (markerHas(markers, key)) {
          copiedKeys.add(key);
          item.alreadyCopied++;
          alreadyCopiedTotal++;
          const stored = markerSha(markers, key);
          if (stored && currentSha && stored !== currentSha) {
            changedKeys.add(key);
            item.changedSinceCopy++;
            changedTotal++;
          }
          return false;
        }
        item.ops.push(op);
        return true;
      };

      if (include.notes) {
        const ctrl = source.controls.get(sourceId);
        const text = ctrl ? copyableText(ctrl.notes, input.stripNotes) : '';
        if (ctrl && text) {
          const op: FrameworkCopyOp = { kind: 'NOTES', targetControlId: targetId, sourceControlId: sourceId, sourceKey: sourceId, relation: target.relation, chars: text.length, sourceUpdatedAt: ctrl.updatedAt };
          if (ctrl.notesSha256) op.sha256 = ctrl.notesSha256;
          if (consider(op, ctrl.notesSha256)) { item.notes.count++; item.notes.chars += text.length; }
        }
      }
      if (include.objectives) {
        for (const o of objectivesByControl.get(sourceId) ?? []) {
          const text = copyableText(o.narrative);
          if (!text) continue;
          const op: FrameworkCopyOp = { kind: 'OBJECTIVE', targetControlId: targetId, sourceControlId: sourceId, sourceKey: o.objectiveId, relation: target.relation, chars: text.length, sourceUpdatedAt: o.updatedAt ?? null };
          if (o.narrativeSha256) op.sha256 = o.narrativeSha256;
          if (consider(op, o.narrativeSha256)) { item.objectives.count++; item.objectives.chars += text.length; }
        }
      }
      if (include.evidence) {
        for (const e of evidenceByControl.get(sourceId) ?? []) {
          if (!e.copyable) continue;
          if (e.available === false) { item.evidence.unavailable++; evidenceUnavailable++; continue; }
          const size = Number.isFinite(e.sizeBytes) && e.sizeBytes > 0 ? e.sizeBytes : 0;
          const op: FrameworkCopyOp = { kind: 'EVIDENCE', targetControlId: targetId, sourceControlId: sourceId, sourceKey: e.id, relation: target.relation, bytes: size };
          if (e.fileHash) op.sha256 = e.fileHash;
          if (consider(op)) { item.evidence.count++; item.evidence.bytes += size; }
        }
      }
      if (include.tools) {
        for (const toolId of toolsByControl.get(sourceId) ?? []) {
          if (consider({ kind: 'TOOL', targetControlId: targetId, sourceControlId: sourceId, sourceKey: toolId, relation: target.relation })) item.tools++;
        }
      }
      if (include.documents) {
        for (const documentId of docsByControl.get(sourceId) ?? []) {
          if (consider({ kind: 'DOCUMENT', targetControlId: targetId, sourceControlId: sourceId, sourceKey: documentId, relation: target.relation })) item.documents++;
        }
      }
      if (item.ops.length > opsBefore) item.sources.push(ref);
      itemsByTarget.set(targetId, item);
    }
  }

  const items = [...itemsByTarget.values()].filter((it) => it.ops.length > 0);
  for (const it of items) {
    it.sources.sort((a, b) => cmpStr(a.controlId, b.controlId));
    it.ops.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || cmpStr(a.sourceKey, b.sourceKey) || cmpStr(a.sourceControlId, b.sourceControlId));
  }
  items.sort((a, b) => cmpStr(a.targetControlId, b.targetControlId));

  const targeted = new Set<string>();
  for (const entry of Object.values(mapping)) for (const t of entry.targets) targeted.add(t.id);
  const newInR3 = [...input.newInR3].filter((id) => targetCatalog.has(id) && !targeted.has(id)).sort(cmpStr);

  const totals = {
    controls: items.length,
    notes: 0, objectives: 0, evidenceFiles: 0, evidenceBytes: 0, evidenceUnavailable, tools: 0, documents: 0,
    alreadyCopied: alreadyCopiedTotal, changedSinceCopy: changedTotal, tooLarge: false,
  };
  for (const it of items) {
    totals.notes += it.notes.count;
    totals.objectives += it.objectives.count;
    totals.evidenceFiles += it.evidence.count;
    totals.evidenceBytes += it.evidence.bytes;
    totals.tools += it.tools;
    totals.documents += it.documents;
  }
  totals.tooLarge = totals.evidenceFiles > COPY_MAX_EVIDENCE_FILES || totals.evidenceBytes > COPY_MAX_EVIDENCE_BYTES;

  return {
    items,
    newInR3,
    notCarried: notCarried.sort((a, b) => cmpStr(a.cmmcId, b.cmmcId)),
    mergedInto: mergedInto.sort((a, b) => cmpStr(a.cmmcId, b.cmmcId)),
    skippedTargets: skippedTargets.sort((a, b) => cmpStr(a.controlId, b.controlId) || cmpStr(a.targetId, b.targetId)),
    copiedKeys: [...copiedKeys].sort(cmpStr),
    changedKeys: [...changedKeys].sort(cmpStr),
    totals,
  };
}

// ----- digest

/**
 * The canonical text the plan digest is the SHA-256 of: one line per op (with the source row's updatedAt, the evidence id, size and hash),
 * per existing marker key, per changed key, per unavailable count, per not-carried / merged control and per new Rev. 3 control, each line
 * JSON-encoded and the lines sorted, so the text does not depend on the order of the items. The repo has no synchronous SHA-256 that
 * both the server and the browser can use, so the planner stops at this string and the server hashes it (crypto.createHash('sha256')).
 * planDigest = SHA-256 hex of planDigestInput(plan).
 */
export function planDigestInput(plan: FrameworkCopyPlan): string {
  const lines: string[] = [];
  for (const it of plan.items) {
    for (const op of it.ops) {
      lines.push(JSON.stringify(['op', op.kind, op.targetControlId, op.sourceControlId, op.sourceKey, op.relation, op.chars ?? null, op.bytes ?? null, op.sha256 ?? null, op.sourceUpdatedAt ?? null]));
    }
    lines.push(JSON.stringify(['unavailable', it.targetControlId, it.evidence.unavailable]));
  }
  for (const k of plan.copiedKeys) lines.push(JSON.stringify(['copied', k]));
  for (const k of plan.changedKeys) lines.push(JSON.stringify(['changed', k]));
  for (const n of plan.notCarried) lines.push(JSON.stringify(['notCarried', n.r2, n.cmmcId]));
  for (const m of plan.mergedInto) lines.push(JSON.stringify(['mergedInto', m.r2, m.cmmcId, [...m.targets].sort(cmpStr)]));
  for (const id of plan.newInR3) lines.push(JSON.stringify(['newInR3', id]));
  for (const s of plan.skippedTargets) lines.push(JSON.stringify(['skipped', s.controlId, s.targetId]));
  lines.push(JSON.stringify(['unavailableTotal', plan.totals.evidenceUnavailable]));
  return ['frameworkCopyPlan.v1', ...lines.sort(cmpStr)].join('\n');
}

// ----- suggested status

export interface SuggestionSourceInput {
  status: string;
  relation: string;
  changeType?: string;
  newOdp?: boolean;
}

/**
 * A suggested Rev. 3 status from its Rev. 2 sources. Computed on request, never stored or written. Statuses other than MET, IN_PROGRESS
 * and NOT_MET (NOT_STARTED, and anything else such as a not-applicable marking) contribute nothing: they stop "all MET" from holding and
 * add no NOT_MET, MET or IN_PROGRESS.
 *   no sources                    -> null
 *   any source NOT_MET            -> NOT_MET (any_not_met)
 *   all sources MET               -> MET (all_met_unchanged) only if every source is SAME, NO_SIGNIFICANT_CHANGE or MINOR_CHANGE and has no new ODP;
 *                                    otherwise IN_PROGRESS (all_met_changed)
 *   any source MET / IN_PROGRESS  -> IN_PROGRESS (partial)
 *   otherwise                     -> null
 */
export function suggestR3Status(sources: readonly SuggestionSourceInput[]): { suggested: R3SuggestedStatus; reasonCode: R3SuggestionReason } | null {
  if (sources.length === 0) return null;
  if (sources.some((s) => s.status === 'NOT_MET')) return { suggested: 'NOT_MET', reasonCode: 'any_not_met' };
  if (sources.every((s) => s.status === 'MET')) {
    const unchanged = sources.every((s) => s.relation === 'SAME' && (s.changeType === 'NO_SIGNIFICANT_CHANGE' || s.changeType === 'MINOR_CHANGE') && s.newOdp !== true);
    return unchanged ? { suggested: 'MET', reasonCode: 'all_met_unchanged' } : { suggested: 'IN_PROGRESS', reasonCode: 'all_met_changed' };
  }
  if (sources.some((s) => s.status === 'MET' || s.status === 'IN_PROGRESS')) return { suggested: 'IN_PROGRESS', reasonCode: 'partial' };
  return null;
}

/**
 * One suggestion entry for every Rev. 3 control that has Rev. 2 sources among the source program's controls (`suggested` null when the
 * rule gives none), sorted by control id. Withdrawn requirements with no successor have no target and so no entry.
 */
export function buildR3Suggestions(input: {
  mapping: Record<string, GeneratedR2R3Entry>;
  targetCatalog: ReadonlySet<string>;
  /** Stored source control id -> status. */
  sourceStatuses: ReadonlyMap<string, string>;
}): R3StatusSuggestion[] {
  const byTarget = new Map<string, R3StatusSource[]>();
  for (const [sourceId, status] of [...input.sourceStatuses.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    const r2 = rev2NumberOf(sourceId);
    const entry = r2 ? input.mapping[r2] : undefined;
    if (!entry) continue;
    for (const t of entry.targets) {
      if (!input.targetCatalog.has(t.id)) continue;
      const src: R3StatusSource = { controlId: sourceId, status: status as R3StatusSource['status'], relation: t.relation };
      if (entry.changeType) src.changeType = entry.changeType;
      if (entry.newOdp !== undefined) src.newOdp = entry.newOdp;
      const list = byTarget.get(t.id) ?? [];
      list.push(src);
      byTarget.set(t.id, list);
    }
  }
  return [...byTarget.entries()].sort((a, b) => cmpStr(a[0], b[0])).map(([controlId, sources]) => {
    const s = suggestR3Status(sources);
    return { controlId, suggested: s ? s.suggested : null, reasonCode: s ? s.reasonCode : null, sources };
  });
}
