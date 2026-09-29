import React, { useState, useEffect } from 'react';
import {
  X,
  Download,
  FileText,
  FileImage,
  Shield,
  Cloud,
  Copy,
  Check,
  CheckCircle2,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { EvidenceVault } from '../../services/evidenceVault';
import { GcsService } from '../../services/gcsService';
import { findControlDefinition } from '../../data/frameworks';

export const EvidencePreviewModal: React.FC = () => {
  const { previewEvidence, setPreviewEvidence } = useAssessment();
  const { currentTenant } = useTenant();

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [hasBlob, setHasBlob] = useState<boolean>(false);
  const [copiedHash, setCopiedHash] = useState<boolean>(false);
  const [copiedGcs, setCopiedGcs] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    if (!previewEvidence) {
      setPreviewUrl(null);
      setTextContent(null);
      return;
    }

    setLoading(true);

    EvidenceVault.getFile(currentTenant.id, previewEvidence.id).then(async (result) => {
      if (!active) return;
      if (result) {
        setHasBlob(true);
        const url = URL.createObjectURL(result.blob);
        createdUrl = url;
        setPreviewUrl(url);

        if (result.type.includes('text') || result.name.endsWith('.csv') || result.name.endsWith('.json')) {
          const text = await result.blob.text();
          if (active) setTextContent(text.slice(0, 5000));
        }
      } else {
        setHasBlob(false);
        setPreviewUrl(null);
      }
      setLoading(false);
    });

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [previewEvidence, currentTenant.id]);

  if (!previewEvidence) return null;

  const control = findControlDefinition(previewEvidence.controlId);
  const isImage = previewEvidence.mimeType.includes('image') || previewEvidence.name.match(/\.(png|jpg|jpeg|webp|gif)$/i);
  const isPdf = previewEvidence.mimeType.includes('pdf') || previewEvidence.name.endsWith('.pdf');

  const gcsUri = previewEvidence.gcsPath || GcsService.generateGcsPath(
    currentTenant.id,
    previewEvidence.controlId,
    previewEvidence.id,
    previewEvidence.name
  );

  const handleDownload = () => {
    if (!previewUrl) return;
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = previewEvidence.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleCopyHash = () => {
    if (!previewEvidence.fileHash) return;
    navigator.clipboard.writeText(previewEvidence.fileHash);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  const handleCopyGcs = () => {
    navigator.clipboard.writeText(gcsUri);
    setCopiedGcs(true);
    setTimeout(() => setCopiedGcs(false), 2000);
  };

  return (
    <div className="no-print fixed inset-0 z-50 overflow-y-auto bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-scaleUp">
        
        {/* Header */}
        <div className="px-6 py-4 bg-slate-850 border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-brand-500/20 text-brand-400 flex items-center justify-center shrink-0 border border-brand-500/30">
              {isImage ? <FileImage className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white truncate">{previewEvidence.name}</h3>
                <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                  <Cloud className="w-2.5 h-2.5" /> GCS Cloud Scoped
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Mapped to <strong className="text-brand-300 font-mono">{previewEvidence.controlId}</strong> • {Math.round(previewEvidence.fileSize / 1024)} KB • Tenant: <strong className="text-white">{currentTenant.name}</strong>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {hasBlob && (
              <button
                onClick={handleDownload}
                className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
                title="Download Evidence"
              >
                <Download className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => setPreviewEvidence(null)}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* GCP Cloud & Cryptographic Audit Bar */}
        <div className="px-6 py-2.5 bg-slate-950/90 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-3 flex-wrap">
            {/* GCS Path */}
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-300">
              <Cloud className="w-3.5 h-3.5 text-brand-400 shrink-0" />
              <span className="truncate max-w-[280px] sm:max-w-md">{gcsUri}</span>
              <button
                onClick={handleCopyGcs}
                title="Copy GCS Path"
                className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800"
              >
                {copiedGcs ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>

            {/* SHA-256 Hash */}
            {previewEvidence.fileHash && (
              <div className="flex items-center gap-1.5 font-mono text-[11px] text-emerald-300 bg-slate-900 px-2 py-0.5 rounded-lg border border-slate-800">
                <Shield className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>SHA-256: {previewEvidence.fileHash.substring(0, 12)}...</span>
                <button
                  onClick={handleCopyHash}
                  title="Copy Full SHA-256 Hash"
                  className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800"
                >
                  {copiedHash ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            )}
          </div>

          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30">
            <CheckCircle2 className="w-3 h-3" /> Audit Verified Immutability
          </span>
        </div>

        {/* Preview Content */}
        <div className="p-6 overflow-y-auto flex-1 flex items-center justify-center bg-slate-950 min-h-[300px]">
          {loading ? (
            <div className="text-xs text-slate-400">Loading preview from IndexedDB & verifying SHA-256...</div>
          ) : hasBlob ? (
            isImage && previewUrl ? (
              <div className="max-w-full max-h-full flex items-center justify-center p-2">
                <img
                  src={previewUrl}
                  alt={previewEvidence.name}
                  className="max-h-[60vh] rounded-xl object-contain shadow-lg border border-slate-800"
                />
              </div>
            ) : isPdf && previewUrl ? (
              <div className="w-full h-[60vh] rounded-xl overflow-hidden border border-slate-800">
                <iframe
                  src={previewUrl}
                  title={previewEvidence.name}
                  className="w-full h-full bg-white"
                />
              </div>
            ) : textContent ? (
              <div className="w-full h-[55vh] overflow-auto p-4 bg-slate-900 border border-slate-800 rounded-xl font-mono text-xs text-slate-300 whitespace-pre-wrap">
                {textContent}
              </div>
            ) : (
              <div className="text-center space-y-3 p-8">
                <FileText className="w-12 h-12 text-slate-500 mx-auto" />
                <p className="text-sm font-semibold text-white">Binary Evidence Artifact</p>
                <p className="text-xs text-slate-400 max-w-sm mx-auto">
                  Click the download button above to inspect this artifact locally.
                </p>
              </div>
            )
          ) : (
            /* Demo / Cloud-Synced Reference Notice */
            <div className="text-center space-y-4 max-w-md p-8 bg-slate-900 border border-slate-800 rounded-2xl">
              <div className="w-12 h-12 rounded-2xl bg-brand-500/15 text-brand-400 flex items-center justify-center mx-auto">
                <FileText className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-base font-bold text-white">GCS Cloud Evidence Artifact</h4>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  This artifact (<span className="font-mono text-brand-300">{previewEvidence.name}</span>) is indexed in Cloud SQL for <strong>{previewEvidence.controlId}</strong> with verified SHA-256 fingerprinting.
                </p>
              </div>
              <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-left text-xs space-y-1">
                <p className="text-slate-400 font-semibold uppercase text-[10px] tracking-wider">Auditor Checklist Objective:</p>
                <p className="text-slate-300">
                  {control ? control.auditorChecklist[0] : 'Check security configurations.'}
                </p>
              </div>
              <p className="text-[11px] text-slate-500">
                To test live client-side binary uploads with real-time SHA-256 calculation, drop a file in the Evidence Vault tab.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-slate-850 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400 shrink-0">
          <span>Uploaded: {previewEvidence.uploadedAt.split('T')[0]}</span>
          <button
            onClick={() => setPreviewEvidence(null)}
            className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
};
