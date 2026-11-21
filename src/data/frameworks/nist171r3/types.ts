import type { GeneratedMeta, GeneratedObjectivesFile } from '../nist80053/types';

/**
 * Shapes of the *.generated.json files written by scripts/generateNist171r3.ts (NIST SP 800-171 Rev. 3, its SP 800-171A
 * assessment objectives, and the Rev. 2 -> Rev. 3 change analysis).
 *
 * Identifiers:
 *   requirement id   the OSCAL "sort-id": "03.01.01" (two digits per part, leading zeros kept)
 *   Rev. 2 id        "3.1.1" (no leading zeros), the key of the mapping file
 *   ODP id           the OSCAL bracket label: "A.03.01.01.ODP[01]" (OSCAL's own param id is "A.03.01.01.ODP.01")
 *
 * `meta` is the shared GeneratedMeta of the SP 800-53 files: `oscalVersion` holds the catalog's content version (as it does there),
 * `oscalCommit` the pinned usnistgov/oscal-content commit, `sources` the url and sha256 of every file the generator read.
 */

export type R3Relation = 'SAME' | 'INCORPORATED_INTO' | 'ADDRESSED_BY';
export type R3ChangeType = 'NO_SIGNIFICANT_CHANGE' | 'MINOR_CHANGE' | 'SIGNIFICANT_CHANGE';

export interface GeneratedR3Requirement {
  /** "03.01.01" */
  id: string;
  title: string;
  /** Family code, "03.01". */
  family: string;
  /** The official statement, items flattened one per line ("a. ...", indented "  1. ..."), with [Assignment: ...] / [Selection ...: ...] tags in place of the ODPs. */
  statement: string;
  /** The "guidance" part of the OSCAL catalog (NIST's discussion), cross-reference markup removed. */
  discussion: string;
  /** The ODP ids in the order of the outermost tags of `statement`: odps[n - 1] is the ODP of the tag parseParameterTags numbers `<id>#n`. */
  odps: string[];
}

export interface GeneratedR3Odp {
  /** The requirement the ODP belongs to. */
  requirement: string;
  /** 1-based number of the outermost tag in the statement (the `#n` of `<id>#n`). null when the ODP has no tag of its own: see `placement`. */
  tag: number | null;
  /**
   * TAG         an outermost tag of the statement
   * NESTED      an Assignment inside the choices of a Selection tag (`tag` is null, `parentTag` the number of that Selection)
   * OBJECTIVES  not in the statement at all: only the SP 800-171A determination statements use it
   */
  placement: 'TAG' | 'NESTED' | 'OBJECTIVES';
  parentTag?: number;
  /** What the ODP asks for ("time period", "frequency"); "Selection" for a Selection. */
  label: string;
  kind: 'ASSIGNMENT' | 'SELECTION';
  /** NIST's own sentence for the ODP ("the time period for account inactivity before disabling is defined."), where it gives one. */
  guideline?: string;
}

export interface GeneratedR3Withdrawn {
  id: string;
  relation: Exclude<R3Relation, 'SAME'>;
}

export interface GeneratedR3CatalogFile {
  meta: GeneratedMeta;
  families: Array<{ code: string; title: string }>;
  /** Active requirements only, in id order. */
  requirements: GeneratedR3Requirement[];
  /** Every ODP of the catalog by ODP id. */
  odps: Record<string, GeneratedR3Odp>;
  /** Withdrawn requirement id -> where NIST moved it (empty when it was withdrawn without a successor), from the OSCAL links. */
  withdrawn: Record<string, GeneratedR3Withdrawn[]>;
}

/**
 * SP 800-171A Rev. 3, requirement id -> determination statements and assessment methods. This is the shape of the SP 800-53A file
 * (GeneratedObjectives): `id` is "A.03.01.01.b.01" (or "A.03.01.01.ODP[01]" for an ODP statement), `letter` is the app's letter
 * ("b01", "odp01"), already normalised and unique within the requirement. The objectives are flat (no `parent`).
 */
export type GeneratedR3ObjectivesFile = GeneratedObjectivesFile;

export interface GeneratedR2R3Target {
  /** An active Rev. 3 requirement id. */
  id: string;
  relation: R3Relation;
}

export interface GeneratedR2R3Entry {
  targets: GeneratedR2R3Target[];
  /** Set for a requirement Rev. 3 carries (not withdrawn). */
  changeType?: R3ChangeType;
  /** Set for a requirement Rev. 3 carries: true when Rev. 3 added an ODP to it. */
  newOdp?: boolean;
  /** True when Rev. 3 withdrew the requirement and no active Rev. 3 row stands for it. */
  withdrawn?: true;
}

export interface GeneratedR2R3File {
  meta: GeneratedMeta;
  /** Rev. 2 requirement ("3.1.1") -> what Rev. 3 made of it. One entry per Rev. 2 requirement. */
  requirements: Record<string, GeneratedR2R3Entry>;
  /** Rev. 2 requirements Rev. 3 withdrew without naming a successor (NIST recategorised them as NCO or addressed them by SP 800-53). */
  withdrawnWithoutSuccessor: Record<string, true>;
  /** Active Rev. 3 requirements no Rev. 2 requirement leads to. */
  newInR3: string[];
  /** Places the NIST workbook disagrees with itself and the generator followed the catalog or the Rev. 3 identifier instead. */
  corrections: string[];
}
