import React from 'react';
import { Info } from 'lucide-react';
import type { AiNoticeCopy } from '../../data/aiAvailabilityView';

interface Props {
  copy: AiNoticeCopy | null;
  /** Add the administrator's hint (how to turn the AI on). */
  showAdminHint?: boolean;
  id?: string;
  className?: string;
}

/** A calm, neutral line that says the local AI is off or unavailable: not a warning, because the manual way always works. */
export const AiOffNotice: React.FC<Props> = ({ copy, showAdminHint, id, className }) => {
  if (!copy) return null;
  return (
    <p id={id} role="status" className={`flex items-start gap-1.5 text-xs text-slate-400 ${className ?? ''}`}>
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
      <span>
        {copy.line}
        {showAdminHint && copy.adminHint && <span className="block mt-0.5 text-slate-400">{copy.adminHint}</span>}
      </span>
    </p>
  );
};
