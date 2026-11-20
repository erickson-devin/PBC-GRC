/**
 * DoD default values for the organization-defined parameters (ODPs) of NIST SP 800-171 Rev. 3, from the DoD CIO memorandum
 * "Organization-Defined Parameters for NIST SP 800-171 Revision 3".
 *
 * NOTHING SHIPS HERE YET. The table is empty and `meta.verified` is false. The rule for filling it in:
 *   - a value is used only when `meta.verified` and the entry's own `verified` are both true (see odp.ts);
 *   - an entry is transcribed from the memo by a person and checked against the memo by a second person; a model never writes
 *     or "recalls" a value, and nobody enters a value from memory;
 *   - `meta` records where the memo came from (date, url, sha256 of the PDF) and who transcribed and verified it; the generator's
 *     --check fails when `meta.verified` is true and date, url or sha256 is empty;
 *   - the key is the bracket ODP id ("A.03.01.01.ODP[01]") and `page` the memo page it was read from;
 *   - an ODP whose placement is NESTED or OBJECTIVES has no statement tag of its own and cannot take a default.
 */
export interface DodOdpEntry {
  value: string;
  page: number;
  verified: boolean;
}

export interface DodOdpDefaults {
  meta: {
    source: string;
    date: string;
    url: string;
    sha256: string;
    transcribedBy: string;
    verifiedBy: string;
    verified: boolean;
  };
  values: Record<string, DodOdpEntry>;
}

export const DOD_ODP_DEFAULTS: DodOdpDefaults = {
  meta: { source: 'DoD CIO memorandum, Organization-Defined Parameters for NIST SP 800-171 Revision 3', date: '', url: '', sha256: '', transcribedBy: '', verifiedBy: '', verified: false },
  values: {},
};
