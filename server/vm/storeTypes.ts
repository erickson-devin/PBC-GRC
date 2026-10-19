/**
 * Shapes exchanged between the pure normalization core (transitions.ts, assetMatch.ts) and the storage layer
 * (findingsStore.ts, assets.ts). The core owns the definitions; these are type-only re-exports, erased at compile
 * time, so the storage code gains no runtime dependency on the core.
 */
export type { ApplyRunResult, LinkedPoamItem, PoamCandidate, PoamDraft, SightingDraft } from './transitions';
export type { AgentAssetCandidate, AgentAssetDraft } from './assetMatch';
