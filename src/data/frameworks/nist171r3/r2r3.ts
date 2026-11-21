import r2r3File from './r2r3.generated.json';
import type { GeneratedR2R3Entry, GeneratedR2R3File, R3ChangeType, R3Relation } from './types';
import { canonicalJson, computeSha256 } from '../../audit/cryptoUtils';

/**
 * The NIST SP 800-171 Rev. 2 -> Rev. 3 mapping (NIST's change analysis workbook, the successors of withdrawn requirements from
 * the OSCAL catalog), for "copy from Rev. 2". It is deliberately a module of its own: it must not import frameworkRegistry or
 * controlMappings, and it must never be added to controlMappings.ts (those rows seed the database and drive evidence
 * inheritance). Rev. 2 ids here are the plain "3.1.1" numbers; Rev. 3 ids are "03.01.01".
 */
const file = r2r3File as unknown as GeneratedR2R3File;

/** Where the mapping comes from: the pinned OSCAL commit and the url and sha256 of each source file. */
export const R2R3_PROVENANCE = file.meta;

/**
 * Identifies the mapping content. There is no synchronous SHA-256 in the shared code (Web Crypto is asynchronous), so this is
 * the OSCAL commit plus the sha256 of each source file; r2r3MappingSha256() gives a digest of the mapping itself.
 */
export const R2R3_MAPPING_VERSION: string = [
  file.meta.oscalCommit,
  ...Object.keys(file.meta.sources)
    .sort()
    .map((k) => file.meta.sources[k].sha256),
].join(':');

/** A stable SHA-256 of the mapping content (a canonical JSON string of the requirements, the two lists and the corrections). */
export function r2r3MappingSha256(): Promise<string> {
  return computeSha256(canonicalJson({ requirements: file.requirements, withdrawnWithoutSuccessor: file.withdrawnWithoutSuccessor, newInR3: file.newInR3 }));
}

export interface R2R3Target {
  id: string;
  relation: R3Relation;
  /** Carried by a requirement Rev. 3 keeps, absent on a withdrawn one. */
  changeType?: R3ChangeType;
  newOdp?: boolean;
}

export interface R2R3Source {
  /** "3.1.13" */
  r2: string;
  relation: R3Relation;
  changeType?: R3ChangeType;
  newOdp?: boolean;
}

const entries = file.requirements;
const sourcesIndex = new Map<string, R2R3Source[]>();
for (const r2 of Object.keys(entries)) {
  const e: GeneratedR2R3Entry = entries[r2];
  for (const t of e.targets) {
    const list = sourcesIndex.get(t.id) ?? [];
    list.push({ r2, relation: t.relation, ...(e.changeType ? { changeType: e.changeType } : {}), ...(e.newOdp !== undefined ? { newOdp: e.newOdp } : {}) });
    sourcesIndex.set(t.id, list);
  }
}

/** The Rev. 3 requirements a Rev. 2 requirement ("3.1.13") became. [] for one Rev. 3 withdrew without a successor or for an unknown id. */
export function r3TargetsForR2(num: string): R2R3Target[] {
  const e = entries[(num ?? '').trim()];
  if (!e) return [];
  return e.targets.map((t) => ({ id: t.id, relation: t.relation, ...(e.changeType ? { changeType: e.changeType } : {}), ...(e.newOdp !== undefined ? { newOdp: e.newOdp } : {}) }));
}

/** The Rev. 2 requirements that lead to a Rev. 3 requirement ("03.01.13"). [] for a requirement that is new in Rev. 3. */
export function r2SourcesForR3(r3Id: string): R2R3Source[] {
  return (sourcesIndex.get((r3Id ?? '').trim()) ?? []).map((s) => ({ ...s }));
}

/** The active Rev. 3 requirements no Rev. 2 requirement leads to. */
export function newInR3(): string[] {
  return [...file.newInR3];
}

/** The Rev. 2 requirements Rev. 3 withdrew without naming a successor. */
export function withdrawnWithoutSuccessor(): string[] {
  return Object.keys(file.withdrawnWithoutSuccessor);
}

/** The raw mapping: Rev. 2 requirement -> what Rev. 3 made of it (one entry per Rev. 2 requirement). */
export function r2r3Mapping(): Record<string, GeneratedR2R3Entry> {
  return entries;
}
