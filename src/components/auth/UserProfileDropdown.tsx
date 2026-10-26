import React, { useState, useRef, useEffect } from 'react';
import {
  Shield,
  CheckCircle2,
  Lock,
  ChevronDown,
  Building2,
  Settings,
  Key,
  LogOut,
  Users,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useTenant } from '../../context/TenantContext';
import { TenantRole } from '../../types/tenant';
import { ROLE_LABELS } from '../../utils/roles';
import { AccountSettingsModal } from './AccountSettingsModal';
import { ApiTokensModal } from './ApiTokensModal';

interface UserProfileDropdownProps {
  onOpenTenantSwitcher?: () => void;
}

export const UserProfileDropdown: React.FC<UserProfileDropdownProps> = ({
  onOpenTenantSwitcher,
}) => {
  const { currentUser, logout } = useAuth();
  const {
    currentTenant,
    currentRole,
    switchUserRole,
    canManageTenant,
    setIsTeamModalOpen,
    isSuperAdmin,
  } = useTenant();


  const [isOpen, setIsOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [isTokensModalOpen, setIsTokensModalOpen] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getRoleBadge = (role: TenantRole) => {
    switch (role) {
      case 'TENANT_OWNER':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
            <Shield className="w-3 h-3" /> Tenant Owner
          </span>
        );
      case 'MSP_ADMIN':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
            <Shield className="w-3 h-3" /> MSP Admin
          </span>
        );
      case 'ASSESSOR':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">
            <CheckCircle2 className="w-3 h-3" /> Assessor / C3PAO
          </span>
        );
      case 'VIEWER':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-slate-500/20 text-slate-300 border border-slate-500/30">
            <Lock className="w-3 h-3" /> Read-Only
          </span>
        );
    }
  };

  return (
    <>
      <div className="relative" ref={menuRef}>
        {/* User Button */}
        <button
          onClick={() => setIsOpen(prev => !prev)}
          className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-slate-800/90 hover:bg-slate-750 border border-slate-700 hover:border-slate-600 transition-all text-left shadow-sm"
          title="User Profile & Identity Session"
        >
          {/* Avatar */}
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-brand-600 to-indigo-600 flex items-center justify-center text-white text-xs font-bold shrink-0 shadow-sm">
            {currentUser.name ? currentUser.name.charAt(0).toUpperCase() : 'U'}
          </div>

          {/* User Email & Role */}
          <div className="hidden lg:block text-left max-w-[170px]">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-white truncate">
                {currentUser.name}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="truncate max-w-[90px]">{currentTenant.name}</span>
              <span className="text-slate-400">•</span>
              <span className="text-brand-300 font-medium">{ROLE_LABELS[currentRole] ?? currentRole}</span>
            </div>
          </div>

          <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {/* Dropdown Menu */}
        {isOpen && (
          <div className="absolute right-0 mt-2 w-72 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl z-50 overflow-hidden animate-fadeIn">
            {/* Header: User & Tenant Summary */}
            <div className="p-3.5 border-b border-slate-800 bg-slate-950/70">
              <p className="text-xs font-bold text-white flex items-center justify-between">
                <span>{currentUser.name}</span>
                {getRoleBadge(currentRole)}
              </p>
              <p className="text-xs text-slate-400 font-mono truncate mt-0.5">
                {currentUser.email}
              </p>
              
              <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
                <span className="text-slate-400 flex items-center gap-1">
                  <Building2 className="w-3.5 h-3.5 text-brand-400" />
                  Active Enclave:
                </span>
                <span className="font-semibold text-brand-300 truncate max-w-[130px]" title={currentTenant.name}>
                  {currentTenant.name}
                </span>
              </div>
            </div>

            {/* Core Actions */}
            <div className="p-1.5 space-y-0.5">
              {/* Switch Organization (only when the host wires it up) */}
              {onOpenTenantSwitcher && (
                <button
                  onClick={() => {
                    setIsOpen(false);
                    onOpenTenantSwitcher();
                  }}
                  className="w-full px-3 py-2 rounded-xl text-left text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-2.5 transition-colors"
                >
                  <Building2 className="w-4 h-4 text-slate-400" />
                  <span>Switch Organization</span>
                </button>
              )}

              {/* Team & Role Permissions (Tenant Owner / Admin) */}
              {canManageTenant && (
                <button
                  onClick={() => {
                    setIsOpen(false);
                    setIsTeamModalOpen(true);
                  }}
                  className="w-full px-3 py-2 rounded-xl text-left text-xs font-medium text-purple-300 hover:text-white hover:bg-purple-950/40 flex items-center gap-2.5 transition-colors"
                >
                  <Users className="w-4 h-4 text-purple-400" />
                  <span>Team & Role Permissions</span>
                </button>
              )}

              {/* Super Admin Console (Pitch Black Cyber Operators) */}
              {isSuperAdmin && (
                <button
                  onClick={() => {
                    setIsOpen(false);
                    if (typeof window !== 'undefined') {
                      window.location.hash = 'admin';
                    }
                  }}
                  className="w-full px-3 py-2 rounded-xl text-left text-xs font-bold text-amber-300 hover:text-amber-200 hover:bg-amber-950/40 flex items-center gap-2.5 transition-colors"
                >
                  <Shield className="w-4 h-4 text-amber-400" />
                  <span>Super Admin Console</span>
                </button>
              )}

              {/* Account Settings */}
              <button
                onClick={() => {
                  setIsOpen(false);
                  setIsAccountModalOpen(true);
                }}
                className="w-full px-3 py-2 rounded-xl text-left text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-2.5 transition-colors"
              >
                <Settings className="w-4 h-4 text-slate-400" />
                <span>Account Settings</span>
              </button>

              {/* API Keys / Tokens */}
              <button
                onClick={() => {
                  setIsOpen(false);
                  setIsTokensModalOpen(true);
                }}
                className="w-full px-3 py-2 rounded-xl text-left text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-2.5 transition-colors"
              >
                <Key className="w-4 h-4 text-slate-400" />
                <span>API Session Token</span>
              </button>
            </div>


            {/* Quick RBAC Role Simulation */}
            <div className="p-2 border-t border-slate-800 bg-slate-950/40">
              <span className="text-xs uppercase tracking-wider font-bold text-slate-400 px-1 block mb-1">
                Simulate CMMC Role:
              </span>
              <div className="grid grid-cols-3 gap-1">
                {(['TENANT_OWNER', 'ASSESSOR', 'VIEWER'] as TenantRole[]).map(role => (
                  <button
                    key={role}
                    onClick={() => {
                      switchUserRole(role);
                      setIsOpen(false);
                    }}
                    className={`px-2 py-1 rounded-lg text-xs font-bold transition-colors ${
                      currentRole === role
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {role === 'TENANT_OWNER' ? 'Owner' : role === 'ASSESSOR' ? 'Assessor' : 'Viewer'}
                  </button>
                ))}
              </div>
            </div>

            {/* Sign Out */}
            <div className="p-1.5 border-t border-slate-800 bg-slate-950/80">
              <button
                onClick={async () => {
                  setIsOpen(false);
                  await logout();
                }}
                className="w-full px-3 py-2 rounded-xl text-left text-xs font-semibold text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 flex items-center gap-2.5 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out of Enclave</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Account Settings Modal */}
      <AccountSettingsModal
        isOpen={isAccountModalOpen}
        onClose={() => setIsAccountModalOpen(false)}
      />

      {/* API Tokens Modal */}
      <ApiTokensModal
        isOpen={isTokensModalOpen}
        onClose={() => setIsTokensModalOpen(false)}
      />
    </>
  );
};
