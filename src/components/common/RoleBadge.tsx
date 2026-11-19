import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Shield, UserCog, CheckCircle2, Lock } from 'lucide-react';
import type { TenantRole } from '../../types/tenant';
import { roleLabel } from '../../data/roleView';

/** One visual language per role: the icon is the non-colour cue, the label is always the readable name (never the raw id). */
export const ROLE_STYLES: Record<
  TenantRole,
  { Icon: LucideIcon; badge: string; iconText: string; cardSelected: string; dot: string }
> = {
  TENANT_OWNER: { Icon: Shield, badge: 'bg-purple-500/20 text-purple-300 border border-purple-500/30', iconText: 'text-purple-400', cardSelected: 'bg-purple-500/10 border-purple-500/40 ring-1 ring-purple-500/30', dot: 'bg-purple-400' },
  TENANT_ADMIN: { Icon: UserCog, badge: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30', iconText: 'text-indigo-400', cardSelected: 'bg-indigo-500/10 border-indigo-500/40 ring-1 ring-indigo-500/30', dot: 'bg-indigo-400' },
  MSP_ADMIN: { Icon: Shield, badge: 'bg-amber-500/20 text-amber-300 border border-amber-500/30', iconText: 'text-amber-400', cardSelected: 'bg-amber-500/10 border-amber-500/40 ring-1 ring-amber-500/30', dot: 'bg-amber-400' },
  ASSESSOR: { Icon: CheckCircle2, badge: 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30', iconText: 'text-cyan-400', cardSelected: 'bg-blue-500/10 border-blue-500/40 ring-1 ring-blue-500/30', dot: 'bg-blue-400' },
  VIEWER: { Icon: Lock, badge: 'bg-slate-700/50 text-slate-300 border border-slate-600/50', iconText: 'text-slate-400', cardSelected: 'bg-slate-700/20 border-slate-500/40 ring-1 ring-slate-500/30', dot: 'bg-slate-400' },
};

export const RoleBadge: React.FC<{ role: TenantRole; className?: string }> = ({ role, className = '' }) => {
  const { Icon, badge } = ROLE_STYLES[role] ?? ROLE_STYLES.VIEWER;
  return (
    <span
      className={`badge inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold whitespace-nowrap shadow-sm ${badge} ${className}`}
    >
      <Icon className="w-3 h-3" aria-hidden="true" /> {roleLabel(role)}
    </span>
  );
};

export default RoleBadge;
