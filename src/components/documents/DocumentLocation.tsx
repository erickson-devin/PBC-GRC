import React, { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { classifyLocation, safeLinkHref } from '../../data/documents/documentSchema';
import { DOCUMENT_UI_TEXT, LOCATION_KIND_LABELS } from '../../data/documents/documentUiView';
import { COPY_FAILED_MESSAGE, copyText } from '../../utils/clipboard';

interface DocumentLocationProps {
  value: string;
  /** In a table cell: one truncated line, without the explanation. */
  compact?: boolean;
}

/**
 * Where a document's controlled copy lives. An http or https address is a link that opens in a new tab only when clicked (no referrer; this app never
 * requests the address itself); a file share, drive path or file:// address is plain text with a Copy button, because a browser cannot open it.
 * The link target only ever comes from safeLinkHref.
 */
export const DocumentLocation: React.FC<DocumentLocationProps> = ({ value, compact }) => {
  const href = safeLinkHref(value);
  const c = classifyLocation(value);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = (): void => {
    void copyText(value).then((ok) => setCopyState(ok ? 'copied' : 'failed'));
  };
  const clip = compact ? 'max-w-[16rem] truncate' : '';
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 min-w-0">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          title={compact ? value : undefined}
          className={`inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 underline break-all focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded ${clip}`}
        >
          {value}
          <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <code title={compact ? value : undefined} className={`font-mono text-[11px] text-slate-200 bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 break-all ${clip}`}>
          {value}
        </code>
      )}
      <button
        type="button"
        onClick={copy}
        aria-label="Copy the location"
        title="Copy the location"
        className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
      >
        {copyState === 'copied' ? <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
      </button>
      <span role="status" className={copyState === 'failed' ? 'text-[11px] text-amber-300' : 'sr-only'}>
        {copyState === 'failed' ? COPY_FAILED_MESSAGE : copyState === 'copied' ? 'Location copied.' : ''}
      </span>
      {!compact && c.ok && (
        <span className="w-full text-[11px] text-slate-400">
          {LOCATION_KIND_LABELS[c.kind]}
          {c.kind !== 'http' ? `. ${DOCUMENT_UI_TEXT.locationShareNote}` : ''}
        </span>
      )}
    </span>
  );
};

export default DocumentLocation;
