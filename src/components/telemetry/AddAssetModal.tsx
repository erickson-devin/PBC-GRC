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

interface AddAssetModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (asset: Omit<EnclaveAsset, 'id'>) => void;
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
    } else {
      setHostName('');
      setIpAddress('');
      setMacAddress('');
      setOsProfile('rhel9');
      setCmmcAssetCategory('CUI_ASSET');
      setStatus('NEVER_SCANNED');
      setNotes('');
    }
    setError(null);
  }, [initialAsset, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hostName.trim()) {
      setError('Hostname is required.');
      return;
    }
    if (!ipAddress.trim()) {
      setError('IP address is required.');
      return;
    }

    onSave({
      tenantId,
      hostName: hostName.trim(),
      ipAddress: ipAddress.trim(),
      macAddress: macAddress.trim() || `52:54:00:${Math.random().toString(16).slice(2, 6).toUpperCase()}:${Math.random().toString(16).slice(2, 4).toUpperCase()}`,
      osProfile,
      cmmcAssetCategory,
      status: initialAsset ? status : 'NEVER_SCANNED',
      sourceOrigin: initialAsset?.sourceOrigin || 'MANUAL_ENTRY',
      discoveryStatus: initialAsset?.discoveryStatus || 'ACTIVE',
      lastScannedAt: initialAsset?.lastScannedAt || null,
      complianceScore: initialAsset?.complianceScore !== undefined ? initialAsset.complianceScore : null,
      notes: notes.trim(),
      isManuallyAdded: true,
    });

    onClose();
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
                {initialAsset ? 'Edit Enclave Endpoint' : 'Register New Enclave Endpoint'}
              </h2>
              <p className="text-xs text-slate-400">
                Configure hardware node & CMMC 2.0 scoping baseline.
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
          <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
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
                Hostname / FQDN <span className="text-rose-400">*</span>
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
              CMMC 2.0 Scoping Scope Category
            </label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: 'CUI_ASSET', label: 'CUI Asset', desc: 'Processes, stores, or transmits CUI' },
                { id: 'SECURITY_PROTECTION', label: 'Security Protection', desc: 'Firewall, SIEM, IAM, Bastion' },
                { id: 'CONTRACTOR_RISK', label: 'Contractor Risk', desc: 'Managed contractor asset' },
                { id: 'OUT_OF_SCOPE', label: 'Out of Scope', desc: 'Logically separated network' },
              ].map(cat => (
                <div
                  key={cat.id}
                  onClick={() => setCmmcAssetCategory(cat.id as CmmcAssetCategory)}
                  className={`p-2.5 rounded-xl border cursor-pointer transition-all ${
                    cmmcAssetCategory === cat.id
                      ? 'bg-cyan-950/40 border-cyan-500/60 ring-1 ring-cyan-500/30'
                      : 'bg-slate-800/40 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <p className="font-bold text-white text-xs">{cat.label}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{cat.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Administrative Notes */}
          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">
              Hardware Notes & Role Specification
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
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 text-white font-bold transition-all shadow-md shadow-cyan-950/40"
            >
              {initialAsset ? 'Save Changes' : 'Register Endpoint'}
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
