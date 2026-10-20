import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  Paperclip,
  Upload,
  Search,
  Eye,
  Download,
  Trash2,
  FileText,
  FileImage,
  FileCode,
  File,
  Shield,
  HardDrive,
  Building,
  Lock,
  Copy,
  Check,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { FRAMEWORK_REGISTRY, findControlDefinition } from '../../data/frameworks';
import { EvidenceItem } from '../../types/cmmc';
import { EvidenceVault } from '../../services/evidenceVault';

import { copyToClipboard } from '../../utils/clipboard';
export const EvidenceVaultView: React.FC = () => {
  const {
    state,
    frameworkControls,
    uploadEvidence,
    removeEvidence,
    setPreviewEvidence,
    setSelectedControlId,
  } = useAssessment();

  const { currentTenant, canEdit, activeFramework } = useTenant();

  const currentFrameworkDef = useMemo(() => {
    return FRAMEWORK_REGISTRY[activeFramework] || FRAMEWORK_REGISTRY.CMMC_L1;
  }, [activeFramework]);

  const availableDomains = useMemo(() => {
    return Object.values(currentFrameworkDef.domains || {});
  }, [currentFrameworkDef]);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedDomain, setSelectedDomain] = useState<string>('ALL');
  const [targetControlId, setTargetControlId] = useState<string>(() => frameworkControls[0]?.id || 'AC.L1-3.1.1');
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Synchronize targetControlId when framework controls change
  useEffect(() => {
    if (frameworkControls.length > 0 && !frameworkControls.some(c => c.id === targetControlId)) {
      setTargetControlId(frameworkControls[0].id);
    }
  }, [frameworkControls, targetControlId]);

  // Storage calculation
  const totalBytes = useMemo(() => {
    return state.evidenceIndex.reduce((acc, curr) => acc + curr.fileSize, 0);
  }, [state.evidenceIndex]);

  const coveredControlsCount = useMemo(() => {
    const set = new Set(state.evidenceIndex.map((e) => e.controlId));
    return set.size;
  }, [state.evidenceIndex]);

  // Filtered evidence items
  const filteredItems = useMemo(() => {
    return state.evidenceIndex.filter((item) => {
      const ctrl = findControlDefinition(item.controlId);
      if (selectedDomain !== 'ALL' && ctrl && ctrl.domain !== selectedDomain) {
        return false;
      }
      if (searchQuery.trim() !== '') {
        const q = searchQuery.toLowerCase();
        const matchesName = item.name.toLowerCase().includes(q);
        const matchesCtrl = item.controlId.toLowerCase().includes(q);
        const matchesDesc = (item.description || '').toLowerCase().includes(q);
        const matchesHash = (item.fileHash || '').toLowerCase().includes(q);
        if (!matchesName && !matchesCtrl && !matchesDesc && !matchesHash) {
          return false;
        }
      }
      return true;
    });
  }, [state.evidenceIndex, selectedDomain, searchQuery]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canEdit) {
      alert('Read-Only access: You do not have permission to upload evidence.');
      return;
    }

    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        await uploadEvidence(targetControlId, files[i]);
      }
    } catch (err) {
      console.error('Upload failed:', err);
      alert('Failed to upload evidence file.');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDownloadFile = async (item: EvidenceItem) => {
    const fileData = await EvidenceVault.getFile(currentTenant.id, item.id);
    if (!fileData) {
      alert('This evidence file does not have local binary storage attached (metadata reference only).');
      return;
    }
    const url = URL.createObjectURL(fileData.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyHash = (hash?: string) => {
    if (!hash) return;
    copyToClipboard(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const getFileIcon = (mimeType: string, filename: string) => {
    if (mimeType.includes('image') || filename.endsWith('.png') || filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
      return <FileImage className="w-5 h-5 text-purple-400" />;
    }
    if (mimeType.includes('pdf') || filename.endsWith('.pdf')) {
      return <FileText className="w-5 h-5 text-rose-400" />;
    }
    if (filename.endsWith('.csv') || filename.endsWith('.xlsx') || filename.endsWith('.json')) {
      return <FileCode className="w-5 h-5 text-emerald-400" />;
    }
    return <File className="w-5 h-5 text-brand-400" />;
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2.5">
            <Paperclip className="w-6 h-6 text-brand-400" />
            Evidence Vault (Local)
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Tenant-isolated evidence storage with client-side SHA-256 immutability verification for <strong>{currentTenant.name}</strong>.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-xl bg-slate-900 border border-slate-800 text-xs text-brand-300 font-mono flex items-center gap-1.5">
            <Building className="w-3.5 h-3.5" />
            {currentTenant.cageCode || 'CAGE'}
          </span>
          <span className="px-3 py-1 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-400 font-mono flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5" />
            Local Vault
          </span>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Tenant Evidence Files</span>
          <p className="text-3xl font-extrabold text-white font-mono mt-1">{state.evidenceIndex.length}</p>
          <p className="text-xs text-slate-400 mt-1">Tenant Scoped: <span className="font-mono text-brand-300">{currentTenant.id}</span></p>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Control Coverage</span>
          <p className="text-3xl font-extrabold text-brand-400 font-mono mt-1">{coveredControlsCount} / 17</p>
          <p className="text-xs text-slate-400 mt-1">Practices backed by audit artifacts</p>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Vault Storage Tracked</span>
          <p className="text-3xl font-extrabold text-purple-400 font-mono mt-1">
            {(totalBytes / (1024 * 1024)).toFixed(2)} MB
          </p>
          <p className="text-xs text-slate-400 mt-1">SHA-256 Checksums Verified</p>
        </div>
      </div>

      {/* Quick Upload Box */}
      {canEdit ? (
        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 shadow-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
              <Upload className="w-4 h-4 text-brand-400" />
              Upload Evidence to Control (Local Vault + SHA-256 Pipeline)
            </span>
          </div>

          <div className="flex flex-col sm:flex-row items-center gap-3">
            {/* Target Control Select */}
            <div className="w-full sm:w-80">
              <select
                value={targetControlId}
                onChange={(e) => setTargetControlId(e.target.value)}
                className="w-full text-xs font-medium rounded-xl px-3 py-2.5 bg-slate-950 border border-slate-800 text-white focus:outline-none focus:border-brand-500"
              >
                {frameworkControls.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} - {c.title}
                  </option>
                ))}
              </select>
            </div>

            {/* File Input */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              multiple
              className="hidden"
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-lg shadow-brand-500/20"
            >
              <Upload className="w-4 h-4" />
              <span>{isUploading ? 'Computing SHA-256 & Uploading...' : 'Choose Files to Upload'}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 text-center text-xs text-slate-400">
          <Lock className="w-4 h-4 inline-block mr-1 text-amber-400" /> Evidence uploads are disabled in Read-Only Viewer mode.
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          {/* Search Input */}
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, control, or SHA-256 hash..."
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-brand-500"
            />
          </div>

          {/* Domain Chips */}
          <div className="flex items-center gap-1.5 flex-wrap w-full sm:w-auto justify-end">
            <button
              onClick={() => setSelectedDomain('ALL')}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                selectedDomain === 'ALL'
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              All ({frameworkControls.length})
            </button>
            {availableDomains.map((d) => (
              <button
                key={d.code}
                onClick={() => setSelectedDomain(d.code)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  selectedDomain === d.code
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                {d.code}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Evidence Table */}
      {filteredItems.length === 0 ? (
        <div className="text-center py-16 bg-slate-900/40 border border-slate-800 rounded-3xl p-8 space-y-3">
          <Paperclip className="w-10 h-10 text-slate-400 mx-auto" />
          <h3 className="text-base font-bold text-white">No evidence files found for {currentTenant.name}</h3>
          <p className="text-xs text-slate-400 max-w-sm mx-auto">
            Upload policies, screenshots, or configuration audits using the uploader above or inside any control detail view.
          </p>
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-850 text-slate-400 border-b border-slate-800 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="py-3.5 px-4">Artifact Name</th>
                  <th className="py-3.5 px-4">Mapped Practice</th>
                  <th className="py-3.5 px-4">SHA-256 Immutability</th>
                  <th className="py-3.5 px-4">Size</th>
                  <th className="py-3.5 px-4">Upload Date</th>
                  <th className="py-3.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-slate-300">
                {filteredItems.map((item) => {
                  const ctrl = findControlDefinition(item.controlId);

                  return (
                    <tr key={item.id} className="hover:bg-slate-850/60 transition-colors">
                      {/* Name */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3">
                          {getFileIcon(item.mimeType, item.name)}
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-semibold text-white truncate max-w-xs">{item.name}</p>
                              <span className="text-xs font-bold px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                Local Vault
                              </span>
                            </div>
                            <p className="text-xs text-slate-400 font-mono truncate max-w-xs">{item.gcsPath || 'Local'}</p>
                          </div>
                        </div>
                      </td>

                      {/* Control Mapping */}
                      <td className="py-3 px-4">
                        {ctrl ? (
                          <button
                            onClick={() => setSelectedControlId(ctrl.id)}
                            className="flex items-center gap-1.5 hover:text-brand-300 text-left group"
                          >
                            <span className="font-mono font-bold text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-200 group-hover:bg-brand-500/20 group-hover:text-brand-300 transition-colors">
                              {ctrl.id}
                            </span>
                            <span className="truncate max-w-[150px] text-xs text-slate-400">
                              {ctrl.title}
                            </span>
                          </button>
                        ) : (
                          <span className="font-mono text-xs text-slate-400">{item.controlId}</span>
                        )}
                      </td>

                      {/* SHA-256 Fingerprint */}
                      <td className="py-3 px-4 font-mono text-xs">
                        {item.fileHash ? (
                          <button
                            onClick={() => handleCopyHash(item.fileHash)}
                            title="Copy Full SHA-256 Hash"
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-950 text-slate-300 hover:text-white border border-slate-800 hover:border-slate-700"
                          >
                            <Shield className="w-2.5 h-2.5 text-emerald-400" />
                            <span>{item.fileHash.substring(0, 10)}...</span>
                            {copiedHash === item.fileHash ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                          </button>
                        ) : (
                          <span className="text-slate-400">Uncalculated</span>
                        )}
                      </td>

                      {/* Size */}
                      <td className="py-3 px-4 font-mono text-slate-400">
                        {Math.round(item.fileSize / 1024)} KB
                      </td>

                      {/* Date */}
                      <td className="py-3 px-4 text-slate-400">
                        {item.uploadedAt.split('T')[0]}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => setPreviewEvidence(item)}
                            title="Preview File"
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => handleDownloadFile(item)}
                            title="Download File"
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>

                          {canEdit && (
                            <button
                              onClick={() => removeEvidence(item.id)}
                              title="Delete File"
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950/60 text-rose-400 hover:text-rose-300 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
