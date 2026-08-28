import React, { useRef } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  Download,
  Upload,
  RotateCcw,
  Sparkles,
  CheckCircle2,
  Lock,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';

export const Header: React.FC = () => {
  const {
    state,
    metrics,
    loadDemoScenario,
    resetAssessment,
    exportAssessmentJSON,
    importAssessmentJSON,
    setActiveTab,
  } = useAssessment();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const success = await importAssessmentJSON(file);
      if (success) {
        alert('Assessment successfully imported!');
      }
      e.target.value = '';
    }
  };

  const handleReset = async () => {
    if (window.confirm('Are you sure you want to reset this assessment to a blank baseline? All custom notes and evidence metadata will be cleared.')) {
      await resetAssessment();
    }
  };

  return (
    <header className="no-print bg-slate-900/90 backdrop-blur-md border-b border-slate-800 sticky top-0 z-40 px-4 lg:px-8 py-3 transition-colors">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        
        {/* Brand & System Title */}
        <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
          <div 
            onClick={() => setActiveTab('dashboard')}
            className="flex items-center gap-3 cursor-pointer group"
          >
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500 to-blue-700 flex items-center justify-center shadow-lg shadow-brand-500/20 group-hover:scale-105 transition-transform">
              <ShieldCheck className="w-6 h-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg text-white tracking-tight">PBC-GRC</span>
                <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-brand-500/20 text-brand-300 border border-brand-500/30">
                  CMMC Level 1
                </span>
              </div>
              <p className="text-xs text-slate-400 font-medium truncate max-w-[220px] sm:max-w-xs">
                {state.sspMetadata.organizationName} • CAGE: <span className="font-mono text-brand-300">{state.sspMetadata.cageCode || 'N/A'}</span>
              </p>
            </div>
          </div>

          {/* Mobile SPRS Badge */}
          <div className="md:hidden">
            {metrics.isSprsReady ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                <CheckCircle2 className="w-3.5 h-3.5" /> SPRS Ready
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                <AlertTriangle className="w-3.5 h-3.5" /> {metrics.metCount}/17 Met
              </span>
            )}
          </div>
        </div>

        {/* Center/Right: SPRS Readiness Pill + Global Actions */}
        <div className="flex items-center gap-3 w-full md:w-auto justify-end flex-wrap">
          
          {/* SPRS Indicator (Desktop) */}
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/80 shadow-inner">
            <div className="text-xs text-slate-400 flex items-center gap-1.5 font-medium">
              <Lock className="w-3.5 h-3.5 text-slate-400" />
              <span>SPRS Score:</span>
            </div>
            {metrics.isSprsReady ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 animate-pulse-subtle">
                <CheckCircle2 className="w-3.5 h-3.5" />
                SPRS READY (100%)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                <AlertTriangle className="w-3.5 h-3.5" />
                {metrics.metCount} / 17 Met ({metrics.completionPercentage}%)
              </span>
            )}
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-1.5">
            {/* Load Demo */}
            <button
              onClick={loadDemoScenario}
              title="Pre-populate 100% compliant demo data, narratives, and sample evidence"
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-brand-600/20 hover:bg-brand-600/30 text-brand-300 border border-brand-500/30 hover:border-brand-500/50 transition-colors flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-brand-400" />
              <span className="hidden sm:inline">Load Demo Data</span>
            </button>

            {/* Export Menu / Dropdown */}
            <button
              onClick={exportAssessmentJSON}
              title="Backup current assessment to JSON"
              className="p-2 text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors"
            >
              <Download className="w-4 h-4" />
            </button>

            {/* Import JSON */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept=".json"
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              title="Import assessment from JSON backup"
              className="p-2 text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors"
            >
              <Upload className="w-4 h-4" />
            </button>

            {/* Reset */}
            <button
              onClick={handleReset}
              title="Reset assessment to blank baseline"
              className="p-2 text-rose-400/80 hover:text-rose-300 bg-slate-800 hover:bg-rose-950/40 border border-slate-700 hover:border-rose-900 rounded-lg transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>
        </div>

      </div>
    </header>
  );
};
