import React, { useState, useRef, useEffect } from 'react';
import {
  Building2,
  ChevronDown,
  Plus,
  Check,
  Layers,
  Search,
  Cloud,
} from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { useAssessment } from '../../context/AssessmentContext';
import { SamStatus } from '../../types/tenant';

export const TenantSwitcher: React.FC = () => {
  const {
    tenants,
    currentTenant,
    currentUser,
    switchTenant,
    createTenant,
    setIsGcpArchitectureModalOpen,
  } = useTenant();

  const { metrics } = useAssessment();

  const [isTenantMenuOpen, setIsTenantMenuOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');

  // New tenant form state
  const [newName, setNewName] = useState('');
  const [newCage, setNewCage] = useState('');
  const [newSamStatus, setNewSamStatus] = useState<SamStatus>('ACTIVE');
  const [newSystemName, setNewSystemName] = useState('');
  const [newSystemOwner, setNewSystemOwner] = useState('');
  const [newIndustry, setNewIndustry] = useState('Defense Industrial Base');

  const tenantMenuRef = useRef<HTMLDivElement>(null);

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (tenantMenuRef.current && !tenantMenuRef.current.contains(event.target as Node)) {
        setIsTenantMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    createTenant({
      name: newName.trim(),
      cageCode: newCage.trim().toUpperCase() || 'N/A',
      samStatus: newSamStatus,
      systemName: newSystemName.trim() || `${newName.trim()} Operations Enclave`,
      systemOwner: newSystemOwner.trim() || currentUser.name,
      industry: newIndustry.trim() || 'Defense Industrial Base',
    });

    // Reset & close
    setNewName('');
    setNewCage('');
    setNewSystemName('');
    setNewSystemOwner('');
    setIsCreateModalOpen(false);
    setIsTenantMenuOpen(false);
  };

  const filteredTenants = tenants.filter(t =>
    t.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
    t.cageCode.toLowerCase().includes(searchFilter.toLowerCase())
  );

  const getSamBadge = (status: SamStatus) => {
    switch (status) {
      case 'ACTIVE':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">SAM Active</span>;
      case 'PENDING':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">SAM Pending</span>;
      default:
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-700 text-slate-300">SAM N/A</span>;
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Organization / Tenant Switcher Dropdown */}
      <div className="relative" ref={tenantMenuRef}>
        <button
          onClick={() => setIsTenantMenuOpen(prev => !prev)}
          className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-slate-800/90 hover:bg-slate-750 border border-slate-700 hover:border-brand-500/50 shadow-md transition-all text-left group"
          title="Switch Active Client Organization (Multi-Tenant)"
        >
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-brand-600 to-indigo-600 flex items-center justify-center text-white shrink-0 shadow-sm">
            <Building2 className="w-4 h-4" />
          </div>

          <div className="hidden sm:block text-left">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-white tracking-tight max-w-[140px] md:max-w-[180px] truncate">
                {currentTenant.name}
              </span>
              <span className="text-[10px] font-mono px-1 rounded bg-slate-900/80 text-brand-300 border border-slate-700">
                {currentTenant.cageCode || 'CAGE'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-slate-400">
              <span>{getSamBadge(currentTenant.samStatus)}</span>
              <span className="text-slate-500">•</span>
              <span className="font-mono text-brand-400 font-semibold">{metrics.metCount}/17 Met</span>
            </div>
          </div>

          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isTenantMenuOpen ? 'rotate-180' : ''}`} />
        </button>

        {/* Tenant Dropdown Menu */}
        {isTenantMenuOpen && (
          <div className="absolute left-0 mt-2 w-80 sm:w-96 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl z-50 overflow-hidden animate-fadeIn">
            <div className="p-3 border-b border-slate-800 bg-slate-950/60">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-brand-400" />
                  Client Organizations ({tenants.length})
                </span>
                <span className="text-[10px] text-slate-500 font-mono">Isolated Data Boundary</span>
              </div>
              
              {/* Search Box */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by company name or CAGE..."
                  value={searchFilter}
                  onChange={e => setSearchFilter(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
                />
              </div>
            </div>

            {/* Tenant List */}
            <div className="max-h-64 overflow-y-auto divide-y divide-slate-800/60 p-1">
              {filteredTenants.map(t => {
                const isActive = t.id === currentTenant.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      switchTenant(t.id);
                      setIsTenantMenuOpen(false);
                    }}
                    className={`w-full p-2.5 rounded-xl text-left flex items-center justify-between transition-colors ${
                      isActive ? 'bg-brand-600/15 border border-brand-500/30' : 'hover:bg-slate-800/60'
                    }`}
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold truncate ${isActive ? 'text-brand-300' : 'text-white'}`}>
                          {t.name}
                        </span>
                        {isActive && <Check className="w-3.5 h-3.5 text-brand-400 shrink-0" />}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400">
                        <span className="font-mono text-slate-300 bg-slate-800 px-1 rounded">
                          CAGE: {t.cageCode}
                        </span>
                        {getSamBadge(t.samStatus)}
                      </div>
                      <p className="text-[10px] text-slate-500 truncate mt-0.5">
                        {t.systemName}
                      </p>
                    </div>
                  </button>
                );
              })}

              {filteredTenants.length === 0 && (
                <div className="p-4 text-center text-xs text-slate-400">
                  No matching organizations found.
                </div>
              )}
            </div>

            {/* Create New Tenant Button */}
            <div className="p-2 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between gap-2">
              <button
                onClick={() => {
                  setIsCreateModalOpen(true);
                  setIsTenantMenuOpen(false);
                }}
                className="flex-1 py-2 px-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-md shadow-brand-500/20"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Client Organization</span>
              </button>

              <button
                onClick={() => {
                  setIsGcpArchitectureModalOpen(true);
                  setIsTenantMenuOpen(false);
                }}
                title="View Google Cloud SQL & Infrastructure Schema"
                className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
              >
                <Cloud className="w-4 h-4 text-brand-400" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modal: Create New Tenant Organization */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full p-6 shadow-2xl animate-scaleUp">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-brand-600/20 border border-brand-500/30 flex items-center justify-center text-brand-400">
                  <Building2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Add Client Organization</h3>
                  <p className="text-xs text-slate-400">Create a strictly isolated CMMC compliance tenant</p>
                </div>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="space-y-4 mt-4 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Company / Organization Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Titan Aerospace Systems, LLC"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white focus:outline-none focus:border-brand-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">CAGE Code</label>
                  <input
                    type="text"
                    maxLength={10}
                    placeholder="e.g. 6K9B2"
                    value={newCage}
                    onChange={e => setNewCage(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white font-mono uppercase focus:outline-none focus:border-brand-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">SAM.gov Status</label>
                  <select
                    value={newSamStatus}
                    onChange={e => setNewSamStatus(e.target.value as SamStatus)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white focus:outline-none focus:border-brand-500"
                  >
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="PENDING">PENDING</option>
                    <option value="EXPIRED">EXPIRED</option>
                    <option value="NOT_REGISTERED">NOT_REGISTERED</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Information System Name</label>
                <input
                  type="text"
                  placeholder="e.g. Corporate Defense Enclave (CDE)"
                  value={newSystemName}
                  onChange={e => setNewSystemName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white focus:outline-none focus:border-brand-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">System Owner / CISO</label>
                  <input
                    type="text"
                    placeholder="e.g. Jane Doe, CISO"
                    value={newSystemOwner}
                    onChange={e => setNewSystemOwner(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white focus:outline-none focus:border-brand-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">Industry Sector</label>
                  <input
                    type="text"
                    placeholder="e.g. Defense Avionics"
                    value={newIndustry}
                    onChange={e => setNewIndustry(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white focus:outline-none focus:border-brand-500"
                  />
                </div>
              </div>

              <div className="pt-4 flex items-center justify-end gap-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold shadow-lg shadow-brand-500/25 transition-all"
                >
                  Create & Switch Tenant
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
