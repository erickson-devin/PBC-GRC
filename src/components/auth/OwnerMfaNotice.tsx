import React, { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { ApiClient } from '../../services/apiClient';
import { OWNER_MFA_NOTICE, showOwnerMfaNotice } from '../../utils/sessionLock';

/** Before an action that makes the person an owner: say that the screen will lock and ask for two-step verification. */
export const OwnerMfaNotice: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { isAuthenticated, mfaEnrolled } = useAuth();
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => {
    if (!isAuthenticated || mfaEnrolled) return undefined;
    let cancelled = false;
    ApiClient.getMfaStatus().then((s) => { if (!cancelled) setMode(s.mode); }, () => { /* unknown mode: no notice */ });
    return () => { cancelled = true; };
  }, [isAuthenticated, mfaEnrolled]);
  if (!showOwnerMfaNotice(mode, mfaEnrolled)) return null;
  return (
    <div role="note" className={`flex items-start gap-2 p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 text-xs leading-relaxed ${className}`}>
      <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" aria-hidden="true" />
      <span>{OWNER_MFA_NOTICE}</span>
    </div>
  );
};

export default OwnerMfaNotice;
