import React, { useEffect, useId, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { ApiClient } from '../../services/apiClient';
import { acknowledgeSystemUseNotice, resetSystemUseNoticeAck } from '../../services/systemUseNoticeAck';
import { SYSTEM_USE_NOTICE_LOAD_FAILED, noticeGateView, type NoticeLoad } from '../../data/systemUseNotice';
import { ErrorNotice } from '../common/ErrorNotice';

/**
 * The system use notification before sign-in (issue #256, AC-8). Wraps a password form: while the platform's notice is on, the form
 * is not rendered until the person has read the notice and chosen "I acknowledge and accept". The acknowledged version is kept in
 * memory only and sent with the sign-in (see systemUseNoticeAck). Fails closed: while the notice is loading or could not be loaded,
 * the form is not shown. The text is plain text (never HTML) and is never logged. Every mount starts with no acknowledgement.
 */
export const SystemUseNoticeGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [load, setLoad] = useState<NoticeLoad>({ kind: 'loading' });
  const [ackVersion, setAckVersion] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const textRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  // Every visit to the sign-in page starts unacknowledged
  useEffect(() => {
    resetSystemUseNoticeAck();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    ApiClient.getSystemUseNotice().then(
      (notice) => {
        if (!cancelled) setLoad({ kind: 'loaded', notice });
      },
      () => {
        if (!cancelled) setLoad({ kind: 'failed' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const view = noticeGateView(load, ackVersion);
  useEffect(() => {
    if (view === 'notice') textRef.current?.focus();
  }, [view]);

  if (view === 'form') return <>{children}</>;
  if (view === 'loading') {
    return (
      <p role="status" aria-live="polite" className="py-6 text-center text-xs text-slate-400">
        Loading the system use notice…
      </p>
    );
  }
  if (view === 'failed' || load.kind !== 'loaded') {
    return (
      <div>
        <ErrorNotice message={SYSTEM_USE_NOTICE_LOAD_FAILED} />
        <button
          type="button"
          onClick={() => setAttempt((a) => a + 1)}
          className="mt-3 w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-bold text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
        >
          Try again
        </button>
      </div>
    );
  }

  const { notice } = load;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="flex items-center gap-2 text-sm font-bold text-white">
        <ShieldAlert className="w-4 h-4 text-amber-400" aria-hidden="true" />
        <span>System use notification</span>
      </h3>
      <div
        ref={textRef}
        tabIndex={0}
        role="region"
        aria-label="Notice text"
        className="max-h-[50vh] overflow-y-auto rounded-xl border border-amber-500/30 bg-slate-900/80 p-3.5 text-xs sm:text-sm leading-relaxed text-slate-200 whitespace-pre-wrap break-words focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
      >
        {notice.text}
      </div>
      <p className="text-xs text-slate-400">By continuing you confirm you have read these conditions and accept them. Your acknowledgement is recorded when you sign in.</p>
      <button
        type="button"
        onClick={() => {
          acknowledgeSystemUseNotice(notice.version);
          setAckVersion(notice.version);
        }}
        className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-bold text-xs shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
      >
        I acknowledge and accept
      </button>
    </section>
  );
};

export default SystemUseNoticeGate;
