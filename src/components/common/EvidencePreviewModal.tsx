import React, { useState, useEffect } from 'react';
import { X, Download, FileText, FileImage } from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { EvidenceVault } from '../../services/evidenceVault';
import { CMMC_LEVEL_1_CONTROLS } from '../../data/cmmcLevel1Controls';

export const EvidencePreviewModal: React.FC = () => {
  const { previewEvidence, setPreviewEvidence } = useAssessment();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [hasBlob, setHasBlob] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    if (!previewEvidence) {
      setPreviewUrl(null);
      setTextContent(null);
      return;
    }

    setLoading(true);

    EvidenceVault.getFile(previewEvidence.id).then(async (result) => {
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
  }, [previewEvidence]);

  if (!previewEvidence) return null;

  const control = CMMC_LEVEL_1_CONTROLS.find((c) => c.id === previewEvidence.controlId);
  const isImage = previewEvidence.mimeType.includes('image') || previewEvidence.name.match(/\.(png|jpg|jpeg|webp|gif)$/i);
  const isPdf = previewEvidence.mimeType.includes('pdf') || previewEvidence.name.endsWith('.pdf');

  const handleDownload = () => {
    if (!previewUrl) return;
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = previewEvidence.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="no-print fixed inset-0 z-50 overflow-y-auto bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="px-6 py-4 bg-slate-850 border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-brand-500/20 text-brand-400 flex items-center justify-center shrink-0">
              {isImage ? <FileImage className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-white truncate">{previewEvidence.name}</h3>
              <p className="text-xs text-slate-400">
                Mapped to <strong className="text-brand-300 font-mono">{previewEvidence.controlId}</strong> • {Math.round(previewEvidence.fileSize / 1024)} KB
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

        {/* Preview Content */}
        <div className="p-6 overflow-y-auto flex-1 flex items-center justify-center bg-slate-950 min-h-[300px]">
          {loading ? (
            <div className="text-xs text-slate-400">Loading preview from IndexedDB...</div>
          ) : hasBlob ? (
            isImage && previewUrl ? (
              <div className="max-w-full max-h-full flex items-center justify-center p-2">
                <img
                  src={previewUrl}
                  alt={previewEvidence.name}
                  className="max-h-[65vh] rounded-xl object-contain shadow-lg border border-slate-800"
                />
              </div>
            ) : isPdf && previewUrl ? (
              <div className="w-full h-[65vh] rounded-xl overflow-hidden border border-slate-800">
                <iframe
                  src={previewUrl}
                  title={previewEvidence.name}
                  className="w-full h-full bg-white"
                />
              </div>
            ) : textContent ? (
              <div className="w-full h-[60vh] overflow-auto p-4 bg-slate-900 border border-slate-800 rounded-xl font-mono text-xs text-slate-300 whitespace-pre-wrap">
                {textContent}
              </div>
            ) : (
              <div className="text-center space-y-3 p-8">
                <FileText className="w-12 h-12 text-slate-500 mx-auto" />
                <p className="text-sm font-semibold text-white">Preview unavailable for this binary format</p>
                <p className="text-xs text-slate-400 max-w-sm mx-auto">
                  Click the download button above to save and inspect this artifact locally.
                </p>
              </div>
            )
          ) : (
            /* Demo / Placeholder Notice */
            <div className="text-center space-y-4 max-w-md p-8 bg-slate-900 border border-slate-800 rounded-2xl">
              <div className="w-12 h-12 rounded-2xl bg-brand-500/15 text-brand-400 flex items-center justify-center mx-auto">
                <FileText className="w-6 h-6" />
              </div>
              <div>
                <h4 className="text-base font-bold text-white">Simulated Demo Artifact</h4>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  This artifact (<span className="font-mono text-brand-300">{previewEvidence.name}</span>) is a simulated evidence record generated for <strong>{previewEvidence.controlId}</strong> in demo mode.
                </p>
              </div>
              <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 text-left text-xs space-y-1">
                <p className="text-slate-400 font-semibold uppercase text-[10px] tracking-wider">Suggested Auditor Inspection:</p>
                <p className="text-slate-300">
                  {control ? control.auditorChecklist[0] : 'Check security configurations.'}
                </p>
              </div>
              <p className="text-[11px] text-slate-500">
                To test real binary previews and downloads, upload actual files (PNG, JPG, PDF, TXT) via the Evidence Vault or Control detail.
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
