/** Shapes of the *.generated.json files written by scripts/generateNist80053.ts. */

export interface GeneratedControl {
  id: string;
  title: string;
  family: string;
  kind: 'BASE' | 'ENHANCEMENT';
  parent?: string;
  /** The official statement, with [Assignment: ...] / [Selection: ...] tags in place of the organization-defined values. */
  statement: string;
  guidance: string;
  /** Baselines (SP 800-53B) that include the control: any of L, M, H. */
  baselines: string;
  privacy: boolean;
  related: string[];
}

export interface GeneratedObjective {
  /** 800-53A label, e.g. "AC-02a.[01]". */
  id: string;
  /** The label without the control, e.g. "a.[01]". */
  letter: string;
  parent?: string;
  /** Determination statement with ODP tags; absent on a pure grouping node. */
  text?: string;
}

export interface GeneratedObjectives {
  objectives: GeneratedObjective[];
  methods: { examine: string[]; interview: string[]; test: string[] };
}

export interface GeneratedMeta {
  generatedBy: string;
  oscalVersion: string;
  oscalCommit: string;
  sources: Record<string, { url: string; sha256: string }>;
  note?: string;
}

export interface GeneratedCatalogFile {
  meta: GeneratedMeta;
  families: Array<{ code: string; title: string }>;
  controls: GeneratedControl[];
}
export interface GeneratedObjectivesFile {
  meta: GeneratedMeta;
  objectives: Record<string, GeneratedObjectives>;
}
export interface GeneratedCrosswalkFile {
  meta: GeneratedMeta;
  /** "3.1.5" -> the SP 800-53 Rev. 5 controls Appendix D relates it to. `rev4` is set when NIST's withdrawn-control link was followed. */
  requirements: Record<string, Array<{ control: string; rev4?: string }>>;
  withdrawnWithoutSuccessor: Record<string, string[]>;
}
