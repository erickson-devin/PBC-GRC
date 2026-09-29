import React from 'react';
import { InspectDocumentModal } from '../matrix/InspectDocumentModal';

/**
 * ControlDetailModal - Unified Control Inspector
 * Delegates to InspectDocumentModal containing NIST SP 800-171A Objective-Level Evaluation,
 * C3PAO Assessment Method banner, and Pre-Filled Best-Practice Narrative Engine.
 */
export const ControlDetailModal: React.FC = () => {
  return <InspectDocumentModal />;
};

export default ControlDetailModal;
