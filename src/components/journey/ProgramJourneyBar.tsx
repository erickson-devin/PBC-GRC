import React, { useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, CircleDot, CloudOff, Loader2, MinusCircle } from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { useProgramJourney } from '../../hooks/useProgramJourney';
import { useProgramSummary } from '../../hooks/useProgramSummary';
import { getFrameworkTitle } from '../../data/frameworks';
import type { JourneyStepId } from '../../data/journey/programJourney';
import {
  journeyDisplay,
  journeyHeadlineText,
  showJourneyBar,
  type DisplayState,
  type JourneyStepDisplay,
  type SummaryStatus,
} from '../../data/journey/journeyBarView';

const ICON = 'w-3.5 h-3.5 shrink-0';

const StateIcon: React.FC<{ state: DisplayState }> = ({ state }) => {
  switch (state) {
    case 'complete': return <CheckCircle2 className={`${ICON} text-emerald-400`} aria-hidden="true" />;
    case 'in_progress': return <CircleDot className={`${ICON} text-amber-400`} aria-hidden="true" />;
    case 'not_started': return <Circle className={`${ICON} text-slate-400`} aria-hidden="true" />;
    case 'not_applicable': return <MinusCircle className={`${ICON} text-slate-500`} aria-hidden="true" />;
    case 'unavailable': return <CloudOff className={`${ICON} text-slate-500`} aria-hidden="true" />;
    case 'loading': return <Loader2 className={`${ICON} text-slate-400 animate-spin motion-reduce:animate-none`} aria-hidden="true" />;
    default: return <AlertTriangle className={`${ICON} text-rose-400`} aria-hidden="true" />;
  }
};

const FIGURE_TONE: Record<DisplayState, string> = {
  complete: 'text-emerald-300',
  in_progress: 'text-amber-300',
  not_started: 'text-slate-400',
  not_applicable: 'text-slate-400',
  unavailable: 'text-slate-400',
  loading: 'text-slate-400',
  error: 'text-rose-300',
};

export interface JourneyBarViewProps {
  display: JourneyStepDisplay[];
  progressText: string;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (id: JourneyStepId) => void;
  summaryError: boolean;
  onRetry: () => void;
}

/** The bar itself, props only. The state is words and an icon as well as colour, and every step is a button that opens its screen. */
export const JourneyBarView: React.FC<JourneyBarViewProps> = ({ display, progressText, expanded, onToggle, onSelect, summaryError, onRetry }) => {
  const uid = useId();
  const listId = `${uid}-steps`;
  return (
    <nav aria-label="Program journey" className="no-print mb-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Program journey <span className="normal-case font-medium text-slate-300">· {progressText}</span>
        </h2>
        <div className="flex items-center gap-2">
          {summaryError && (
            <button type="button" onClick={onRetry} className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
              Try again
            </button>
          )}
          <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={listId} className="px-2 py-1 rounded-lg text-xs font-semibold text-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500">
            {expanded ? 'Hide steps' : 'Show steps'}
          </button>
        </div>
      </div>
      <ol id={listId} className={`${expanded ? 'grid' : 'hidden'} mt-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2`}>
        {display.map((d, i) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => onSelect(d.id)}
              aria-current={d.current ? 'step' : undefined}
              aria-label={d.aria}
              aria-describedby={`${uid}-${d.id}-checks`}
              className={`w-full h-full text-left rounded-xl border px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${d.current ? 'border-brand-500/50 bg-brand-600/15' : 'border-slate-800 bg-slate-950/50 hover:border-slate-600 hover:bg-slate-900'}`}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-white">
                <StateIcon state={d.state} />
                <span className="font-mono text-slate-500">{i + 1}</span>
                <span className="truncate">{d.label}</span>
                {d.optional && <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded border border-slate-700 text-slate-400">Optional</span>}
              </span>
              <span className={`mt-1 block text-xs font-mono ${FIGURE_TONE[d.state]}`}>{d.figure}</span>
              {d.sub && <span className="hidden sm:block text-[11px] text-slate-400">{d.sub}</span>}
            </button>
            <span id={`${uid}-${d.id}-checks`} className="sr-only">{d.checksText}</span>
          </li>
        ))}
      </ol>
      <p role="status" aria-live="polite" className="sr-only">{summaryError ? 'Some journey figures could not be loaded.' : ''}</p>
    </nav>
  );
};

const JourneyBarContainer: React.FC<{ expanded: boolean; onToggle: () => void }> = ({ expanded, onToggle }) => {
  const { activeTab, setActiveTab, openSspSection, openExportModal, notesStatus } = useAssessment();
  const { currentTenant, activeFramework } = useTenant();
  const steps = useProgramJourney();
  const summary = useProgramSummary();

  const serverBacked = Boolean(currentTenant.serverBacked);
  const summaryStatus: SummaryStatus = summary.status === 'loading' ? 'loading' : summary.status === 'error' ? 'error' : 'ready';
  const display = journeyDisplay(steps, { activeTab, serverBacked, summaryStatus, notesStatus, frameworkTitle: getFrameworkTitle(activeFramework) });

  const onSelect = (id: JourneyStepId) => {
    switch (id) {
      case 'people': setActiveTab('rbac'); break;
      case 'tools': setActiveTab('tools'); break;
      case 'documents': setActiveTab('documents'); break;
      case 'assess': setActiveTab('matrix'); break;
      case 'ssp': openSspSection(steps.find((s) => s.id === 'ssp')?.target.sspSection ?? 'identification'); break;
      default: openExportModal(); break;
    }
  };

  return (
    <JourneyBarView
      display={display}
      progressText={journeyHeadlineText(display)}
      expanded={expanded}
      onToggle={onToggle}
      onSelect={onSelect}
      summaryError={serverBacked && summaryStatus === 'error'}
      onRetry={() => void summary.reload()}
    />
  );
};

/**
 * The program's journey (#251): above the screen of every program tab. Collapsing is React state only, so it is not remembered across reloads. The
 * journey and its summary are read only while the bar shows, so a tab that has none (the audit log, the account pages) asks the server for nothing.
 */
export const ProgramJourneyBar: React.FC = () => {
  const { activeTab } = useAssessment();
  const [expanded, setExpanded] = useState(true);
  if (!showJourneyBar(activeTab)) return null;
  return <JourneyBarContainer expanded={expanded} onToggle={() => setExpanded((v) => !v)} />;
};

export default ProgramJourneyBar;
