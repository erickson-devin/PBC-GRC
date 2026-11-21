// Where a search result opens (#254): the mapping from a result's `nav` to the tab and the AssessmentContext helpers that show it. Pure: it only describes
// the steps; the component runs them. A screen with no focus helper of its own (assets, POA&M, tools, vendors, documents) gets `pendingFocus`, one generic
// request {kind, id} that the screen consumes. Nothing about the query is kept or put in a URL.

import type { SearchKind, SearchNav } from '../../types/search';

/** The tabs a result can open (names of the app's navigation tabs). */
export type SearchNavTab = 'matrix' | 'evidence' | 'assets' | 'poam' | 'tools' | 'documents';

export interface SearchNavPlan {
  tab: SearchNavTab;
  /** Call setSelectedControlId with it. */
  selectControlId?: string;
  /** Call openControlAtObjective(controlId, objectiveId) (it selects the control itself). */
  openObjective?: { controlId: string; objectiveId: string };
  /** Find the evidence item with this id in the loaded index and call setPreviewEvidence with it. */
  previewEvidenceId?: string;
  /** Ask the screen to scroll to and focus the row. */
  pendingFocus?: { kind: SearchKind; id: string };
}

export function searchNavPlan(nav: SearchNav): SearchNavPlan {
  switch (nav.screen) {
    case 'control':
      return { tab: 'matrix', selectControlId: nav.controlId };
    case 'objective':
      return { tab: 'matrix', openObjective: { controlId: nav.controlId, objectiveId: nav.objectiveId } };
    case 'evidence':
      return { tab: 'evidence', previewEvidenceId: nav.evidenceId };
    case 'asset':
      return { tab: 'assets', pendingFocus: { kind: 'asset', id: nav.assetId } };
    case 'poam_control':
      return { tab: 'poam', pendingFocus: { kind: 'poam_control', id: nav.controlId } };
    case 'poam_vm':
      return { tab: 'poam', pendingFocus: { kind: 'poam_vm', id: nav.itemId } };
    case 'tool':
      return { tab: 'tools', pendingFocus: { kind: 'tool', id: nav.toolId } };
    case 'vendor':
      return { tab: 'tools', pendingFocus: { kind: 'vendor', id: nav.vendorId } };
    case 'document':
      return { tab: 'documents', pendingFocus: { kind: 'document', id: nav.documentId } };
  }
}
