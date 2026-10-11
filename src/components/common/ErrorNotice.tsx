import React from 'react';
import { AlertCircle } from 'lucide-react';

interface ErrorNoticeProps {
  message: string | null | undefined;
  className?: string;
}

/**
 * Inline error banner for forms (failed API calls, validation). Announced to screen readers via role="alert".
 * Renders nothing when there is no message.
 */
export const ErrorNotice: React.FC<ErrorNoticeProps> = ({ message, className = '' }) => {
  if (!message) return null;
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300 ${className}`}
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
      <span>{message}</span>
    </div>
  );
};

export default ErrorNotice;
