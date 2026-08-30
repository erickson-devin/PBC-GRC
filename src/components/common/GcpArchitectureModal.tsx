import React, { useState } from 'react';
import {
  Cloud,
  Database,
  Shield,
  HardDrive,
  Key,
  Copy,
  Check,
  Download,
  X,
  Layers,
  Terminal,
  Lock,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { CloudSqlService } from '../../services/cloudSqlService';
import { GcsService } from '../../services/gcsService';

export const GcpArchitectureModal: React.FC = () => {
  const { isGcpArchitectureModalOpen, setIsGcpArchitectureModalOpen, currentTenant } = useTenant();
  const [activeTab, setActiveTab] = useState<'sql' | 'storage' | 'identity'>('sql');
  const [copied, setCopied] = useState(false);

  if (!isGcpArchitectureModalOpen) return null;

  const gcpConfig = GcsService.getConfig();
  const tables = CloudSqlService.getTables();
  const sqlScript = CloudSqlService.getSqlScript();

  const handleCopySql = () => {
    navigator.clipboard.writeText(sqlScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadSql = () => {
    const blob = new Blob([sqlScript], { type: 'text/sql' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pbc_grc_cloud_sql_schema_${new Date().toISOString().split('T')[0]}.sql`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-6 animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-scaleUp">
        
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-brand-500/20">
              <Cloud className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight">
                  Google Cloud Platform (GCP) Architecture & Schema
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  Cloud SQL + GCS Active
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Multi-Tenant Logical Isolation • Row-Level Security (RLS) • GCS Signed URLs • SHA-256 Immutability
              </p>
            </div>
          </div>

          <button
            onClick={() => setIsGcpArchitectureModalOpen(false)}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="px-5 pt-3 border-b border-slate-800 bg-slate-950/30 flex items-center gap-2">
          <button
            onClick={() => setActiveTab('sql')}
            className={`pb-3 px-3 text-xs font-semibold flex items-center gap-2 border-b-2 transition-colors ${
              activeTab === 'sql'
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Database className="w-4 h-4" />
            <span>Cloud SQL (PostgreSQL Schema)</span>
          </button>

          <button
            onClick={() => setActiveTab('storage')}
            className={`pb-3 px-3 text-xs font-semibold flex items-center gap-2 border-b-2 transition-colors ${
              activeTab === 'storage'
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <HardDrive className="w-4 h-4" />
            <span>Google Cloud Storage (GCS & SHA-256)</span>
          </button>

          <button
            onClick={() => setActiveTab('identity')}
            className={`pb-3 px-3 text-xs font-semibold flex items-center gap-2 border-b-2 transition-colors ${
              activeTab === 'identity'
                ? 'border-brand-500 text-brand-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Key className="w-4 h-4" />
            <span>Google Cloud Identity & Workspace SSO</span>
          </button>
        </div>

        {/* Modal Content Body */}
        <div className="p-5 overflow-y-auto flex-1 space-y-5">
          {activeTab === 'sql' && (
            <div className="space-y-5">
              {/* Tables Overview Grid */}
              <div>
                <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-brand-400" />
                  Cloud SQL Relational Tables with Row-Level Security
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {tables.map(tbl => (
                    <div key={tbl.tableName} className="p-3 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-bold text-white bg-slate-800 px-2 py-0.5 rounded">
                          {tbl.tableName}
                        </span>
                        {tbl.rlsEnabled && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                            <Lock className="w-2.5 h-2.5" /> RLS
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 leading-snug">{tbl.description}</p>
                      <div className="text-[10px] text-slate-500 font-mono pt-1 border-t border-slate-800/80">
                        PK: {tbl.primaryKey}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Live SQL Script Viewer */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-brand-400" />
                    PostgreSQL 15+ DDL Migration Script (`schema.sql`)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCopySql}
                      className="px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 transition-colors"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copied ? 'Copied' : 'Copy DDL'}</span>
                    </button>
                    <button
                      onClick={handleDownloadSql}
                      className="px-2.5 py-1 text-xs font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white flex items-center gap-1.5 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download .sql</span>
                    </button>
                  </div>
                </div>

                <pre className="p-4 rounded-2xl bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto max-h-72 leading-relaxed">
                  {sqlScript}
                </pre>
              </div>
            </div>
          )}

          {activeTab === 'storage' && (
            <div className="space-y-5">
              <div className="p-4 rounded-2xl bg-brand-950/30 border border-brand-500/30 text-xs space-y-2">
                <div className="flex items-center gap-2 text-brand-300 font-bold text-sm">
                  <HardDrive className="w-4 h-4" />
                  <span>Google Cloud Storage Bucket Topology</span>
                </div>
                <p className="text-slate-300 leading-relaxed">
                  Evidence artifacts are organized under strict tenant-prefixed storage buckets. 
                  Direct browser uploads use <strong>GCS Signed URLs</strong> with HMAC authorization, bypassing application server overhead.
                </p>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-[11px] text-brand-300 break-all">
                  gs://{gcpConfig.gcsBucketName}/tenants/<span className="text-emerald-400">{currentTenant.id}</span>/controls/<span className="text-amber-400">{'{control_id}'}</span>/{'{file_id}_{name}'}
                </div>
              </div>

              {/* SHA-256 Immutability Engine */}
              <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-3">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <Shield className="w-4 h-4 text-emerald-400" />
                  SHA-256 Cryptographic Immutability & Audit Trail
                </h4>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Every uploaded evidence file undergoes client-side cryptographic hashing via the standard Web Crypto API (`crypto.subtle.digest('SHA-256')`).
                  The computed SHA-256 fingerprint is stamped into the Cloud SQL metadata record to guarantee non-repudiation and evidence integrity for C3PAO audits.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="p-3 rounded-xl bg-slate-900 border border-slate-800">
                    <span className="text-slate-400 block text-[10px] uppercase font-bold">Offline Resilience</span>
                    <span className="text-white font-semibold">IndexedDB Local Vault Fallback</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-900 border border-slate-800">
                    <span className="text-slate-400 block text-[10px] uppercase font-bold">Cloud Target</span>
                    <span className="text-emerald-400 font-semibold font-mono">GCS us-central1 (Dual-Region)</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'identity' && (
            <div className="space-y-5">
              <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-3 text-xs">
                <div className="flex items-center gap-2 text-white font-bold text-sm">
                  <Key className="w-4 h-4 text-brand-400" />
                  <span>Google Workspace & Cloud Identity SSO Architecture</span>
                </div>
                <p className="text-slate-300 leading-relaxed">
                  Authentication aligns with Google Cloud Identity / Firebase Multi-Tenant Auth. Users logging in with corporate Google Workspace accounts (@yourdomain.com) have their tenant access and RBAC roles dynamically evaluated.
                </p>

                <div className="space-y-2 pt-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Supported RBAC Role Matrix:</span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="p-3 rounded-xl bg-purple-950/30 border border-purple-500/30">
                      <span className="font-bold text-purple-300 block">Tenant Owner</span>
                      <span className="text-[11px] text-slate-400">Full write permissions, organization settings, user role management, export & deletion.</span>
                    </div>
                    <div className="p-3 rounded-xl bg-blue-950/30 border border-blue-500/30">
                      <span className="font-bold text-blue-300 block">Assessor / Consultant</span>
                      <span className="text-[11px] text-slate-400">Read & write assessment narratives, upload audit evidence, generate official SSP.</span>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700">
                      <span className="font-bold text-slate-300 block">Read-Only Viewer</span>
                      <span className="text-[11px] text-slate-400">Executive view only. Cannot alter notes, change statuses, or delete evidence.</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400">
          <span className="font-mono">Target: GCP Cloud Run + Cloud SQL (Postgres)</span>
          <button
            onClick={() => setIsGcpArchitectureModalOpen(false)}
            className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-medium transition-colors"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
};
