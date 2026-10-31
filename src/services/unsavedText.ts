/**
 * Unsaved text that would be lost when the server ends a session, kept IN MEMORY ONLY so the person can copy it back out.
 *
 * Editors register a provider that reports their unsaved fields. When the server rejects the session, the sign-out path
 * calls rescueUnsavedText() BEFORE it signs out, and the text waits in a module variable (it survives the route change,
 * a provider remount and the editors unmounting). It is cleared by Discard, a page reload, or a different person signing in.
 *
 * The text may be CUI: this module never writes it to browser storage, the console, the audit ledger, history or the
 * network. Labels carry a field name and an id only, never text, a tenant name or a file name.
 */

import { SSP_METADATA_FIELDS } from '../types/sspMetadata';

export interface UnsavedTextEntry {
  key: string;
  label: string;
  text: string;
}

export interface RescuedText {
  ownerUserId: string;
  entries: UnsavedTextEntry[];
}

const providers = new Map<string, () => UnsavedTextEntry[]>();
const listeners = new Set<() => void>();
let rescued: RescuedText | null = null;

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try { listener(); } catch { /* a failing subscriber must not stop the others */ }
  }
}

/** Registers what an editor holds unsaved. The same id replaces the earlier provider. Returns the unregister function. */
export function registerUnsavedTextProvider(id: string, provider: () => UnsavedTextEntry[]): () => void {
  providers.set(id, provider);
  return () => {
    if (providers.get(id) === provider) providers.delete(id);
  };
}

/** Every unsaved field right now: empty text is dropped, a provider that throws is skipped, the first entry per key wins. */
export function collectUnsavedText(): UnsavedTextEntry[] {
  const seen = new Set<string>();
  const out: UnsavedTextEntry[] = [];
  for (const provider of Array.from(providers.values())) {
    let entries: UnsavedTextEntry[];
    try { entries = provider(); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) continue;
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      out.push({ key: entry.key, label: entry.label, text: entry.text });
    }
  }
  return out;
}

/** Moves the unsaved text into the rescue store for this user. Returns how many fields were collected (0 leaves the store as it was). */
export function rescueUnsavedText(ownerUserId: string): number {
  const collected = collectUnsavedText();
  if (collected.length === 0) return 0;
  // Text rescued earlier for the same person stays; newer text wins per key. A different owner replaces it.
  const base = rescued && rescued.ownerUserId === ownerUserId ? rescued.entries : [];
  const merged = new Map<string, UnsavedTextEntry>();
  for (const entry of base) merged.set(entry.key, entry);
  for (const entry of collected) merged.set(entry.key, entry);
  rescued = { ownerUserId, entries: Array.from(merged.values()) };
  notify();
  return collected.length;
}

/** The current rescue (the same object until it changes, so useSyncExternalStore does not loop). */
export function getRescuedText(): RescuedText | null {
  return rescued;
}

export function subscribeRescuedText(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function discardRescuedText(): void {
  if (rescued === null) return;
  rescued = null;
  notify();
}

/** A different person signing in must never see the previous person's text. */
export function reconcileRescuedTextOnSignIn(userId: string): void {
  if (rescued && rescued.ownerUserId !== userId) discardRescuedText();
}

/** The text itself is shown only to the person it belongs to, once they are signed in again. */
export function canRevealRescued(rescue: RescuedText | null, isAuthenticated: boolean, currentUserId: string | null | undefined): boolean {
  return Boolean(rescue && isAuthenticated && currentUserId && rescue.ownerUserId === currentUserId);
}

/** All fields as one block of text: `label`, a blank line, the text; fields separated by a rule. */
export function formatRescuedText(entries: Array<{ label: string; text: string }>): string {
  return entries.map((e) => `${e.label}\n\n${e.text}`).join('\n\n---\n\n');
}

/** Implementation notes typed locally that the server does not have. Nothing to compare against (null) means nothing is reported. */
export function unsavedControlNotes(
  controls: Record<string, { implementationNotes?: string | null } | undefined>,
  liveControls: Record<string, { implementationNotes?: string | null } | undefined> | null | undefined,
): UnsavedTextEntry[] {
  if (!liveControls) return [];
  const out: UnsavedTextEntry[] = [];
  for (const id of Object.keys(controls)) {
    const local = controls[id]?.implementationNotes ?? '';
    if (!local) continue;
    const live = liveControls[id]?.implementationNotes ?? '';
    if (local !== live) out.push({ key: `control:${id}:notes`, label: `Implementation notes, ${id}`, text: local });
  }
  return out;
}

/** Objective narratives being edited that differ from the stored ones. */
export function unsavedObjectiveDrafts(editing: Record<string, string>, storedById: Record<string, string | null | undefined>): UnsavedTextEntry[] {
  const out: UnsavedTextEntry[] = [];
  for (const id of Object.keys(editing)) {
    const draft = editing[id] ?? '';
    if (!draft) continue;
    if (draft !== (storedById[id] ?? '')) out.push({ key: `objective:${id}:narrative`, label: `Objective narrative, ${id}`, text: draft });
  }
  return out;
}

/** Edits to the staged AI text of an SSP import that were not saved. A draft equal to the shown text is not an edit. */
export function unsavedSspImportDrafts(
  drafts: Record<string, string>,
  staged: ReadonlyArray<{ id: string; controlId: string; editedNotes?: string | null; suggestedNotes?: string | null }>,
): UnsavedTextEntry[] {
  const out: UnsavedTextEntry[] = [];
  for (const row of staged) {
    const draft = drafts[row.id];
    if (typeof draft !== 'string' || !draft) continue;
    if (draft !== (row.editedNotes ?? row.suggestedNotes ?? '')) {
      out.push({ key: `sspimport:${row.id}:notes`, label: `SSP import edit, ${row.controlId}`, text: draft });
    }
  }
  return out;
}

/** The program description and boundary summary in a form, against what is saved. `programId` null = a program being created. */
export function unsavedProgramFields(
  current: { description: string; boundarySummary: string },
  saved: { description?: string | null; boundarySummary?: string | null },
  programId: string | null,
): UnsavedTextEntry[] {
  const id = programId ?? '(new program)';
  const keyId = programId ?? 'new';
  const out: UnsavedTextEntry[] = [];
  if (current.description && current.description !== (saved.description ?? '')) {
    out.push({ key: `program:${keyId}:description`, label: `Program description, ${id}`, text: current.description });
  }
  if (current.boundarySummary && current.boundarySummary !== (saved.boundarySummary ?? '')) {
    out.push({ key: `program:${keyId}:boundary`, label: `Program boundary summary, ${id}`, text: current.boundarySummary });
  }
  return out;
}

/** SSP metadata fields being edited that differ from the server's copy. No live copy loaded (null) means nothing is reported. */
export function unsavedSspMetadataFields(
  draft: Partial<Record<string, string | null | undefined>>,
  saved: Partial<Record<string, string | null | undefined>> | null | undefined,
  programId: string,
): UnsavedTextEntry[] {
  if (!saved) return [];
  const out: UnsavedTextEntry[] = [];
  for (const field of SSP_METADATA_FIELDS) {
    const text = draft[field] ?? '';
    if (!text) continue;
    if (text !== (saved[field] ?? '')) out.push({ key: `ssp:${programId}:${field}`, label: `SSP field, ${field}`, text });
  }
  return out;
}

/** Tests only. */
export function resetUnsavedText(): void {
  providers.clear();
  listeners.clear();
  rescued = null;
}
