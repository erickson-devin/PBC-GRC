import React, { useState } from 'react';
import { LibraryBig, ListChecks } from 'lucide-react';
import { useTenant } from '../../context/TenantContext';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { DocumentRegisterPanel } from './DocumentRegisterPanel';
import { ExpectedDocumentsPanel } from './ExpectedDocumentsPanel';

const segment = (pressed: boolean): string =>
  `px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
    pressed ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200' : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
  }`;

/**
 * The Document Register tab (#240, #250): the organization's register and the open program's expected-documents checklist. The register is
 * organization-wide, so this tab is not program-scoped; the checklist says so itself when no program is open.
 */
export const DocumentsPage: React.FC = () => {
  const { activeProgram } = useTenant();
  const [view, setView] = useState<'register' | 'expected'>('register');
  return (
    <div className="space-y-4">
      <div role="group" aria-label="Document view" className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={view === 'register'} onClick={() => setView('register')} className={segment(view === 'register')}>
          <LibraryBig className="w-3.5 h-3.5 inline mr-1" aria-hidden="true" />
          Register
        </button>
        <button type="button" aria-pressed={view === 'expected'} onClick={() => setView('expected')} className={segment(view === 'expected')}>
          <ListChecks className="w-3.5 h-3.5 inline mr-1" aria-hidden="true" />
          Expected documents
        </button>
      </div>
      <ErrorBoundary name="Document Register" variant="panel" resetKeys={[activeProgram?.id, view]}>
        {view === 'register' ? <DocumentRegisterPanel /> : <ExpectedDocumentsPanel />}
      </ErrorBoundary>
    </div>
  );
};

export default DocumentsPage;
