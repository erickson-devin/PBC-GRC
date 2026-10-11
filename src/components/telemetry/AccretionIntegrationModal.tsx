import React, { useState, useEffect } from 'react';
import {
  X,
  Radio,
  Key,
  Copy,
  Check,
  RotateCcw,
  Sparkles,
  Terminal,
  Code,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import {
  getAccretionApiConfig,
  rotateAccretionSecretKey,
  simulateAccretionDiscovery,
} from '../../data/telemetry/assetRegistry';
import { AccretionIngestResult } from '../../types/telemetry';

interface AccretionIntegrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDiscoveryComplete?: (result: AccretionIngestResult) => void;
  tenantId: string;
}

export const AccretionIntegrationModal: React.FC<AccretionIntegrationModalProps> = ({
  isOpen,
  onClose,
  onDiscoveryComplete,
  tenantId,
}) => {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [config, setConfig] = useState(() => getAccretionApiConfig(tenantId));
  const [showSecret, setShowSecret] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationResult, setSimulationResult] = useState<AccretionIngestResult | null>(null);
  const [selectedSnippetTab, setSelectedSnippetTab] = useState<'curl' | 'python' | 'json'>('curl');

  useEffect(() => {
    if (isOpen) {
      setConfig(getAccretionApiConfig(tenantId));
      setSimulationResult(null);
    }
  }, [isOpen, tenantId]);

  if (!isOpen) return null;

  const handleCopy = (text: string, fieldId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(fieldId);
    setTimeout(() => setCopiedField(null), 2500);
  };

  const handleRotateKey = () => {
    if (confirm('Revoke current Accretion API Secret Key? Connected sensors must be re-keyed immediately.')) {
      const newKey = rotateAccretionSecretKey(tenantId);
      setConfig(prev => ({ ...prev, secretKey: newKey }));
    }
  };

  const handleRunSimulation = async () => {
    setIsSimulating(true);
    setSimulationResult(null);

    try {
      // Simulate network sensor telemetry delay
      await new Promise(r => setTimeout(r, 1200));
      const result = await simulateAccretionDiscovery(tenantId);
      setSimulationResult(result);
      if (onDiscoveryComplete) {
        onDiscoveryComplete(result);
      }
    } catch (err) {
      console.error('Simulation failed:', err);
    } finally {
      setIsSimulating(false);
    }
  };

  const curlSnippet = `curl -X POST ${config.webhookUrl} \\
  -H "Authorization: Bearer ${config.secretKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "tenantId": "${tenantId}",
    "agentId": "accretion-sensor-vlan50",
    "discoveredAssets": [
      {
        "macAddress": "00:1A:2B:3C:4D:5E",
        "ipAddress": "10.0.50.155",
        "hostName": "UNMANAGED-DEV-01",
        "osFingerprint": "Linux 5.15.0 (Ubuntu)",
        "osProfile": "ubuntu2204",
        "discoveredPorts": [22, 8080, 5432],
        "connectionType": "WIRELESS"
      }
    ]
  }'`;

  const pythonSnippet = `import requests

url = "${config.webhookUrl}"
headers = {
    "Authorization": "Bearer ${config.secretKey}",
    "Content-Type": "application/json"
}
payload = {
    "tenantId": "${tenantId}",
    "agentId": "accretion-sensor-vlan50",
    "discoveredAssets": [
        {
            "macAddress": "00:1A:2B:3C:4D:5E",
            "ipAddress": "10.0.50.155",
            "hostName": "UNMANAGED-DEV-01",
            "osFingerprint": "Linux 5.15.0 (Ubuntu)",
            "osProfile": "ubuntu2204",
            "discoveredPorts": [22, 8080, 5432],
            "connectionType": "WIRELESS"
        }
    ]
}

response = requests.post(url, json=payload, headers=headers)
print("Accretion Ingest Response:", response.status_code, response.json())`;

  const jsonSnippet = `{
  "tenantId": "${tenantId}",
  "agentId": "accretion-sensor-vlan50",
  "discoveredAssets": [
    {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-sm animate-fadeIn">
      {/* Click outside backdrop */}
      <div className="absolute inset-0" onClick={onClose} />

      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl p-6 text-slate-100 z-10 space-y-6 max-h-[90vh] overflow-y-auto">
        
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-cyan-500/20 via-indigo-500/20 to-violet-500/20 border border-cyan-500/40 text-cyan-400">
              <Radio className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-black text-white">Event Horizon: Accretion</h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-cyan-950 text-cyan-300 border border-cyan-500/30">
                  NETWORK DISCOVERY API
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Elijah's live network sensor webhook & deduplication pipeline for CMMC boundary scoping.
              </p>
            </div>
          </div>

          <button
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
            className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-white font-bold text-xs shadow-md shadow-cyan-500/20 transition-all flex items-center gap-2 shrink-0 disabled:opacity-60"
          >
            {isSimulating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
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

        {/* Simulation Feedback */}
        {simulationResult && (
          <div className="p-4 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs space-y-2 animate-fadeIn">
            <div className="flex items-center gap-2 font-bold text-emerald-200">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Accretion Telemetry Ingestion Complete</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-slate-300 font-mono text-[11px] pt-1">
              <div>Total Processed: <strong>{simulationResult.totalProcessed}</strong></div>
              <div>New Discovered: <strong className="text-amber-400">{simulationResult.newDiscoveredCount}</strong></div>
              <div>Deduplicated: <strong className="text-cyan-400">{simulationResult.updatedExistingCount}</strong></div>
            </div>
            <p className="text-[10px] text-emerald-400/80 font-mono pt-1 truncate">
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
            <span className="text-[10px] font-mono text-slate-400">POST (JSON)</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={config.webhookUrl}
              className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs font-mono text-cyan-300 select-all"
            />
            <button
              onClick={() => handleCopy(config.webhookUrl, 'url')}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition-colors flex items-center gap-1.5 shrink-0"
            >
              {copiedField === 'url' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedField === 'url' ? 'Copied' : 'Copy URL'}</span>
            </button>
          </div>
        </div>

        {/* ─── API Secret Key ─── */}
        <div className="space-y-2">
          <label className="block text-xs font-bold text-slate-300 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Key className="w-4 h-4 text-amber-400" />
              <span>Accretion Ingestion Secret Key</span>
            </span>
            <button
              onClick={() => setShowSecret(!showSecret)}
              className="text-[11px] text-slate-400 hover:text-white"
            >
              {showSecret ? 'Hide Key' : 'Reveal Key'}
            </button>
          </label>
          <div className="flex items-center gap-2">
            <input
              type={showSecret ? 'text' : 'password'}
              readOnly
              value={config.secretKey}
              className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs font-mono text-amber-300 select-all"
            />
            <button
              onClick={() => handleCopy(config.secretKey, 'key')}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition-colors flex items-center gap-1.5 shrink-0"
            >
              {copiedField === 'key' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedField === 'key' ? 'Copied' : 'Copy'}</span>
            </button>
            <button
              onClick={handleRotateKey}
              className="p-2 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-400 border border-slate-700 transition-colors shrink-0"
              title="Rotate Secret Key"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            Pass in HTTP Header: <code className="text-cyan-400">Authorization: Bearer {config.secretKey.slice(0, 14)}...</code>
          </p>
        </div>

        {/* ─── Payload Format Code Snippets ─── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <Code className="w-4 h-4 text-violet-400" />
              <span>Accretion Webhook Integration Snippet</span>
            </span>
            <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-[11px]">
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
              onClick={() => {
                const text = selectedSnippetTab === 'curl' ? curlSnippet : selectedSnippetTab === 'python' ? pythonSnippet : jsonSnippet;
                handleCopy(text, 'snippet');
              }}
              className="absolute right-3 top-3 p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] flex items-center gap-1"
            >
              {copiedField === 'snippet' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copiedField === 'snippet' ? 'Copied' : 'Copy Code'}</span>
            </button>
            <pre className="text-[11px] text-slate-300">
              {selectedSnippetTab === 'curl' && curlSnippet}
              {selectedSnippetTab === 'python' && pythonSnippet}
              {selectedSnippetTab === 'json' && jsonSnippet}
            </pre>
          </div>
        </div>

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
    </div>
  );
};
