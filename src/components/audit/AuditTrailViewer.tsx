import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Search,
  Filter,
  Download,
  User,
  Copy,
  Check,
  Eye,
  X,
  RotateCw,
  Hash,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { AuditLogEntry, AuditVerificationResult, AuditActionType } from '../../types/audit';
import {
  getAuditLogs,
  verifyAuditChain,
  exportAuditPackageJson,
} from '../../data/audit/auditLogger';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { copyToClipboard as copyText } from '../../utils/clipboard';
export const AuditTrailViewer: React.FC = () => {
  const { currentTenant, programs } = useTenant();

  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [verification, setVerification] = useState<AuditVerificationResult | null>(null);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);

  // Filter States
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedAction, setSelectedAction] = useState<AuditActionType | 'ALL'>('ALL');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  // The ledger is tenant-wide; entries written inside a program carry its id in metadata.programId ('LEGACY': entries without one)
  const [programFilter, setProgramFilter] = useState<string>('ALL');
  useEffect(() => {
    setProgramFilter('ALL');
  }, [currentTenant.id]);

  // Load the ledger and verify its hash chain
  const loadData = useCallback(async () => {
    const raw = getAuditLogs(currentTenant.id);
    setLogs(raw);

    setIsVerifying(true);
    const res = await verifyAuditChain(raw);
    setVerification(res);
    setIsVerifying(false);
  }, [currentTenant.id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleManualReverify = async () => {
    setIsVerifying(true);
    const raw = getAuditLogs(currentTenant.id);
    const res = await verifyAuditChain(raw);
    setVerification(res);
    setIsVerifying(false);
  };

  const handleExportJson = async () => {
    const json = await exportAuditPackageJson(currentTenant.id, currentTenant.name);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_ledger_${currentTenant.cageCode || currentTenant.id}_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = (text: string) => {
    copyText(text).catch((err) => console.warn('Clipboard write failed:', err));
    setCopiedHash(text);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  // Filtered entries
  const filteredLogs = useMemo(() => {
    return logs.filter(entry => {
      if (selectedAction !== 'ALL' && entry.actionType !== selectedAction) return false;
      if (programFilter !== 'ALL') {
        const entryProgram = entry.metadata?.programId;
        if (programFilter === 'LEGACY' ? entryProgram != null && entryProgram !== '' : entryProgram !== programFilter) return false;
      }
      if (startDate && new Date(entry.timestamp) < new Date(startDate)) return false;
      if (endDate && new Date(entry.timestamp) > new Date(endDate + 'T23:59:59')) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matches =
          entry.targetEntity.toLowerCase().includes(q) ||
          entry.actorEmail.toLowerCase().includes(q) ||
          entry.actionType.toLowerCase().includes(q) ||
          entry.sha256Hash.toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  }, [logs, selectedAction, programFilter, startDate, endDate, searchQuery]);

  const getActionBadge = (action: AuditActionType) => {
    switch (action) {
      case 'CONTROL_STATUS_UPDATED':
        return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
      case 'CONTROL_NOTES_UPDATED':
      case 'OBJECTIVE_NARRATIVE_UPDATED':
      case 'TEMPLATE_APPLIED':
        return 'bg-brand-500/15 text-brand-300 border-brand-500/30';
      case 'EVIDENCE_UPLOADED':
        return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
      case 'EVIDENCE_DELETED':
        return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
      case 'DOCUMENT_GENERATED':
      case 'DOCUMENT_EXPORTED':
        return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
      case 'SPRS_CALCULATED':
      case 'EMASS_EXPORTED':
        return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
      case 'CRYPTOGRAPHIC_WIPE_PERFORMED':
        return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
      default:
        return 'bg-slate-700/50 text-slate-300 border-slate-600/50';
    }
  };

  return (
    <div className="space-y-6 animate-fadeIn pb-12">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-900 to-slate-950 border border-slate-800 shadow-xl">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 uppercase tracking-wider">
              NIST SP 800-171 3.3
            </span>
            <span className="px-2 py-0.5 rounded-full text-xs font-mono text-slate-400 bg-slate-800 border border-slate-700">
              DFARS 252.204-7012
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight flex items-center gap-2">
            <span>Cryptographically Verifiable Audit Ledger</span>
          </h1>
          <p className="text-xs text-slate-400 max-w-2xl">
            Immutable SHA-256 hash-chained activity record. Every control evaluation, narrative update, evidence attachment, and export creates an auditable cryptographic block.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={handleManualReverify}
            disabled={isVerifying}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm"
          >
            <RotateCw className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin motion-reduce:animate-none text-cyan-400' : 'text-slate-400'}`} />
            <span>{isVerifying ? 'Verifying...' : 'Verify Chain'}</span>
          </button>

          <button
            onClick={handleExportJson}
            className="btn-primary px-4 py-2 rounded-xl text-xs flex items-center gap-2"
          >
            <Download className="w-4 h-4 text-brand-200" />
            <span>Export Audit Package (JSON)</span>
          </button>
        </div>
      </div>

      {/* Cryptographic Verification Proof Banner */}
      {verification && (
        <div
          className={`p-4 rounded-2xl border transition-all ${
            verification.isValid
              ? 'bg-emerald-950/20 border-emerald-500/30 shadow-[0_0_20px_rgba(16,185,129,0.1)]'
              : 'bg-rose-950/30 border-rose-500/40 shadow-[0_0_20px_rgba(244,63,94,0.15)]'
          }`}
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div
                className={`p-2.5 rounded-xl ${
                  verification.isValid
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                    : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                }`}
              >
                {verification.isValid ? (
                  <ShieldCheck className="w-6 h-6" />
                ) : (
                  <ShieldAlert className="w-6 h-6 animate-pulse motion-reduce:animate-none" />
                )}
              </div>
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-black text-white tracking-tight">
                    {verification.isValid
                      ? 'CRYPTOGRAPHIC CHAIN INTEGRITY VALID'
                      : 'TAMPER DETECTION ALERT: HASH CHAIN BROKEN'}
                  </h3>
                  <span
                    className={`text-xs font-mono px-2 py-0.5 rounded-full font-bold uppercase ${
                      verification.isValid
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-rose-500/20 text-rose-300'
                    }`}
                  >
                    {verification.isValid ? '100% Intact' : 'Violation Detected'}
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  {verification.isValid
                    ? `Traversed ${verification.totalEntries} linked blocks. Zero payload mutations, zero broken pointer hashes detected.`
                    : verification.errorMessage || 'Hash mismatch detected in chain.'}
                </p>
              </div>
            </div>

            {/* Cryptographic Hashes Overview */}
            <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
              <div className="p-2 rounded-xl bg-slate-900/90 border border-slate-800 space-y-0.5">
                <span className="text-xs uppercase tracking-wider text-slate-400 block">Genesis Root Hash</span>
                <span className="text-cyan-400 font-bold truncate block max-w-[140px]" title={verification.rootHash}>
                  {verification.rootHash.substring(0, 16)}...
                </span>
              </div>
              <div className="p-2 rounded-xl bg-slate-900/90 border border-slate-800 space-y-0.5">
                <span className="text-xs uppercase tracking-wider text-slate-400 block">Head Block Hash</span>
                <span className="text-emerald-400 font-bold truncate block max-w-[140px]" title={verification.headHash}>
                  {verification.headHash.substring(0, 16)}...
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col md:flex-row items-center justify-between gap-3">
        <div className="relative w-full md:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search control ID, actor, or hash..."
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500"
          />
        </div>

        <div className="flex items-center gap-2.5 w-full md:w-auto flex-wrap">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>Action:</span>
            <select
              value={selectedAction}
              onChange={e => setSelectedAction(e.target.value as typeof selectedAction)}
              className="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
            >
              <option value="ALL">All Actions</option>
              <option value="CONTROL_STATUS_UPDATED">Control Status Updated</option>
              <option value="CONTROL_NOTES_UPDATED">Control Notes Updated</option>
              <option value="OBJECTIVE_NARRATIVE_UPDATED">Objective Narrative Updated</option>
              <option value="EVIDENCE_UPLOADED">Evidence Uploaded</option>
              <option value="DOCUMENT_GENERATED">Document Generated</option>
              <option value="SPRS_CALCULATED">SPRS Calculated</option>
              <option value="DATA_RETENTION_APPLIED">Data Retention Applied</option>
              <option value="CRYPTOGRAPHIC_WIPE_PERFORMED">Cryptographic Wipe</option>
            </select>
          </div>

          {programs.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <span>Program:</span>
              <select
                value={programFilter}
                onChange={e => setProgramFilter(e.target.value)}
                aria-label="Filter by program"
                className="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
              >
                <option value="ALL">All programs</option>
                <option value="LEGACY">Tenant / legacy</option>
                {programs.map(p => (
                  <option key={p.id} value={p.id}>{p.name}{p.archived ? ' (archived)' : ''}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-1 text-xs text-slate-400">
            <span>From:</span>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="px-2 py-1 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
            />
          </div>

          <div className="flex items-center gap-1 text-xs text-slate-400">
            <span>To:</span>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="px-2 py-1 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200"
            />
          </div>

          {(searchQuery || selectedAction !== 'ALL' || programFilter !== 'ALL' || startDate || endDate) && (
            <button
              onClick={() => {
                setSearchQuery('');
                setSelectedAction('ALL');
                setProgramFilter('ALL');
                setStartDate('');
                setEndDate('');
              }}
              className="text-xs text-cyan-400 hover:text-cyan-300 font-semibold px-2 py-1"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Main Ledger Table */}
      <div className="rounded-2xl border border-slate-800/90 overflow-hidden bg-slate-950/70 shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/90 border-b border-slate-800 text-xs font-mono text-slate-400 uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4"># Sequence</th>
                <th className="py-3 px-4">Timestamp (UTC)</th>
                <th className="py-3 px-4">Actor</th>
                <th className="py-3 px-4">Action Type</th>
                <th className="py-3 px-4">Target Entity</th>
                <th className="py-3 px-4">SHA-256 Digest</th>
                <th className="py-3 px-4 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850 font-sans">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400 font-mono">
                    No matching audit records found.
                  </td>
                </tr>
              ) : (
                filteredLogs.map(entry => (
                  <tr key={entry.id} className="hover:bg-slate-900/40 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-cyan-400">
                      #{String(entry.sequenceNumber).padStart(4, '0')}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-400 whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-white flex items-center gap-1.5 truncate max-w-[160px]">
                        <User className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span className="truncate">{entry.actorEmail}</span>
                      </div>
                      <span className="text-xs text-slate-400 block font-mono">
                        {entry.actorRole || 'Operator'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded-full border text-xs font-bold uppercase tracking-wider ${getActionBadge(entry.actionType)}`}>
                        {entry.actionType.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono font-medium text-slate-200 max-w-[200px] truncate">
                      {entry.targetEntity}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs">
                      <div className="flex items-center gap-1.5 text-slate-400 hover:text-white">
                        <span className="truncate max-w-[100px] text-emerald-400/90 font-semibold" title={entry.sha256Hash}>
                          {entry.sha256Hash.substring(0, 8)}...{entry.sha256Hash.substring(58)}
                        </span>
                        <button
                          onClick={() => copyToClipboard(entry.sha256Hash)}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-300 transition-colors"
                          title="Copy Full SHA-256 Hash"
                        >
                          {copiedHash === entry.sha256Hash ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => setSelectedEntry(entry)}
                        className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-cyan-500/40 text-cyan-300 font-medium text-xs inline-flex items-center gap-1 transition-colors"
                      >
                        <Eye className="w-3 h-3" />
                        <span>Inspect</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Entry Inspector Modal */}
      {selectedEntry && (
        <DialogOverlay onClose={() => setSelectedEntry(null)} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
          <div className="w-full max-w-2xl bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                  <Hash className="w-4 h-4" />
                </div>
                <div>
                  <DialogTitle as="h3" className="text-base font-black text-white">
                    Audit Block #{selectedEntry.sequenceNumber}
                  </DialogTitle>
                  <span className="text-xs font-mono text-slate-400">
                    ID: {selectedEntry.id}
                  </span>
                </div>
              </div>
              <button aria-label="Close"
                onClick={() => setSelectedEntry(null)}
                className="w-8 h-8 rounded-full bg-slate-900 border border-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1">
                <span className="text-slate-400 text-xs font-mono uppercase">Actor Email</span>
                <p className="font-semibold text-white">{selectedEntry.actorEmail}</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1">
                <span className="text-slate-400 text-xs font-mono uppercase">Timestamp (UTC)</span>
                <p className="font-mono text-slate-200">{selectedEntry.timestamp}</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1">
                <span className="text-slate-400 text-xs font-mono uppercase">Action Type</span>
                <p className="font-bold text-cyan-400">{selectedEntry.actionType}</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 space-y-1">
                <span className="text-slate-400 text-xs font-mono uppercase">Target Entity</span>
                <p className="font-mono text-slate-200 truncate">{selectedEntry.targetEntity}</p>
              </div>
            </div>

            {/* Cryptographic Linkage Block */}
            <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2 font-mono text-xs">
              <div>
                <span className="text-slate-400 text-xs uppercase block">Previous Hash (Parent Block Pointer)</span>
                <span className="text-slate-300 break-all">{selectedEntry.previousHash}</span>
              </div>
              <div>
                <span className="text-slate-400 text-xs uppercase block">Current Block SHA-256 Digest</span>
                <span className="text-emerald-400 break-all font-bold">{selectedEntry.sha256Hash}</span>
              </div>
            </div>

            {/* State Diffs */}
            {(selectedEntry.previousState !== undefined || selectedEntry.newState !== undefined) && (
              <div className="space-y-2">
                <span className="text-xs font-semibold text-slate-300">State Mutation Payload:</span>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="p-2.5 rounded-xl bg-slate-900/90 border border-slate-800">
                    <span className="text-rose-400 font-bold block mb-1">Previous State</span>
                    <pre className="text-slate-300 overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(selectedEntry.previousState ?? null, null, 2)}
                    </pre>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-900/90 border border-slate-800">
                    <span className="text-emerald-400 font-bold block mb-1">New State</span>
                    <pre className="text-slate-300 overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(selectedEntry.newState ?? null, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            )}

            {selectedEntry.metadata && Object.keys(selectedEntry.metadata).length > 0 && (
              <div>
                <span className="text-xs font-semibold text-slate-300">Operational Metadata:</span>
                <pre className="mt-1 p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto">
                  {JSON.stringify(selectedEntry.metadata, null, 2)}
                </pre>
              </div>
            )}

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setSelectedEntry(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold"
              >
                Close Inspector
              </button>
            </div>
          </div>
        </DialogOverlay>
      )}
    </div>
  );
};
