import type { SspInventoryCompletenessInput } from '../data/inventory/sspInventory';
import type { SspDocumentsCompletenessInput } from '../data/documents/sspDocuments';

/**
 * What GET /api/v1/program-summary returns (#251, #252): the facts the client lacks or that are costly to load on every screen. Counts, flags and
 * dates only: never a note, a name, a file name or any text a person typed (it may be CUI).
 */

/** The POA&M target completion date and how much of the open work it covers (#252). */
export interface PoamTargetSummary {
  /** Every control not recorded as Met, plus the open vulnerability items. */
  openCount: number;
  /** Open entries that have a scheduled completion date. */
  datedCount: number;
  /** Open entries with no date: always counted, so a target date is never shown as if it covered them. */
  undatedCount: number;
  /** The latest scheduled completion (YYYY-MM-DD) among the open entries; null when none has a date. */
  latestDate: string | null;
  latestSource: 'control' | 'vulnerability' | null;
  /** Dated open entries whose date is before today. */
  overdueCount: number;
}

export interface ProgramSummary {
  programId: string;
  generatedAt: string;
  people: {
    /** Members at owner level whose access has not ended. */
    ownerLevelMembers: number;
    /** null: the organization records no primary contact field (not available). */
    primaryContactSet: boolean | null;
  };
  /** The register input of SSP sections 1.3 and 1.4 (`supported: true` for a server-backed organization). */
  inventory: SspInventoryCompletenessInput;
  /** The document register input of SSP section 1.3.2 with the recommended counts; null when the framework has no expected-document catalog. */
  documents: (SspDocumentsCompletenessInput & { recommendedPresent: number; recommendedTotal: number }) | null;
  reviews: { reviewed: number; total: number };
  poam: PoamTargetSummary;
}
