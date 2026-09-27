import React, { useState, useEffect } from 'react';
import {
  Server,
  Monitor,
  CheckCircle2,
  AlertTriangle,
  Play,
  RotateCcw,
  Search,
  Terminal,
  Cpu,
  Clock,
  Activity,
  Layers,
} from 'lucide-react';
import { AssetTelemetryRecord } from '../../types/telemetry';
import { getEnclaveFleet } from '../../data/telemetry/assetTelemetryEngine';
import { useTenant } from '../../context/TenantContext';

interface AssetComplianceTableProps {
  onSelectHost?: (host: { hostName: string; ipAddress: string; osProfile: string }) => void;
  onTriggerScan?: (host: { hostName: string; ipAddress: string; osProfile: string }) => void;
  selectedHost?: string;
}

export const AssetComplianceTable: React.FC<AssetComplianceTableProps> = ({
  onSelectHost,
  onTriggerScan,
  selectedHost,
}) => {
  const { currentTenant } = useTenant();
  const [fleet, setFleet] = useState<AssetTelemetryRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadFleet = () => {
    setIsRefreshing(true);
    const data = getEnclaveFleet(currentTenant.id);
    setFleet(data);
    setTimeout(() => setIsRefreshing(false), 300);
  };

  useEffect(() => {
    loadFleet();
  }, [currentTenant.id]);

  const filteredFleet = fleet.filter(asset =>
    asset.hostName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    asset.ipAddress.includes(searchQuery) ||
    asset.osProfile.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalAssets = fleet.length;
  const compliantAssets = fleet.filter(a => a.failedRuleCount === 0).length;
  const nonCompliantAssets = totalAssets - compliantAssets;
  const avgScore = totalAssets > 0
    ? Math.round(fleet.reduce((acc, a) => acc + a.assetComplianceScore, 0) / totalAssets)
    : 100;

  const getOsLabel = (profile: string) => {
    switch (profile) {
      case 'rhel9':
        return { label: 'RHEL 9.2 (Hardened)', color: 'bg-red-500/15 text-red-300 border-red-500/30' };
      case 'ubuntu2204':
        return { label: 'Ubuntu 22.04 LTS', color: 'bg-amber-500/15 text-amber-300 border-amber-500/30' };
      case 'win2022':
        return { label: 'Win Server 2022', color: 'bg-blue-500/15 text-blue-300 border-blue-500/30' };
      case 'rhel8':
        return { label: 'RHEL 8.8 (Hardened)', color: 'bg-red-500/15 text-red-300 border-red-500/30' };
      default:
        return { label: profile, color: 'bg-slate-800 text-slate-300 border-slate-700' };
    }
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
      {/* Header with Title and Metrics */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
            <Layers className="w-4 h-4 text-cyan-400" />
            <span>Enclave Asset Fleet Matrix</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-cyan-950/60 text-cyan-300 border border-cyan-500/30">
              {totalAssets} Endpoints Registered
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Boundary-wide endpoint compliance telemetry rolled up to CMMC 2.0 Level 1 / NIST SP 800-171 controls.
          </p>
        </div>

        {/* Quick Summary Badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 text-xs">
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-slate-400">Fleet Health:</span>
            <span className="font-mono font-bold text-white">{avgScore}%</span>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-950/50 border border-emerald-500/30 text-xs text-emerald-300">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span className="font-mono font-bold">{compliantAssets}</span>
            <span>Compliant</span>
          </div>
          {nonCompliantAssets > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-950/50 border border-rose-500/30 text-xs text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              <span className="font-mono font-bold">{nonCompliantAssets}</span>
              <span>Action Required</span>
            </div>
          )}
          <button
            onClick={loadFleet}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 border border-slate-700 transition-colors"
            title="Refresh Fleet Data"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search endpoint hostname, IP address, or OS profile..."
            className="w-full bg-slate-800/80 border border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
          />
        </div>
      </div>

      {/* Fleet Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/50">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
              <th className="py-2.5 px-3">Endpoint / Hostname</th>
              <th className="py-2.5 px-3">IP Address</th>
              <th className="py-2.5 px-3">OS Profile</th>
              <th className="py-2.5 px-3">Last Scan Time</th>
              <th className="py-2.5 px-3">Compliance Score</th>
              <th className="py-2.5 px-3">Status</th>
              <th className="py-2.5 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {filteredFleet.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-slate-500">
                  No enclave endpoints matching "{searchQuery}"
                </td>
              </tr>
            ) : (
              filteredFleet.map(asset => {
                const os = getOsLabel(asset.osProfile);
                const isSelected = selectedHost === asset.hostName;
                const isCompliant = asset.failedRuleCount === 0;

                return (
                  <tr
                    key={asset.assetId}
                    className={`hover:bg-slate-800/40 transition-colors ${
                      isSelected ? 'bg-cyan-950/20' : ''
                    }`}
                  >
                    {/* Hostname */}
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        {asset.osProfile === 'win2022' ? (
                          <Server className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                        ) : asset.hostName.includes('WS') ? (
                          <Monitor className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        ) : (
                          <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                        )}
                        <div>
                          <span className="font-mono font-bold text-white block">
                            {asset.hostName}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500">
                            {asset.macAddress}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* IP Address */}
                    <td className="py-2.5 px-3 font-mono text-slate-300">
                      {asset.ipAddress}
                    </td>

                    {/* OS Profile */}
                    <td className="py-2.5 px-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${os.color}`}>
                        {os.label}
                      </span>
                    </td>

                    {/* Last Scan Time */}
                    <td className="py-2.5 px-3 text-slate-400 font-mono text-[11px]">
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3 text-slate-500" />
                        <span>{new Date(asset.lastScanTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </td>

                    {/* Compliance Score */}
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-slate-800 h-2 rounded-full overflow-hidden shrink-0">
                          <div
                            className={`h-full rounded-full transition-all ${
                              asset.assetComplianceScore === 100
                                ? 'bg-emerald-400'
                                : asset.assetComplianceScore >= 80
                                ? 'bg-cyan-400'
                                : 'bg-rose-500'
                            }`}
                            style={{ width: `${asset.assetComplianceScore}%` }}
                          />
                        </div>
                        <span className="font-mono font-bold text-white text-xs">
                          {asset.assetComplianceScore}%
                        </span>
                      </div>
                    </td>

                    {/* Status */}
                    <td className="py-2.5 px-3">
                      {isCompliant ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          <span>COMPLIANT</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-rose-500/15 text-rose-300 border border-rose-500/30">
                          <AlertTriangle className="w-3 h-3 text-rose-400" />
                          <span>{asset.failedRuleCount} NON-COMPLIANT</span>
                        </span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="py-2.5 px-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => {
                            if (onSelectHost) {
                              onSelectHost({
                                hostName: asset.hostName,
                                ipAddress: asset.ipAddress,
                                osProfile: asset.osProfile,
                              });
                            }
                          }}
                          className="px-2 py-1 rounded-lg bg-cyan-950/60 hover:bg-cyan-900/60 text-cyan-300 border border-cyan-500/30 text-[11px] font-semibold transition-colors flex items-center gap-1"
                          title="Load Target into Console"
                        >
                          <Terminal className="w-3 h-3" />
                          <span>Load</span>
                        </button>

                        <button
                          onClick={() => {
                            if (onTriggerScan) {
                              onTriggerScan({
                                hostName: asset.hostName,
                                ipAddress: asset.ipAddress,
                                osProfile: asset.osProfile,
                              });
                            } else if (onSelectHost) {
                              onSelectHost({
                                hostName: asset.hostName,
                                ipAddress: asset.ipAddress,
                                osProfile: asset.osProfile,
                              });
                            }
                          }}
                          className="px-2 py-1 rounded-lg bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 text-white font-bold text-[11px] transition-all flex items-center gap-1 shadow-sm"
                          title="Trigger SCAP STIG Scan against this host"
                        >
                          <Play className="w-3 h-3" />
                          <span>Scan</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
