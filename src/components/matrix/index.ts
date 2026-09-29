/**
 * Canonical re-export hub for matrix / dashboard control components.
 * Prevents duplicate component implementations while maintaining backwards-compatible imports.
 */
export { ControlCard, default as ControlCardDefault } from '../dashboard/ControlCard';
export {
  AssessmentMatrix,
  AssessmentMatrix as ControlMatrix,
  default,
} from '../dashboard/AssessmentMatrix';
export { AssetRemediationDrawer } from '../telemetry/AssetRemediationDrawer';
export { ObjectiveChecklist } from './ObjectiveChecklist';
export { InspectDocumentModal } from './InspectDocumentModal';
