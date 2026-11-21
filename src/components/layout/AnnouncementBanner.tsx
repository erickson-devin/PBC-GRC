import React from 'react';
import { Megaphone } from 'lucide-react';
import { ErrorNotice } from '../common/ErrorNotice';
import { WHATS_NEW_TEXT, bannerAnnouncement, bannerMoreText, noticeKey } from '../../data/whatsNewView';
import type { WhatsNewState } from '../../data/whatsNewView';

interface AnnouncementBannerProps {
  state: WhatsNewState;
  markBusy: string | null;
  markError: { key: string; message: string } | null;
  onDismiss: (id: string) => void;
  onOpen: () => void;
}

/**
 * The newest unread warning from the platform administrator (issue #260), under the header. Dismissing marks it read on the server,
 * so it does not come back. It never opens the panel by itself. Title and text are plain text nodes.
 */
export const AnnouncementBanner: React.FC<AnnouncementBannerProps> = ({ state, markBusy, markError, onDismiss, onOpen }) => {
  const shown = bannerAnnouncement(state);
  if (!shown) return null;
  const { announcement: a, moreCount } = shown;
  const key = noticeKey('announcement', a.id);
  const busy = markBusy === key;
  return (
    <div role="region" aria-label={WHATS_NEW_TEXT.bannerLabel} className="max-w-7xl mx-auto mt-2 rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wider font-bold text-amber-300">{WHATS_NEW_TEXT.bannerLabel}</p>
            <p className="font-semibold text-amber-100 break-words">{a.title}</p>
            <p className="mt-0.5 text-amber-200/90 whitespace-pre-line break-words line-clamp-3">{a.body}</p>
            {moreCount > 0 && <p className="mt-1 text-amber-300">{bannerMoreText(moreCount)}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={onOpen} className="btn-base btn-secondary px-3 py-1.5 text-xs">{WHATS_NEW_TEXT.bannerOpen}</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDismiss(a.id)}
            aria-label={`Dismiss the announcement "${a.title}" and mark it as read`}
            className="px-3 py-1.5 text-xs font-semibold text-amber-200 hover:text-white rounded-lg hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-50"
          >
            {busy ? WHATS_NEW_TEXT.marking : WHATS_NEW_TEXT.dismiss}
          </button>
        </div>
      </div>
      {markError?.key === key && <ErrorNotice message={markError.message} className="mt-2" />}
    </div>
  );
};
