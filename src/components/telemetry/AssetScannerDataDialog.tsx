import React from 'react';
import { Radar, X } from 'lucide-react';
import type { EnclaveAsset } from '../../types/telemetry';
import { OBSERVED_COPY } from '../../data/telemetry/observedInventoryView';
import { useObservedInventory } from '../../hooks/useObservedInventory';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ObservedInventoryPanel } from './ObservedInventoryPanel';
import { ObservedSoftwareList } from './ObservedSoftwareList';

interface AssetScannerDataDialogProps {
  asset: EnclaveAsset;
  tenantId: string;
  /** A Tenant Owner or MSP Admin: only the wording differs, the dialog is read-only for everyone. */
  canEdit: boolean;
  onClose: () => void;
}

/** What the scanners report for one asset (host inventory and installed software), read-only, open to every role of a server-backed tenant. */
export const AssetScannerDataDialog: React.FC<AssetScannerDataDialogProps> = ({ asset, tenantId, canEdit, onClose }) => {
  const inventory = useObservedInventory(tenantId, asset.id, true);

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div aria-hidden="true" className="absolute inset-0" onClick={onClose} />

      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <Radar className="w-5 h-5" aria-hidden="true" />
            </div>
            <DialogTitle as="h2" className="text-base font-bold text-white">Scanner data: {asset.hostName}</DialogTitle>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <ObservedInventoryPanel
          status={inventory.status}
          hosts={inventory.hosts}
          recorded={asset}
          note={canEdit ? OBSERVED_COPY.viewNoteEditor : OBSERVED_COPY.viewNoteReadOnly}
          onRetry={inventory.reload}
        />

        {inventory.status !== 'gone' && <ObservedSoftwareList tenantId={tenantId} assetId={asset.id} />}

        <div className="pt-3 border-t border-slate-800 flex justify-end">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 transition-colors text-xs">Close</button>
        </div>
      </div>
    </DialogOverlay>
  );
};
