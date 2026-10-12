import React, { useState, useEffect } from 'react';
import {
  X,
  Server,
  Monitor,
  AlertTriangle,
  Wifi,
} from 'lucide-react';
import {
  EnclaveAsset,
  EnclaveAssetOsProfile,
  CmmcAssetCategory,
  EnclaveAssetStatus,
} from '../../types/telemetry';
import { CATEGORY_INFO, CMMC_ASSET_CATEGORIES } from '../../data/telemetry/assetScope';
import { errorMessage } from '../../utils/errors';

interface AddAssetModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Resolves when the asset is saved. A rejection is shown in the form, which stays open so nothing typed is lost. */
  onSave: (asset: Omit<EnclaveAsset, 'id'>) => Promise<void> | void;
  initialAsset?: EnclaveAsset | null;
  tenantId: string;
}

export const AddAssetModal: React.FC<AddAssetModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialAsset,
  tenantId,
}) => {
  const [hostName, setHostName] = useState('');
  const [ipAddress, setIpAddress] = useState('');
  const [macAddress, setMacAddress] = useState('');
  const [osProfile, setOsProfile] = useState<EnclaveAssetOsProfile>('rhel9');
  const [cmmcAssetCategory, setCmmcAssetCategory] = useState<CmmcAssetCategory>('CUI_ASSET');
  const [status, setStatus] = useState<EnclaveAssetStatus>('NEVER_SCANNED');
  const [notes, setNotes] = useState('');
  const [owner, setOwner] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialAsset) {
      setHostName(initialAsset.hostName);
      setIpAddress(initialAsset.ipAddress);
      setMacAddress(initialAsset.macAddress || '');
      setOsProfile(initialAsset.osProfile as EnclaveAssetOsProfile);
      setCmmcAssetCategory(initialAsset.cmmcAssetCategory);
      setStatus(initialAsset.status);
      setNotes(initialAsset.notes || '');
      setOwner(initialAsset.owner || '');
    } else {
      setHostName('');
      setIpAddress('');
      setMacAddress('');
      setOsProfile('rhel9');
      setCmmcAssetCategory('CUI_ASSET');
      setStatus('NEVER_SCANNED');
      setNotes('');
      setOwner('');
    }
    setError(null);
    setSaving(false);
  }, [initialAsset, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hostName.trim()) {
      setError('Asset name is required.');
      return;
    }
    if (!ipAddress.trim()) {
      setError('IP address is required.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        tenantId,
        hostName: hostName.trim(),
        ipAddress: ipAddress.trim(),
        // Left blank when unknown: an invented address would be stored as if it were real
        macAddress: macAddress.trim(),
        osProfile,
        cmmcAssetCategory,
        status: initialAsset ? status : 'NEVER_SCANNED',
        sourceOrigin: initialAsset?.sourceOrigin || 'MANUAL_ENTRY',
        discoveryStatus: initialAsset?.discoveryStatus || 'ACTIVE',
        lastScannedAt: initialAsset?.lastScannedAt || null,
        complianceScore: initialAsset?.complianceScore !== undefined ? initialAsset.complianceScore : null,
        notes: notes.trim(),
        owner: owner.trim(),
        isManuallyAdded: true,
      });
      onClose();
    } catch (err: unknown) {
      setError(errorMessage(err) || 'The asset could not be saved.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      {/* Click outside backdrop */}
      <div className="absolute inset-0" onClick={onClose} />

      <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-5">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                {initialAsset ? 'Edit Enclave Asset' : 'Register Enclave Asset'}
              </h2>
              <p className="text-xs text-slate-400">
                Describe the asset and assign its CMMC scoping category.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div role="alert" className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          
          {/* Hostname & IP Address */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-300 mb-1.5">
                Asset name / hostname <span className="text-rose-400">*</span>
              </label>
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  type="text"
                  required
                  value={hostName}
                  onChange={e => setHostName(e.target.value)}
                  placeholder="e.g. WS-SEC-05"
                  className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block font-semibold text-slate-300 mb-1.5">
                IP Address <span className="text-rose-400">*</span>
              </label>
              <div className="flex items-center gap-2">
                <Wifi className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  type="text"
                  required
                  value={ipAddress}
                  onChange={e => setIpAddress(e.target.value)}
                  placeholder="e.g. 10.0.50.35"
                  className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
                />
              </div>
            </div>
          </div>

          {/* MAC Address (Optional) & OS Profile */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-300 mb-1.5">
                MAC Address <span className="text-slate-400 font-normal">(Optional)</span>
              </label>
              <input
                type="text"
                value={macAddress}
                onChange={e => setMacAddress(e.target.value)}
                placeholder="52:54:00:12:34:56"
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-300 mb-1.5">
                OS Platform Profile
              </label>
              <select
                value={osProfile}
                onChange={e => setOsProfile(e.target.value as EnclaveAssetOsProfile)}
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-cyan-500"
              >
                <option value="rhel9">Red Hat Enterprise Linux 9</option>
                <option value="rhel8">Red Hat Enterprise Linux 8</option>
                <option value="ubuntu2204">Ubuntu 22.04 LTS</option>
                <option value="win2022">Windows Server 2022</option>
                <option value="win11">Windows 11 Enterprise</option>
                <option value="cisco_ios">Cisco IOS / Network Device</option>
                <option value="custom">Custom / Appliance</option>
              </select>
            </div>
          </div>

          {/* CMMC Scope Category */}
          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">
              CMMC 2.0 asset category
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="CMMC asset category">
              {CMMC_ASSET_CATEGORIES.map(cat => (
                <button
                  type="button"
                  key={cat}
                  role="radio"
                  aria-checked={cmmcAssetCategory === cat}
                  onClick={() => setCmmcAssetCategory(cat)}
                  className={`text-left p-2.5 rounded-xl border transition-all ${
                    cmmcAssetCategory === cat
                      ? 'bg-cyan-950/40 border-cyan-500/60 ring-1 ring-cyan-500/30'
                      : 'bg-slate-800/40 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <p className="font-bold text-white text-xs">{CATEGORY_INFO[cat].label}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{CATEGORY_INFO[cat].description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Owner */}
          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">
              Owner <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <input
              type="text"
              value={owner}
              onChange={e => setOwner(e.target.value)}
              placeholder="e.g. IT Operations, or Jordan Lee"
              className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
          </div>

          {/* Administrative Notes */}
          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">
              Description
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Dell PowerEdge R650, Rack 4 Enclave Node, designated for CUI enclave workloads."
              className="w-full bg-slate-800/80 border border-slate-700 rounded-lg p-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
          </div>

          {/* Actions */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 text-white font-bold transition-all shadow-md shadow-cyan-950/40 disabled:opacity-60"
            >
              {saving ? 'Saving…' : initialAsset ? 'Save Changes' : 'Register Asset'}
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
