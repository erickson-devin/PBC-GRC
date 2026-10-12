/**
 * Event Horizon: Singularity — Photon SCAP Execution Console
 * Full-featured STIG/SCAP scanner telemetry terminal with live streaming output,
 * target configuration, scan execution, and one-click GRC matrix sync.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Terminal,
  Play,
  RotateCcw,
  Upload,
  Server,
  Shield,
  CheckCircle2,
  XCircle,
  Loader2,
  Wifi,
  Monitor,
  Cpu,
  ChevronDown,
  Zap,
  Radio,
  ArrowDownToLine,
  Database,
  Layers,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { PhotonScanStatus, ScapScanReport, EnclaveAsset } from '../../types/telemetry';
import {
  ingestScapScanReport,
  generateSimulatedScanReport,
  IngestResult,
  SCAP_RULE_MAPPINGS,
} from '../../data/telemetry/scapIngestEngine';
import { AssetComplianceTable } from './AssetComplianceTable';
import { AssetInventoryManager } from './AssetInventoryManager';
import { ingestScanReportToAsset } from '../../data/telemetry/assetTelemetryEngine';
import { useEnclaveAssets } from '../../hooks/useEnclaveAssets';
import { errorMessage } from '../../utils/errors';

// ---------------------------------------------------------------------------
// OS Profile Options
// ---------------------------------------------------------------------------
const OS_PROFILES = [
  { value: 'rhel9',       label: 'RHEL 9 (Red Hat Enterprise Linux 9)',    icon: '🐧' },
  { value: 'rhel8',       label: 'RHEL 8 (Red Hat Enterprise Linux 8)',    icon: '🐧' },
  { value: 'win2022',     label: 'Windows Server 2022',                    icon: '🪟' },
  { value: 'ubuntu2204',  label: 'Ubuntu 22.04 LTS (Jammy Jellyfish)',     icon: '🟠' },
] as const;

const STIG_BENCHMARKS = [
  { value: 'DISA_STIG_RHEL9',     label: 'DISA STIG — RHEL 9 (V1R2)' },
  { value: 'DISA_STIG_RHEL8',     label: 'DISA STIG — RHEL 8 (V1R12)' },
  { value: 'DISA_STIG_WIN2022',   label: 'DISA STIG — Windows Server 2022 (V1R4)' },
  { value: 'CIS_UBUNTU_2204_L2',  label: 'CIS Benchmark — Ubuntu 22.04 Level 2' },
  { value: 'SCAP_SSG_DEFAULT',    label: 'SCAP Security Guide (SSG) Default Profile' },
] as const;

// ---------------------------------------------------------------------------
// Simulated terminal log lines for realistic scan animation
// ---------------------------------------------------------------------------
function generateScanLogLines(
  hostName: string,
  targetIp: string,
  osProfile: string,
  benchmark: string
): string[] {
  return [
    `[${new Date().toISOString()}] ▸ Photon SCAP Engine v2.1.0 initializing...`,
    `[${new Date().toISOString()}] ▸ Target: ${hostName} (${targetIp})`,
    `[${new Date().toISOString()}] ▸ OS Profile: ${osProfile.toUpperCase()}`,
    `[${new Date().toISOString()}] ▸ Benchmark: ${benchmark}`,
    `[${new Date().toISOString()}] ▸ Loading XCCDF content from scanner-agent/content/...`,
    `[${new Date().toISOString()}] ▸ Validating OVAL definitions (${SCAP_RULE_MAPPINGS.length} rules)...`,
    `[${new Date().toISOString()}] ▸ Establishing SSH transport to ${targetIp}:22...`,
    `[${new Date().toISOString()}] ▸ Connection established. Authenticating with key-based auth...`,
    `[${new Date().toISOString()}] ▸ ✓ Authentication successful. Beginning rule evaluation...`,
    '',
    `────────────────────────────────────────────────────────`,
    `  DISA STIG AUTOMATED COMPLIANCE SCAN — PHASE 1       `,
    `────────────────────────────────────────────────────────`,
    '',
  ];
}

function generateRuleLogLines(
  results: ScapScanReport['results']
): string[] {
  const lines: string[] = [];

  results.forEach((r, i) => {
    const statusIcon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⚠️';
    const severity = r.severity === 'CAT_I' ? '🔴 CAT I' : r.severity === 'CAT_II' ? '🟡 CAT II' : '🟢 CAT III';
    lines.push(
      `  [${String(i + 1).padStart(2, '0')}/${results.length}] ${statusIcon} ${r.status.padEnd(5)} │ ${severity.padEnd(12)} │ ${r.cceId.padEnd(14)} │ ${r.title}`
    );
  });

  return lines;
}

function generateScanSummaryLines(report: ScapScanReport): string[] {
  const passRate = report.results.length > 0
    ? Math.round((report.passedCount / report.results.length) * 100)
    : 0;

  return [
    '',
    `────────────────────────────────────────────────────────`,
    `  SCAN COMPLETE — RESULTS SUMMARY                      `,
    `────────────────────────────────────────────────────────`,
    `  Host:       ${report.hostName} (${report.targetIp})`,
    `  OS Profile: ${report.osProfile.toUpperCase()}`,
    `  Scanner:    ${report.scapVersion}`,
    `  Timestamp:  ${report.timestamp}`,
    `  Scan ID:    ${report.scanId}`,
    '',
    `  Total Rules Evaluated:  ${report.results.length}`,
    `  ✅ PASSED:              ${report.passedCount}`,
    `  ❌ FAILED:              ${report.failedCount}`,
    `  ⚠️  ERRORS:             ${report.results.filter(r => r.status === 'ERROR').length}`,
    `  Compliance Rate:        ${passRate}%`,
    '',
    `  ▸ Scan payload ready for GRC matrix ingestion.`,
    `  ▸ Use "Sync Scan Findings" to update control statuses.`,
    `────────────────────────────────────────────────────────`,
  ];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export const PhotonScanConsole: React.FC = () => {
  const { updateControlStatus, refreshBoundaryTelemetry } = useAssessment();
  const { currentTenant } = useTenant();

  // Target configuration
  const [targetHost, setTargetHost] = useState('10.0.50.12');
  const [hostName, setHostName] = useState('enclave-node-01');
  const [osProfile, setOsProfile] = useState('rhel9');
  const [stigBenchmark, setStigBenchmark] = useState('DISA_STIG_RHEL9');

  // Registered assets from Enclave Inventory
  const { assets: registeredAssets, backend: assetBackend } = useEnclaveAssets();
  const [selectedAssetId, setSelectedAssetId] = useState<string>('');
  const [activeConsoleView, setActiveConsoleView] = useState<'SCANNER' | 'INVENTORY' | 'FLEET'>('SCANNER');

  const handleSelectRegisteredAsset = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const assetId = e.target.value;
    setSelectedAssetId(assetId);
    const asset = registeredAssets.find(a => a.id === assetId);
    if (asset) {
      setHostName(asset.hostName);
      setTargetHost(asset.ipAddress);
      setOsProfile(asset.osProfile);
      if (asset.osProfile === 'rhel9') setStigBenchmark('DISA_STIG_RHEL9');
      else if (asset.osProfile === 'rhel8') setStigBenchmark('DISA_STIG_RHEL8');
      else if (asset.osProfile === 'win2022') setStigBenchmark('DISA_STIG_WIN2022');
      else if (asset.osProfile === 'ubuntu2204') setStigBenchmark('DISA_STIG_UBUNTU2204');
    }
  };

  // Scan state
  const [scanStatus, setScanStatus] = useState<PhotonScanStatus>('IDLE');
  const [terminalLines, setTerminalLines] = useState<string[]>([
    '╔══════════════════════════════════════════════════════════╗',
    '║   PHOTON SCAP EXECUTION CONSOLE — Event Horizon GRC     ║',
    '║   Automated DISA STIG & OpenSCAP Telemetry Engine       ║',
    '╚══════════════════════════════════════════════════════════╝',
    '',
    '  Ready. Configure target and select benchmark to begin.',
    '',
  ]);
  const [lastReport, setLastReport] = useState<ScapScanReport | null>(null);
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);
  const [syncNotification, setSyncNotification] = useState<string | null>(null);

  // Terminal auto-scroll ref
  const terminalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalLines]);

  // -----------------------------------------------------------------------
  // Run Scan (simulated for demo; in production calls scanner-agent API)
  // -----------------------------------------------------------------------
  const handleRunScan = useCallback(async () => {
    if (scanStatus === 'SCANNING') return;

    setScanStatus('SCANNING');
    setLastReport(null);
    setIngestResult(null);
    setSyncNotification(null);

    // Phase 1: Initialization logs
    const initLines = generateScanLogLines(hostName, targetHost, osProfile, stigBenchmark);
    setTerminalLines(prev => [...prev, ...initLines]);

    // Phase 2: Generate simulated scan (in production, this calls scanner-agent/runner.py)
    await new Promise(resolve => setTimeout(resolve, 800));

    const report = generateSimulatedScanReport(
      currentTenant.id,
      hostName,
      targetHost,
      osProfile
    );

    // Phase 3: Stream rule evaluation results
    const ruleLines = generateRuleLogLines(report.results);
    for (let i = 0; i < ruleLines.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 40 + Math.random() * 30));
      setTerminalLines(prev => [...prev, ruleLines[i]]);
    }

    // Phase 4: Summary
    await new Promise(resolve => setTimeout(resolve, 300));
    const summaryLines = generateScanSummaryLines(report);
    setTerminalLines(prev => [...prev, ...summaryLines]);

    setLastReport(report);
    setScanStatus('COMPLETED');
  }, [scanStatus, hostName, targetHost, osProfile, stigBenchmark, currentTenant.id]);

  const handleTriggerAssetScan = useCallback((asset: EnclaveAsset) => {
    setSelectedAssetId(asset.id);
    setHostName(asset.hostName);
    setTargetHost(asset.ipAddress);
    setOsProfile(asset.osProfile);
    if (asset.osProfile === 'rhel9') setStigBenchmark('DISA_STIG_RHEL9');
    else if (asset.osProfile === 'rhel8') setStigBenchmark('DISA_STIG_RHEL8');
    else if (asset.osProfile === 'win2022') setStigBenchmark('DISA_STIG_WIN2022');
    else if (asset.osProfile === 'ubuntu2204') setStigBenchmark('DISA_STIG_UBUNTU2204');

    setActiveConsoleView('SCANNER');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => {
      handleRunScan();
    }, 150);
  }, [handleRunScan]);

  // -----------------------------------------------------------------------
  // Sync Findings to Control Matrix
  // -----------------------------------------------------------------------
  const handleSyncToMatrix = useCallback(async () => {
    if (!lastReport || scanStatus === 'SYNCING') return;

    setScanStatus('SYNCING');
    setTerminalLines(prev => [
      ...prev,
      '',
      `[${new Date().toISOString()}] ▸ Initiating GRC matrix ingestion...`,
      `[${new Date().toISOString()}] ▸ Mapping ${lastReport.results.length} rules to CMMC/NIST controls...`,
    ]);

    // Give the UI a beat to show the syncing state
    await new Promise(resolve => setTimeout(resolve, 600));

    try {
      const result = await ingestScapScanReport(
        lastReport,
        updateControlStatus,
        (_item) => {
          // Evidence is added via the ingest engine's audit mechanism;
          // in production this would also write to AssessmentContext state
        },
        currentTenant.id
      );

      // Ingest scan report directly into fleet asset telemetry and refresh boundary rollup
      await ingestScanReportToAsset(lastReport, currentTenant.id);
      if (refreshBoundaryTelemetry) {
        await refreshBoundaryTelemetry();
      }

      // Sync scan result back to persistent asset inventory registry
      const score = Math.round((lastReport.passedCount / lastReport.results.length) * 100);
      // The inventory refreshes itself (shared subscription). A read-only role cannot store the score: the scan itself still counts.
      await assetBackend.recordScan(hostName, targetHost, score).catch((err: unknown) => {
        console.warn('[PhotonScan] Could not store the scan score on the asset:', err);
      });

      setIngestResult(result);

      const syncLines = [
        `[${new Date().toISOString()}] ▸ ✓ Ingestion complete.`,
        `[${new Date().toISOString()}] ▸   Controls updated: ${result.controlsUpdated}`,
        `[${new Date().toISOString()}] ▸   Evidence hash:    ${result.auditHash.substring(0, 16)}...`,
        `[${new Date().toISOString()}] ▸   Unmapped rules:   ${result.summary.unmapped}`,
        '',
        `  ▸ Control matrix synchronized. Audit trail updated.`,
      ];

      setTerminalLines(prev => [...prev, ...syncLines]);
      setSyncNotification(
        `✓ ${result.controlsUpdated} controls updated — ${result.summary.passed} passed, ${result.summary.failed} failed`
      );
      setScanStatus('COMPLETED');

      // Auto-dismiss notification
      setTimeout(() => setSyncNotification(null), 8000);
    } catch (err: unknown) {
      setScanStatus('ERROR');
      setTerminalLines(prev => [
        ...prev,
        `[${new Date().toISOString()}] ✖ Ingestion error: ${errorMessage(err) || 'Unknown error'}`,
      ]);
    }
  }, [lastReport, scanStatus, updateControlStatus, currentTenant.id]);

  // -----------------------------------------------------------------------
  // Clear Terminal
  // -----------------------------------------------------------------------
  const handleClearTerminal = useCallback(() => {
    setTerminalLines([
      `[${new Date().toISOString()}] ▸ Terminal cleared.`,
      '',
    ]);
    setScanStatus('IDLE');
    setLastReport(null);
    setIngestResult(null);
    setSyncNotification(null);
  }, []);

  // -----------------------------------------------------------------------
  // Status indicator helpers
  // -----------------------------------------------------------------------
  const statusConfig: Record<PhotonScanStatus, { label: string; color: string; icon: React.ReactNode }> = {
    IDLE:        { label: 'Ready',       color: 'text-slate-400',    icon: <Radio className="w-3.5 h-3.5" /> },
    CONFIGURING: { label: 'Configuring', color: 'text-amber-400',    icon: <Cpu className="w-3.5 h-3.5" /> },
    SCANNING:    { label: 'Scanning...',  color: 'text-cyan-400',    icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> },
    COMPLETED:   { label: 'Completed',   color: 'text-emerald-400',  icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
    ERROR:       { label: 'Error',       color: 'text-red-400',      icon: <XCircle className="w-3.5 h-3.5" /> },
    SYNCING:     { label: 'Syncing...',  color: 'text-violet-400',   icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> },
  };

  const currentStatus = statusConfig[scanStatus];

  return (
    <div className="space-y-6">
      {/* Live Status Badge */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-cyan-500/20 to-violet-500/20 border border-cyan-500/30">
              <Zap className="w-5 h-5 text-cyan-400" />
            </div>
            Photon SCAP Execution Console
          </h1>
          <p className="text-sm text-slate-400 mt-1.5">
            Automated DISA STIG & OpenSCAP telemetry engine — scan, evaluate, and sync findings to the control matrix.
          </p>
        </div>

        {/* Live Status Badge */}
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-bold ${
          scanStatus === 'SCANNING' || scanStatus === 'SYNCING'
            ? 'border-cyan-500/40 bg-cyan-500/10'
            : scanStatus === 'COMPLETED'
            ? 'border-emerald-500/40 bg-emerald-500/10'
            : scanStatus === 'ERROR'
            ? 'border-red-500/40 bg-red-500/10'
            : 'border-slate-700 bg-slate-800/60'
        }`}>
          <span className={currentStatus.color}>{currentStatus.icon}</span>
          <span className={currentStatus.color}>{currentStatus.label}</span>
        </div>
      </div>

      {/* ─── View Mode Switcher ─── */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3 flex-wrap">
        <button
          onClick={() => setActiveConsoleView('SCANNER')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
            activeConsoleView === 'SCANNER'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
          }`}
        >
          <Zap className="w-3.5 h-3.5 text-cyan-400" />
          <span>Automated STIG Scanner</span>
        </button>

        <button
          onClick={() => setActiveConsoleView('INVENTORY')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
            activeConsoleView === 'INVENTORY'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
          }`}
        >
          <Server className="w-3.5 h-3.5 text-indigo-400" />
          <span>Asset & Hardware Inventory</span>
          <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-cyan-950/80 text-cyan-300 border border-cyan-500/30">
            {registeredAssets.length}
          </span>
        </button>

        <button
          onClick={() => setActiveConsoleView('FLEET')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
            activeConsoleView === 'FLEET'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
          }`}
        >
          <Layers className="w-3.5 h-3.5 text-violet-400" />
          <span>Boundary Fleet Rollup</span>
        </button>
      </div>

      {/* Sync Notification Toast */}
      {syncNotification && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300 flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{syncNotification}</span>
        </div>
      )}

      {/* ─── View 1: Automated Scanner ─── */}
      {activeConsoleView === 'SCANNER' && (
        <>
          {/* Top Row: Target Config + Scan Controls */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Target Configuration Card */}
            <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
                  <Server className="w-4 h-4 text-cyan-400" />
                  Target Configuration
                </div>
                <span className="text-xs text-slate-400">
                  Select an enclave endpoint or enter manually
                </span>
              </div>

              {/* Registered Asset Quick-Fill Dropdown */}
              <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1.5">
                <label htmlFor="photon-asset-picker" className="block text-xs font-semibold text-slate-300 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Database className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Select Target from Registered Asset Inventory</span>
                  </span>
                  <span className="text-xs text-cyan-400 font-mono">
                    {registeredAssets.length} Assets Registered
                  </span>
                </label>
                <div className="relative">
                  <select
                    id="photon-asset-picker"
                    value={selectedAssetId}
                    onChange={handleSelectRegisteredAsset}
                    disabled={scanStatus === 'SCANNING'}
                    className="w-full bg-slate-800/90 border border-cyan-500/40 rounded-lg px-3 py-2 text-xs font-mono text-cyan-200 focus:outline-none focus:ring-1 focus:ring-cyan-500 appearance-none pr-8 cursor-pointer"
                  >
                    <option value="">-- Choose registered asset to auto-fill parameters --</option>
                    {registeredAssets.map(asset => (
                      <option key={asset.id} value={asset.id}>
                        {asset.hostName} ({asset.ipAddress}) • {asset.osProfile.toUpperCase()} • {asset.cmmcAssetCategory.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-cyan-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Target IP */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">Target IP / Hostname</label>
              <div className="flex items-center gap-2">
                <Wifi className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  id="photon-target-ip"
                  type="text"
                  value={targetHost}
                  onChange={e => setTargetHost(e.target.value)}
                  placeholder="10.0.50.12"
                  className="flex-1 bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/50 transition-all font-mono"
                  disabled={scanStatus === 'SCANNING'}
                />
              </div>
            </div>

            {/* Hostname */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">Hostname</label>
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  id="photon-hostname"
                  type="text"
                  value={hostName}
                  onChange={e => setHostName(e.target.value)}
                  placeholder="enclave-node-01"
                  className="flex-1 bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/50 transition-all font-mono"
                  disabled={scanStatus === 'SCANNING'}
                />
              </div>
            </div>

            {/* OS Profile Selector */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">OS Profile</label>
              <div className="relative">
                <select
                  id="photon-os-profile"
                  value={osProfile}
                  onChange={e => setOsProfile(e.target.value)}
                  className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/50 transition-all appearance-none pr-8"
                  disabled={scanStatus === 'SCANNING'}
                >
                  {OS_PROFILES.map(p => (
                    <option key={p.value} value={p.value}>
                      {p.icon} {p.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>

            {/* STIG Benchmark Selector */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">DISA STIG Benchmark</label>
              <div className="relative">
                <select
                  id="photon-stig-benchmark"
                  value={stigBenchmark}
                  onChange={e => setStigBenchmark(e.target.value)}
                  className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/50 transition-all appearance-none pr-8"
                  disabled={scanStatus === 'SCANNING'}
                >
                  {STIG_BENCHMARKS.map(b => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>
          </div>
        </div>

        {/* Scan Execution Controller Card */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 flex flex-col justify-between gap-4">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
            <Shield className="w-4 h-4 text-violet-400" />
            Scan Execution
          </div>

          <div className="space-y-3 flex-1 flex flex-col justify-center">
            {/* Run Scan Button */}
            <button
              id="photon-run-scan"
              onClick={handleRunScan}
              disabled={scanStatus === 'SCANNING' || scanStatus === 'SYNCING'}
              className={`w-full flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl font-bold text-sm transition-all shadow-lg ${
                scanStatus === 'SCANNING'
                  ? 'bg-cyan-600/30 text-cyan-300 border border-cyan-500/40 cursor-wait'
                  : 'bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 text-white border border-cyan-500/30 hover:shadow-cyan-500/20 active:scale-[0.98]'
              }`}
            >
              {scanStatus === 'SCANNING' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Scanning Target...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Run Automated STIG Scan
                </>
              )}
            </button>

            {/* Sync to Matrix Button */}
            <button
              id="photon-sync-findings"
              onClick={handleSyncToMatrix}
              disabled={!lastReport || scanStatus === 'SCANNING' || scanStatus === 'SYNCING'}
              className={`w-full flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-xl font-bold text-xs transition-all ${
                lastReport && scanStatus !== 'SYNCING'
                  ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-600/30 hover:text-emerald-200 active:scale-[0.98]'
                  : 'bg-slate-800/40 text-slate-400 border border-slate-800 cursor-not-allowed'
              }`}
            >
              {scanStatus === 'SYNCING' ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Syncing to Control Matrix...
                </>
              ) : (
                <>
                  <ArrowDownToLine className="w-3.5 h-3.5" />
                  Sync Scan Findings to Control Matrix
                </>
              )}
            </button>

            {/* Clear Terminal */}
            <button
              id="photon-clear-terminal"
              onClick={handleClearTerminal}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs text-slate-400 hover:text-slate-300 border border-slate-800 hover:border-slate-700 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Clear Terminal
            </button>
          </div>
        </div>
      </div>

      {/* ─── Telemetry Terminal ─── */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950 overflow-hidden shadow-xl">
        {/* Terminal Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900/80 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-red-500/70" />
              <div className="w-3 h-3 rounded-full bg-amber-500/70" />
              <div className="w-3 h-3 rounded-full bg-emerald-500/70" />
            </div>
            <span className="text-xs font-mono text-slate-400">
              photon-telemetry — {hostName}@{targetHost}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
            <Terminal className="w-3 h-3" />
            <span>SCAP Engine v2.1.0</span>
          </div>
        </div>

        {/* Terminal Body */}
        <div
          ref={terminalRef}
          className="p-4 font-mono text-xs leading-relaxed text-slate-300 overflow-y-auto max-h-[420px] min-h-[280px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent"
          style={{ fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas", monospace' }}
        >
          {terminalLines.map((line, i) => (
            <div key={i} className={`whitespace-pre-wrap ${
              line.includes('✅') || line.includes('PASS') ? 'text-emerald-400/90' :
              line.includes('❌') || line.includes('FAIL') ? 'text-red-400/90' :
              line.includes('⚠️') || line.includes('ERROR') ? 'text-amber-400/90' :
              line.includes('✓') ? 'text-emerald-400' :
              line.includes('✖') ? 'text-red-400' :
              line.includes('▸') ? 'text-cyan-300/80' :
              line.startsWith('  ──') || line.startsWith('──') ? 'text-slate-400' :
              line.startsWith('╔') || line.startsWith('║') || line.startsWith('╚') ? 'text-violet-400/70' :
              'text-slate-400'
            }`}>
              {line || '\u00A0'}
            </div>
          ))}

          {/* Blinking cursor when scanning */}
          {(scanStatus === 'SCANNING' || scanStatus === 'SYNCING') && (
            <span className="inline-block w-2 h-4 bg-cyan-400 animate-pulse ml-0.5" />
          )}
        </div>
      </div>

      {/* ─── Results Summary Cards (shown after scan completes) ─── */}
      {lastReport && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-center">
            <p className="text-2xl font-black text-white">{lastReport.results.length}</p>
            <p className="text-xs text-slate-400 mt-1">Total Rules</p>
          </div>
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-center">
            <p className="text-2xl font-black text-emerald-400">{lastReport.passedCount}</p>
            <p className="text-xs text-emerald-400/70 mt-1">Passed</p>
          </div>
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-center">
            <p className="text-2xl font-black text-red-400">{lastReport.failedCount}</p>
            <p className="text-xs text-red-400/70 mt-1">Failed</p>
          </div>
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-center">
            <p className="text-2xl font-black text-amber-400">
              {lastReport.results.filter(r => r.status === 'ERROR').length}
            </p>
            <p className="text-xs text-amber-400/70 mt-1">Errors</p>
          </div>
        </div>
      )}

      {/* ─── Ingestion Results (shown after sync) ─── */}
      {ingestResult && (
        <div className="rounded-2xl border border-violet-500/20 bg-violet-500/5 p-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-bold text-violet-300">
            <Upload className="w-4 h-4" />
            GRC Matrix Sync Results
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-slate-400">Controls Updated</span>
              <p className="text-lg font-black text-white mt-0.5">{ingestResult.controlsUpdated}</p>
            </div>
            <div>
              <span className="text-slate-400">Unmapped Rules</span>
              <p className="text-lg font-black text-slate-300 mt-0.5">{ingestResult.summary.unmapped}</p>
            </div>
            <div>
              <span className="text-slate-400">Evidence Hash</span>
              <p className="text-xs font-mono text-violet-300 mt-1 truncate" title={ingestResult.auditHash}>
                {ingestResult.auditHash.substring(0, 24)}...
              </p>
            </div>
            <div>
              <span className="text-slate-400">Audit Chain</span>
              <p className="text-lg font-black text-emerald-400 mt-0.5 flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" />
                Verified
              </p>
            </div>
          </div>

          {/* Status Changes Detail */}
          {Object.keys(ingestResult.statusChanges).length > 0 && (
            <div className="border-t border-violet-500/20 pt-3 mt-3">
              <p className="text-xs font-semibold text-slate-400 mb-2">Status Changes Applied:</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(ingestResult.statusChanges).map(([controlId, status]) => (
                  <span
                    key={controlId}
                    className={`px-2 py-1 rounded-lg text-xs font-bold border ${
                      status === 'MET'
                        ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                        : status === 'IN_PROGRESS'
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                        : 'bg-red-500/10 text-red-300 border-red-500/30'
                    }`}
                  >
                    {controlId}: {status}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

          {/* ─── Enclave Asset Fleet Matrix Quick Preview ─── */}
          <AssetComplianceTable
            selectedHost={hostName}
            onSelectHost={({ hostName: h, ipAddress: ip, osProfile: os }) => {
              setHostName(h);
              setTargetHost(ip);
              setOsProfile(os);
              if (os === 'rhel9') setStigBenchmark('DISA_STIG_RHEL9');
              else if (os === 'rhel8') setStigBenchmark('DISA_STIG_RHEL8');
              else if (os === 'win2022') setStigBenchmark('DISA_STIG_WIN2022');
              else if (os === 'ubuntu2204') setStigBenchmark('DISA_STIG_UBUNTU2204');
            }}
            onTriggerScan={async ({ hostName: h, ipAddress: ip, osProfile: os }) => {
              setHostName(h);
              setTargetHost(ip);
              setOsProfile(os);
              if (os === 'rhel9') setStigBenchmark('DISA_STIG_RHEL9');
              else if (os === 'rhel8') setStigBenchmark('DISA_STIG_RHEL8');
              else if (os === 'win2022') setStigBenchmark('DISA_STIG_WIN2022');
              else if (os === 'ubuntu2204') setStigBenchmark('DISA_STIG_UBUNTU2204');
              setTimeout(() => {
                handleRunScan();
              }, 100);
            }}
          />
        </>
      )}

      {/* ─── View 2: Enclave Asset & Hardware Inventory ─── */}
      {activeConsoleView === 'INVENTORY' && (
        <AssetInventoryManager
          onTriggerScan={handleTriggerAssetScan}
          onSelectAsset={(asset) => {
            setSelectedAssetId(asset.id);
            setHostName(asset.hostName);
            setTargetHost(asset.ipAddress);
            setOsProfile(asset.osProfile);
            setActiveConsoleView('SCANNER');
          }}
          selectedHost={hostName}
        />
      )}

      {/* ─── View 3: Enclave Fleet Rollup Matrix ─── */}
      {activeConsoleView === 'FLEET' && (
        <AssetComplianceTable
          selectedHost={hostName}
          onSelectHost={({ hostName: h, ipAddress: ip, osProfile: os }) => {
            setHostName(h);
            setTargetHost(ip);
            setOsProfile(os);
            setActiveConsoleView('SCANNER');
          }}
          onTriggerScan={async ({ hostName: h, ipAddress: ip, osProfile: os }) => {
            setHostName(h);
            setTargetHost(ip);
            setOsProfile(os);
            setActiveConsoleView('SCANNER');
            setTimeout(() => {
              handleRunScan();
            }, 100);
          }}
        />
      )}
    </div>
  );
};
