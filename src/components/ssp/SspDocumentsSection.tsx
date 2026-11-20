import React from 'react';
import { LibraryBig } from 'lucide-react';
import type { SspSectionStatus } from '../../data/ssp/sspCompleteness';
import { FILE_REMOVED, SSP_DOCUMENT_HEADERS, draftNote, sspDocumentTableRows, type SspDocumentsSnapshot } from '../../data/documents/sspDocuments';
import { NOT_RECORDED } from '../../data/reports/documentDefaults';
import { ErrorNotice } from '../common/ErrorNotice';

interface SspDocumentsSectionProps {
  status: 'unsupported' | 'loading' | 'ready' | 'error';
  snapshot: SspDocumentsSnapshot;
  section?: SspSectionStatus;
  onOpenRegister: () => void;
  onRetry: () => void;
}

const BUTTON = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5';

export const SSP_DOCUMENTS_TEXT = {
  intro: 'Approved governance documents for this program, from the Document Register. Drafts are not listed until a person approves them.',
  unsupported: 'Not available: the document register needs a server-backed organization.',
  loading: 'Loading the documents…',
  failed: 'The documents could not be loaded.',
  empty: 'No approved documents in this program yet.',
} as const;

// A value that was never recorded is amber with a screen-reader hint; a removed file is amber too
const Cell: React.FC<{ value: string }> = ({ value }) =>
  value === NOT_RECORDED ? (
    <span className="text-amber-300">
      {value}
      <span className="sr-only"> (not recorded)</span>
    </span>
  ) : value === FILE_REMOVED ? (
    <span className="text-amber-300">{value}</span>
  ) : (
    <>{value}</>
  );

/** 1.3.2 Governance documents: read-only, built from the Document Register (approved documents of the program only). Not signed off. */
export const SspDocumentsSection: React.FC<SspDocumentsSectionProps> = ({ status, snapshot, section, onOpenRegister, onRetry }) => {
  const rows = status === 'ready' ? snapshot.rows : [];
  const cells = status === 'ready' ? sspDocumentTableRows(snapshot) : [];
  const draft = draftNote(snapshot.draftCount);
  const advisory = (section?.items ?? []).filter((i) => i.missing).map((i) => i.label);

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-400">{SSP_DOCUMENTS_TEXT.intro}</p>
      {status === 'ready' && advisory.length > 0 && <p className="text-xs text-slate-400">Optional and not recorded: {advisory.join(', ')}</p>}

      {status === 'unsupported' && (
        <p role="note" className="p-3 rounded-xl bg-slate-800/60 border border-slate-700 text-xs text-slate-300">{SSP_DOCUMENTS_TEXT.unsupported}</p>
      )}
      {status === 'loading' && <p role="status" className="text-xs text-slate-400">{SSP_DOCUMENTS_TEXT.loading}</p>}
      {status === 'error' && (
        <div className="space-y-2">
          <ErrorNotice message={SSP_DOCUMENTS_TEXT.failed} />
          <button type="button" onClick={onRetry} className={BUTTON}>Try again</button>
        </div>
      )}

      {status === 'ready' && rows.length === 0 && <p className="text-xs text-slate-400">{SSP_DOCUMENTS_TEXT.empty}</p>}
      {status === 'ready' && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
          <table className="w-full text-left text-xs border-collapse min-w-[48rem]">
            <caption className="sr-only">1.3.2 Governance documents</caption>
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 text-slate-400 font-semibold">
                {SSP_DOCUMENT_HEADERS.map((h) => (
                  <th key={h} scope="col" className="py-2.5 px-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {rows.map((r, i) => (
                <tr key={r.id}>
                  <td className="py-2 px-3 font-semibold text-white">{cells[i][0]}</td>
                  <td className="py-2 px-3 text-slate-300">{cells[i][1]}</td>
                  <td className="py-2 px-3 text-slate-300"><Cell value={cells[i][2]} /></td>
                  <td className="py-2 px-3 text-slate-300"><Cell value={cells[i][3]} /></td>
                  <td className="py-2 px-3 text-slate-300"><Cell value={cells[i][4]} /></td>
                  <td className="py-2 px-3 text-slate-300">
                    <Cell value={cells[i][5]} />
                    {r.reviewState === 'OVERDUE' && (
                      <span className="ml-1.5 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-rose-500/15 border-rose-500/30 text-rose-300">Review overdue</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-slate-300"><Cell value={cells[i][6]} /></td>
                  <td className="py-2 px-3 text-slate-300 break-all"><Cell value={cells[i][7]} /></td>
                  <td className="py-2 px-3 text-slate-300">{cells[i][8]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status === 'ready' && draft !== '' && <p className="text-xs text-slate-400">{draft}</p>}
      {status === 'ready' && snapshot.overdueCount > 0 && (
        <p className="text-xs text-rose-300">
          {snapshot.overdueCount} listed {snapshot.overdueCount === 1 ? 'document is' : 'documents are'} past the review date.
        </p>
      )}
      {status === 'ready' && snapshot.expected && (
        <p className="text-xs text-slate-400">Expected documents present: {snapshot.expected.present} of {snapshot.expected.total}.</p>
      )}

      {status !== 'unsupported' && (
        <button type="button" onClick={onOpenRegister} className={BUTTON}>
          <LibraryBig className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Open Document Register</span>
        </button>
      )}
    </div>
  );
};
