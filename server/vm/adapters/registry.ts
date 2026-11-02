import type { IngestPayload } from '../ingestSchema';
import type { VmSourceKind } from '../../../src/types/vm';
import { normalizeFindings, type NormalizedHost } from './wazuh';

/**
 * Source kinds whose payload findings the generic normalizer understands (docs/VULNERABILITY_MANAGEMENT.md, section 6).
 * A new scanner kind needs an entry in VM_SOURCE_KINDS, the contract enum and a line here.
 */
export const FINDINGS_KINDS: readonly VmSourceKind[] = ['WAZUH', 'SENTINELONE', 'ACTION1'];

export type FindingsNormalizer = (payload: IngestPayload) => NormalizedHost[];

/** The normalizer for a kind that reports findings, or null when the kind has none yet. */
export function findingsNormalizerFor(kind: string): FindingsNormalizer | null {
  return (FINDINGS_KINDS as readonly string[]).includes(kind) ? normalizeFindings : null;
}
