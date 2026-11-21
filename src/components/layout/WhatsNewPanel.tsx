import React, { useEffect, useId, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Info, Sparkles, X } from 'lucide-react';
import { DialogOverlay, DialogTitle } from '../common/DialogOverlay';
import { ErrorNotice } from '../common/ErrorNotice';
import { parseReleaseNotes } from '../../data/releaseNotes/releaseNotes';
import type { ReleaseNotes } from '../../data/releaseNotes/releaseNotes';
import { WHATS_NEW_TEXT, noticeKey, postedText, releaseView, releasedText, sortAnnouncements } from '../../data/whatsNewView';
import type { Release, WhatsNewState } from '../../data/whatsNewView';
import type { NoticeKind } from '../../services/apiClient';

interface WhatsNewPanelProps {
  state: WhatsNewState;
  markBusy: string | null;
  markError: { key: string; message: string } | null;
  onMarkRead: (kind: NoticeKind, ref: string) => void;
  onRetry: () => void;
  onClose: () => void;
}

/** The sections of one release as plain text nodes: never HTML, never auto-linked. */
const ReleaseBody: React.FC<{ release: Release }> = ({ release }) => (
  <div className="space-y-3">
    <p className="text-slate-300 leading-relaxed break-words">{release.summary}</p>
    {release.sections.map((s) => (
      <div key={s.heading} className="space-y-1.5">
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">{s.heading}</h4>
        <ul className="list-disc pl-5 space-y-1 text-slate-300 leading-relaxed">
          {s.items.map((item) => (
            <li key={item} className="break-words">{item}</li>
          ))}
        </ul>
      </div>
    ))}
  </div>
);

/**
 * The "What's new" drawer (issue #260): announcements from the platform administrator, then the release notes of this version and an
 * earlier-versions list. The notes are loaded from the bundle only when the panel opens, so they work without the server; the read
 * state comes from the server and is not shown (and cannot be changed) while it cannot be reached.
 */
export const WhatsNewPanel: React.FC<WhatsNewPanelProps> = ({ state, markBusy, markError, onMarkRead, onRetry, onClose }) => {
  const uid = useId();
  const [notes, setNotes] = useState<ReleaseNotes | null>(null);
  const [notesFailed, setNotesFailed] = useState(false);

  useEffect(() => {
    let off = false;
    import('../../data/releaseNotes/releaseNotes.json')
      .then((m) => { if (!off) setNotes(parseReleaseNotes(m.default)); })
      .catch(() => { if (!off) setNotesFailed(true); });
    return () => { off = true; };
  }, []);

  const rv = notes ? releaseView(notes, state) : null;
  const releaseKey = rv ? noticeKey('release', rv.currentVersion) : '';

  return (
    <DialogOverlay onClose={onClose} onClick={onClose} className="fixed inset-0 z-50 flex justify-end bg-slate-950/70 backdrop-blur-sm animate-fadeIn">
      <div onClick={(e) => e.stopPropagation()} className="h-full max-h-[100dvh] w-full sm:max-w-md flex flex-col bg-slate-950 border-l border-slate-800 shadow-2xl">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-800 shrink-0">
          <DialogTitle as="h2" className="text-base font-extrabold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-cyan-300" aria-hidden="true" />
            {WHATS_NEW_TEXT.panelTitle}
          </DialogTitle>
          <button type="button" onClick={onClose} className="modal-close-trigger" aria-label={WHATS_NEW_TEXT.close} title={WHATS_NEW_TEXT.close}>
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-6 text-xs">
          {/* A. Announcements */}
          <section aria-labelledby={`${uid}-ann`} className="space-y-3">
            <div>
              <h3 id={`${uid}-ann`} className="text-sm font-bold text-white">{WHATS_NEW_TEXT.announcementsHeading}</h3>
              <p className="text-slate-400">{WHATS_NEW_TEXT.announcementsFrom}</p>
            </div>
            {state.kind === 'loading' && <p role="status" className="text-slate-400">{WHATS_NEW_TEXT.loading}</p>}
            {state.kind === 'offline' && <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">{WHATS_NEW_TEXT.offline}</p>}
            {state.kind === 'error' && (
              <div className="space-y-2">
                <ErrorNotice message={WHATS_NEW_TEXT.loadFailed} />
                <button type="button" onClick={onRetry} className="btn-base btn-secondary px-3 py-1.5 text-xs">{WHATS_NEW_TEXT.retry}</button>
              </div>
            )}
            {state.kind === 'loaded' && state.stale && <p className="text-amber-300">{WHATS_NEW_TEXT.stale}</p>}
            {state.kind === 'loaded' && state.announcements.length === 0 && <p className="text-slate-400">{WHATS_NEW_TEXT.noAnnouncements}</p>}
            {state.kind === 'loaded' && sortAnnouncements(state.announcements).map((a, i) => {
              const key = noticeKey('announcement', a.id);
              const warning = a.severity === 'warning';
              return (
                <article key={a.id} aria-labelledby={`${uid}-a${i}`} className={`rounded-xl border p-3 space-y-1.5 ${warning ? 'border-amber-500/40 bg-amber-500/10' : 'border-slate-800 bg-slate-900/60'}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold border ${warning ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'}`}>
                      {warning ? <AlertTriangle className="w-3 h-3" aria-hidden="true" /> : <Info className="w-3 h-3" aria-hidden="true" />}
                      {warning ? WHATS_NEW_TEXT.warning : WHATS_NEW_TEXT.info}
                    </span>
                    {!a.read && <span className="text-xs font-semibold text-rose-300">{WHATS_NEW_TEXT.unreadTag}</span>}
                  </div>
                  <h4 id={`${uid}-a${i}`} className="text-sm font-semibold text-white break-words">{a.title}</h4>
                  <p className="text-slate-300 whitespace-pre-line break-words leading-relaxed">{a.body}</p>
                  <p className="text-slate-400">{postedText(a)}</p>
                  <div className="flex justify-end">
                    {a.read ? (
                      <span className="inline-flex items-center gap-1 text-emerald-300"><Check className="w-3.5 h-3.5" aria-hidden="true" />{WHATS_NEW_TEXT.read}</span>
                    ) : (
                      <button type="button" disabled={markBusy === key} onClick={() => onMarkRead('announcement', a.id)} aria-label={`Mark the announcement "${a.title}" as read`} className="btn-base btn-secondary px-3 py-1.5 text-xs">
                        {markBusy === key ? WHATS_NEW_TEXT.marking : WHATS_NEW_TEXT.markRead}
                      </button>
                    )}
                  </div>
                  {markError?.key === key && <ErrorNotice message={markError.message} />}
                </article>
              );
            })}
          </section>

          {/* B. This version, then C. earlier versions */}
          {!notes && !notesFailed && <p role="status" className="text-slate-400">{WHATS_NEW_TEXT.notesLoading}</p>}
          {notesFailed && <ErrorNotice message={WHATS_NEW_TEXT.notesFailed} />}
          {rv && (
            <>
              <section aria-labelledby={`${uid}-rel`} className="space-y-3">
                <div>
                  <h3 id={`${uid}-rel`} className="text-sm font-bold text-white">{`${WHATS_NEW_TEXT.thisVersion}: ${rv.currentVersion}`}</h3>
                  {rv.current && <p className="text-slate-400">{releasedText(rv.current.date)}</p>}
                </div>
                {rv.current && <ReleaseBody release={rv.current} />}
                {rv.missingText && <p className="text-amber-300">{rv.missingText}</p>}
                {rv.read && (
                  <div className="flex justify-end">
                    <span className="inline-flex items-center gap-1 text-emerald-300"><Check className="w-3.5 h-3.5" aria-hidden="true" />{WHATS_NEW_TEXT.read}</span>
                  </div>
                )}
                {rv.canMark && (
                  <div className="flex justify-end">
                    <button type="button" disabled={markBusy === releaseKey} onClick={() => onMarkRead('release', rv.currentVersion)} aria-label={`Mark the notes for version ${rv.currentVersion} as read`} className="btn-base btn-secondary px-3 py-1.5 text-xs">
                      {markBusy === releaseKey ? WHATS_NEW_TEXT.marking : WHATS_NEW_TEXT.markRead}
                    </button>
                  </div>
                )}
                {markError?.key === releaseKey && <ErrorNotice message={markError.message} />}
              </section>
              {rv.earlier.length > 0 && (
                <section aria-labelledby={`${uid}-old`} className="space-y-2">
                  <h3 id={`${uid}-old`} className="text-sm font-bold text-white">{WHATS_NEW_TEXT.earlierHeading}</h3>
                  {rv.earlier.map((r) => (
                    <details key={r.version} className="group rounded-xl border border-slate-800 bg-slate-900/60">
                      <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center justify-between gap-2 px-3 py-2 text-slate-200 font-semibold rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
                        <span>{`Version ${r.version} · ${releasedText(r.date)}`}</span>
                        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
                      </summary>
                      <div className="px-3 pb-3 space-y-2">
                        <ReleaseBody release={r} />
                      </div>
                    </details>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </DialogOverlay>
  );
};
