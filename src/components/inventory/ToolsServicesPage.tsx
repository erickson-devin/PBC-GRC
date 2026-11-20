import React from 'react';
import { ToolRegisterPanel } from './ToolRegisterPanel';
import { VendorRegisterPanel } from './VendorRegisterPanel';

/** The Tools & Services tab: the Tools and Services register, then the vendor register. Both are organization-wide; each shows its own notice for a browser-only organization. */
export const ToolsServicesPage: React.FC = () => (
  <div className="space-y-4">
    <ToolRegisterPanel />
    <VendorRegisterPanel />
  </div>
);

export default ToolsServicesPage;
