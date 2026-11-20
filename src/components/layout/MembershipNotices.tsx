import React, { useState } from 'react';
import { CalendarClock, UserX, X } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { accessEndedText, memberExpiryBannerText } from '../../data/membershipView';

/**
 * What a member is told about their own access (#258): an amber banner when the end date is near, and a rose alert when the
 * access has ended. Hiding the banner lasts until the page is reloaded (React state only, nothing is stored in the browser).
 */
export const MembershipNotices: React.FC = () => {
  const { currentTenant, myAccessExpiry, accessEnded, dismissAccessEnded } = useTenant();
  const [hiddenSoon, setHiddenSoon] = useState<string | null>(null);
  const expiresOn = currentTenant.serverBacked ? myAccessExpiry[currentTenant.id] ?? null : null;
  const soonText = memberExpiryBannerText(currentTenant.name, expiresOn, Date.now());
  const soonKey = `${currentTenant.id}:${expiresOn ?? ''}`;
  const toMain = () => requestAnimationFrame(() => document.getElementById('app-main')?.focus());
  if (accessEnded.length === 0 && (!soonText || hiddenSoon === soonKey)) return null;
  return (
    <div className="no-print px-3 sm:px-6">
      {accessEnded.map(n => (
        <div key={n.id} role="alert" className="max-w-7xl mx-auto mt-2 flex flex-col gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p className="flex min-w-0 items-start gap-2 text-rose-200"><UserX className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" /><span className="break-words">{accessEndedText(n.name, n.expiredOn)}</span></p>
          <button type="button" onClick={() => { dismissAccessEnded(n.id); toMain(); }} className="shrink-0 px-2 py-1 text-xs font-semibold text-slate-400 hover:text-white">Dismiss</button>
        </div>
      ))}
      {soonText && hiddenSoon !== soonKey && (
        <div role="region" aria-label="Access end date" className="max-w-7xl mx-auto mt-2 flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p className="flex min-w-0 items-start gap-2 text-amber-200"><CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" /><span>{soonText}</span></p>
          <button type="button" onClick={() => { setHiddenSoon(soonKey); toMain(); }} aria-label="Hide this notice" title="Hide this notice" className="p-1.5 rounded-lg text-amber-300/80 hover:text-white hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"><X className="h-4 w-4" aria-hidden="true" /></button>
        </div>
      )}
    </div>
  );
};
