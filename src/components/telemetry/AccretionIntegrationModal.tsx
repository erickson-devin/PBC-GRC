import React, { useState, useEffect } from 'react';
import {
  X,
  Radio,
  Copy,
  Check,
  Sparkles,
  Terminal,
  Code,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { discoveryEndpointUrl } from '../../data/telemetry/assetRegistry';
import type { AssetBackend } from '../../services/assetService';
import { ErrorNotice } from '../common/ErrorNotice';
import { errorMessage } from '../../utils/errors';
import { AccretionIngestResult } from '../../types/telemetry';

import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { copyText } from '../../utils/clipboard';
interface AccretionIntegrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDiscoveryComplete?: (result: AccretionIngestResult) => void;
  tenantId: string;
  /** Where discovered devices are stored (the server for live tenants). */
  backend: AssetBackend;
}

export const AccretionIntegrationModal: React.FC<AccretionIntegrationModalProps> = ({
  isOpen,
  onClose,
  onDiscoveryComplete,
  tenantId,
  backend,
}) => {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<AccretionIngestResult | null>(null);
  const [selectedSnippetTab, setSelectedSnippetTab] = useState<'curl' | 'python' | 'json'>('curl');
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setSimulationResult(null);
      setSimulationError(null);
      setCopyFailed(false);
    }
  }, [isOpen, tenantId]);

  if (!isOpen) return null;

  const webhookUrl = discoveryEndpointUrl(typeof window === 'undefined' ? '' : window.location.origin, tenantId);

  // Scripts and scanners push with a VM service token (the discovery endpoint above only takes a signed-in browser session)
  const ingestUrl = `${typeof window === 'undefined' ? '' : window.location.origin}/api/v1/vm/ingest`;

  const handleCopy = async (text: string, fieldId: string) => {
    setCopyFailed(false);
    if (await copyText(text)) {
      setCopiedField(fieldId);
      setTimeout(() => setCopiedField(null), 2500);
    } else {
      setCopyFailed(true);
    }
  };

  const handleRunSimulation = async () => {
    setIsSimulating(true);
    setSimulationResult(null);
    setSimulationError(null);

    try {
      // Simulate network sensor telemetry delay
      await new Promise(r => setTimeout(r, 1200));
      const result = await backend.simulateDiscovery();
      setSimulationResult(result);
      if (onDiscoveryComplete) {
        onDiscoveryComplete(result);
      }
    } catch (err) {
      setSimulationError(errorMessage(err) || 'The discovery results could not be saved.');
    } finally {
      setIsSimulating(false);
    }
  };

  const curlSnippet = `curl -X POST "${ingestUrl}" \\
  -H "Authorization: Bearer <SERVICE_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d @findings.json`;

  const pythonSnippet = `import os
import requests

url = "${ingestUrl}"
headers = {
    "Authorization": "Bearer " + os.environ["PBC_SERVICE_TOKEN"],
    "Content-Type": "application/json"
}

with open("findings.json", "rb") as f:
    response = requests.post(url, data=f.read(), headers=headers, timeout=60)
print("Ingest Response:", response.status_code, response.json())`;

  const jsonSnippet = `{
  "items": [
    {
      "agentId": "accretion-sensor-vlan50",
      "macAddress": "00:1A:2B:3C:4D:5E",
      "ipAddress": "10.0.50.155",
      "hostName": "UNMANAGED-DEV-01",
      "osFingerprint": "Linux 5.15.0-88-generic (Ubuntu)",
      "osProfile": "ubuntu2204",
      "discoveredPorts": [22, 8080, 5432],
      "connectionType": "WIRELESS",
      "detectedAt": "${new Date().toISOString()}",
      "notes": "Developer workstation active on wireless enclave bridge."
    }
  ]
}`;

  return (
    <DialogOverlay onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-sm animate-fadeIn">
      {/* Click outside backdrop */}
      <div aria-hidden="true" className="absolute inset-0" onClick={onClose} />

      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-6 max-h-[90vh] overflow-y-auto">
        
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-cyan-500/20 via-indigo-500/20 to-violet-500/20 border border-cyan-500/40 text-cyan-400">
              <Radio className="w-6 h-6 animate-pulse motion-reduce:animate-none" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <DialogTitle as="h2" className="text-lg font-black text-white">Event Horizon: Accretion</DialogTitle>
                <span className="px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-cyan-950 text-cyan-300 border border-cyan-500/30">
                  NETWORK DISCOVERY API
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Elijah's live network sensor webhook & deduplication pipeline for CMMC boundary scoping.
              </p>
            </div>
          </div>

          <button aria-label="Close"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ─── Simulation Trigger Banner ─── */}
        <div className="rounded-xl border border-cyan-500/40 bg-gradient-to-r from-cyan-950/40 via-indigo-950/30 to-slate-950 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-lg shadow-cyan-950/20">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-bold text-cyan-300">
              <Sparkles className="w-4 h-4 text-cyan-400" />
              <span>Simulate Accretion Discovery Ingestion</span>
            </div>
            <p className="text-xs text-slate-300">
              Discovers 2 new unmanaged network nodes and deduplicates 1 existing workstation in real time.
            </p>
          </div>

          <button
            onClick={handleRunSimulation}
            disabled={isSimulating}
            className="btn-primary px-4 py-2.5 rounded-xl text-xs flex items-center gap-2 shrink-0"
          >
            {isSimulating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />
                <span>Scanning Subnets...</span>
              </>
            ) : (
              <>
                <Radio className="w-4 h-4" />
                <span>Simulate Discovery Payload</span>
              </>
            )}
          </button>
        </div>

        <ErrorNotice message={simulationError} />

        {/* Simulation Feedback */}
        {simulationResult && (
          <div className="p-4 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs space-y-2 animate-fadeIn">
            <div className="flex items-center gap-2 font-bold text-emerald-200">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Accretion Telemetry Ingestion Complete</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-slate-300 font-mono text-xs pt-1">
              <div>Total Processed: <strong>{simulationResult.totalProcessed}</strong></div>
              <div>New Discovered: <strong className="text-amber-400">{simulationResult.newDiscoveredCount}</strong></div>
              <div>Deduplicated: <strong className="text-cyan-400">{simulationResult.updatedExistingCount}</strong></div>
            </div>
            <p className="text-xs text-emerald-400/80 font-mono pt-1 truncate">
              Cryptographic Digest: {simulationResult.auditHash}
            </p>
          </div>
        )}

        {/* ─── API Webhook Ingestion Endpoint ─── */}
        <div className="space-y-3">
          <label className="block text-xs font-bold text-slate-300 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Terminal className="w-4 h-4 text-cyan-400" />
              <span>REST Webhook Ingestion Endpoint</span>
            </span>
            <span className="text-xs font-mono text-slate-400">POST (JSON)</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={webhookUrl}
              className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs font-mono text-cyan-300 select-all"
            />
            <button
              type="button"
              onClick={() => handleCopy(webhookUrl, 'url')}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition-colors flex items-center gap-1.5 shrink-0"
            >
              {copiedField === 'url' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedField === 'url' ? 'Copied' : 'Copy URL'}</span>
            </button>
          </div>
        </div>

        {/* ─── Authentication note ─── */}
        <div className="space-y-2 text-xs text-slate-400">
          <p>
            This discovery endpoint accepts only a signed-in Tenant Owner or MSP Admin in this browser (the Simulate button above uses it). Your browser session is kept in an HttpOnly cookie, so it cannot be copied or read by scripts, and this endpoint has no machine credential yet.
          </p>
          <p>
            For scripts and scanners, create a VM service token and send it to <code className="text-cyan-400">POST /api/v1/vm/ingest</code> (see the vulnerability-management guide). The supported scanner integration is the exporter in <code className="text-cyan-400">exporters/pbc-vm-exporter</code>.
          </p>
        </div>

        {/* ─── Payload Format Code Snippets ─── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <Code className="w-4 h-4 text-violet-400" />
              <span>Scanner Push Example (Service Token)</span>
            </span>
            <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
              {(['curl', 'python', 'json'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setSelectedSnippetTab(tab)}
                  className={`px-2 py-0.5 rounded font-mono uppercase font-bold transition-colors ${
                    selectedSnippetTab === tab
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          <div className="relative rounded-xl bg-slate-950 border border-slate-800 p-4 font-mono text-xs leading-relaxed text-slate-300 overflow-x-auto">
            <button
              type="button"
              onClick={() => {
                const text = selectedSnippetTab === 'curl' ? curlSnippet : selectedSnippetTab === 'python' ? pythonSnippet : jsonSnippet;
                handleCopy(text, 'snippet');
              }}
              className="absolute right-3 top-3 p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs flex items-center gap-1"
            >
              {copiedField === 'snippet' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copiedField === 'snippet' ? 'Copied' : 'Copy Code'}</span>
            </button>
            <p className="mb-2 pr-24 font-sans text-xs text-slate-400">{selectedSnippetTab === 'json' ? 'Body format of the discovery endpoint above, sent by the signed-in browser session.' : 'Pushes a scanner export (findings.json, format in the vulnerability-management guide) with a VM service token.'}</p>
            <pre className="text-xs text-slate-300">
              {selectedSnippetTab === 'curl' && curlSnippet}
              {selectedSnippetTab === 'python' && pythonSnippet}
              {selectedSnippetTab === 'json' && jsonSnippet}
            </pre>
          </div>
        </div>

        <ErrorNotice message={copyFailed ? 'The text could not be copied. Select it in the field or the code block and copy it by hand.' : null} />

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
          <span className="text-slate-400 font-mono">
            Pitch Black Cyber // Accretion Engine v3.1
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold transition-colors"
          >
            Close Dialog
          </button>
        </div>

      </div>
    </DialogOverlay>
  );
};
