import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  FileText,
  Printer,
  Download,
  Copy,
  Check,
  Eye,
  Edit3,
  Lock,
} from 'lucide-react';
import { useAssessment } from '../../context/AssessmentContext';
import { useTenant } from '../../context/TenantContext';
import { useSspProfile } from '../../hooks/useSspProfile';
import { useSspReviews } from '../../hooks/useSspReviews';
import { getFrameworkTitle, getFrameworkGuidanceText } from '../../data/frameworks';

import { copyText, COPY_FAILED_MESSAGE } from '../../utils/clipboard';
import { NOT_RECORDED, NO_CSP_RECORDED } from '../../data/reports/documentDefaults';
import { cmmcDisplayId } from '../../data/cmmcGuide/displayId';
import { composeImplementationStatement } from '../../data/cmmcGuide/sspStatement';
import { statusDisplayLabel } from '../../data/statusLabels';
import { SSP_METADATA_NEED_OWNER_MESSAGE } from '../../data/sspMetadataSync';
import { computeSspCompleteness, resolveSspCompletenessInput } from '../../data/ssp/sspCompleteness';
import { SSP_SECTIONS, type SspSectionId } from '../../data/ssp/sspSections';
import {
  SSP_BUILDER_TEXT,
  builderSaveState,
  completenessSummary,
  maintenanceControlLinks,
  navEntriesView,
  profileSaveErrorText,
  reviewErrorText,
  signOffDisabledReason,
} from '../../data/ssp/sspBuilderView';
import {
  SSP_ROLE_TABLE_HEADERS,
  sspIdentificationItems,
  sspMaintenanceExceptions,
  sspMaintenanceItems,
  sspRoleLines,
  sspRoleRows,
} from '../../data/ssp/sspOutput';
import { ErrorNotice } from '../common/ErrorNotice';
import { SspSectionNav } from './SspSectionNav';
import { SspSectionReview } from './SspSectionReview';
import { SspIdentificationSection } from './SspIdentificationSection';
import { SspRolesSection } from './SspRolesSection';
import { SspEnvironmentSection } from './SspEnvironmentSection';
import { SspMaintenanceSection } from './SspMaintenanceSection';

export const SSPBuilder: React.FC = () => {
  const {
    state,
    metrics,
    frameworkControls,
    updateSSPMetadata,
    sspMetadataEditable,
    sspMetadataStatus,
    sspMetadataConflict,
    resolveSspMetadataConflict,
    sspMetadataNeedsOwner,
    exportAssessmentMarkdown,
    sspFocusSection,
    clearSspFocusSection,
    setSelectedControlId,
  } = useAssessment();

  const { currentTenant, canEdit, activeFramework, activeProgram, teamMembers, teamError } = useTenant();
  const profileHook = useSspProfile();
  const reviews = useSspReviews();
  const profile = profileHook.profile;

  // Another screen (the export modal's gap list) can ask for a section: then the builder opens on the edit view
  const [viewMode, setViewMode] = useState<'document' | 'form'>(() => (sspFocusSection ? 'form' : 'document'));
  const [activeSection, setActiveSection] = useState<SspSectionId>('identification');
  const [focusPending, setFocusPending] = useState(false);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const sectionHeadingId = useId();
  const [copied, setCopied] = useState<boolean>(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState<boolean>(false);
  const [conflictFailed, setConflictFailed] = useState<boolean>(false);
  const [profileNonce, setProfileNonce] = useState(0);
  const [signing, setSigning] = useState(false);
  const [reviewMsg, setReviewMsg] = useState<{ section: SspSectionId; error: string | null; notice: string | null } | null>(null);

  useEffect(() => {
    if (!sspFocusSection) return;
    setViewMode('form');
    setActiveSection(sspFocusSection);
    setFocusPending(true);
    clearSspFocusSection();
  }, [sspFocusSection, clearSspFocusSection]);

  useEffect(() => {
    if (!focusPending || viewMode !== 'form') return;
    sectionHeadingRef.current?.focus();
    setFocusPending(false);
  }, [focusPending, viewMode, activeSection]);

  useEffect(() => {
    setReviewMsg(null);
  }, [activeSection, activeProgram?.id]);

  const resolveConflict = async (choice: 'browser' | 'server') => {
    setResolvingConflict(true);
    setConflictFailed(false);
    try {
      await resolveSspMetadataConflict(choice);
    } catch {
      // A fixed notice only: the server's answer may name the text
      setConflictFailed(true);
    } finally {
      setResolvingConflict(false);
    }
  };

  const meta = state.sspMetadata;
  // The active program's boundary summary describes the system when the plan's own boundary text is empty
  const boundaryScope = meta.systemBoundaryScope || activeProgram?.boundarySummary || '';
  const frameworkTitle = getFrameworkTitle(activeFramework);
  const guidance = getFrameworkGuidanceText(activeFramework);
  const totalControls = frameworkControls.length || metrics.totalControls || 1;

  const archived = Boolean(activeProgram?.archived);
  const profileEditable = canEdit && profileHook.status === 'ready' && !archived;
  const serverBacked = Boolean(currentTenant.serverBacked);
  const completeness = useMemo(
    () => computeSspCompleteness(resolveSspCompletenessInput({ meta, tenant: currentTenant, program: activeProgram, framework: activeFramework, profile })),
    [meta, currentTenant, activeProgram, activeFramework, profile]
  );
  const entries = navEntriesView(completeness, reviews);
  const sectionStatus = completeness.sections.find((s) => s.sectionId === activeSection);
  const savePending = sspMetadataStatus === 'saving' || profileHook.saving;
  const members = teamMembers[currentTenant.id] ?? [];
  const teamLoaded = serverBacked && teamMembers[currentTenant.id] !== undefined;
  const maControls = useMemo(
    () => maintenanceControlLinks(frameworkControls, (id) => cmmcDisplayId(id, activeFramework)),
    [frameworkControls, activeFramework]
  );
  const def = SSP_SECTIONS.find((s) => s.id === activeSection) ?? SSP_SECTIONS[0];
  const sectionKey = `${activeProgram?.id ?? currentTenant.id}-${profileNonce}`;
  const saveState = builderSaveState({
    serverBacked,
    metadataStatus: sspMetadataStatus,
    needsOwner: sspMetadataNeedsOwner,
    conflict: Boolean(sspMetadataConflict),
    profileStatus: profileHook.status,
    profileSaving: profileHook.saving,
  });

  const selectSection = (id: SspSectionId) => {
    setActiveSection(id);
    setFocusPending(true);
  };

  const reloadProfile = () => {
    void profileHook.reload();
    setProfileNonce((n) => n + 1);
  };

  const handleSignOff = async () => {
    const id = activeSection;
    setSigning(true);
    setReviewMsg(null);
    try {
      const r = await reviews.signOff(id);
      setReviewMsg({ section: id, error: null, notice: r.changed ? SSP_BUILDER_TEXT.marked : SSP_BUILDER_TEXT.alreadyMarked });
    } catch (err) {
      setReviewMsg({ section: id, error: reviewErrorText(err), notice: null });
      void reviews.reload();
    } finally {
      setSigning(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  // The identifier, categorization, roles and maintenance answers are worded by the shared output module, as in the compiled SSP and the Markdown
  const identification = sspIdentificationItems(profile);
  const roleRows = sspRoleRows({ profile, legacySystemOwner: meta.systemOwner, framework: activeFramework });
  const maintenanceItems = sspMaintenanceItems(profile);

  const handleCopyText = () => {
    let text = `SYSTEM SECURITY PLAN (SSP) - ${frameworkTitle.toUpperCase()} / ${guidance.authority.toUpperCase()}\n\n`;
    text += `ORGANIZATION: ${meta.organizationName}\n`;
    text += `CAGE CODE: ${meta.cageCode}\n`;
    text += `SAM.GOV STATUS: ${meta.samStatus || NOT_RECORDED}\n`;
    if (activeProgram) text += `PROGRAM: ${activeProgram.name}\n`;
    text += `SYSTEM NAME: ${meta.systemName}\n`;
    for (const item of identification) text += `${item.label.toUpperCase()}: ${item.value}\n`;
    text += `SYSTEM OWNER: ${meta.systemOwner}\n`;
    text += `ASSESSMENT DATE: ${meta.assessmentDate}\n`;
    text += `EVIDENCE VAULT (LOCAL): tenants/${currentTenant.id}/\n\n`;
    text += `SYSTEM BOUNDARY & SCOPE:\n${boundaryScope}\n\n`;
    text += `RESPONSIBLE ROLES:\n`;
    for (const line of sspRoleLines({ profile, legacySystemOwner: meta.systemOwner, framework: activeFramework })) text += `- ${line.label}: ${line.value}\n`;
    text += `\nCLOUD SERVICE PROVIDERS: ${meta.cloudServiceProviders || NO_CSP_RECORDED}\n\n`;
    text += `HARDWARE AND SOFTWARE MAINTENANCE AND OWNERSHIP:\n`;
    for (const item of maintenanceItems) text += `- ${item.label}: ${item.value}\n`;
    text += `EXCEPTIONS: ${sspMaintenanceExceptions(profile)}\n\n`;
    text += `${totalControls} CONTROLS ASSESSMENT MATRIX:\n`;

    for (const ctrl of frameworkControls) {
      const cState = state.controls[ctrl.id];
      const evidence = state.evidenceIndex.filter(e => e.controlId === ctrl.id);
      const authority = ctrl.authorityReference || cmmcDisplayId(ctrl.id, activeFramework);
      text += `\n[${cmmcDisplayId(ctrl.id, activeFramework)}] ${ctrl.title} (${authority})\n`;
      text += `Status: ${statusDisplayLabel(cState?.status)}\n`;
      const statement = composeImplementationStatement(ctrl.id, cState?.implementationNotes, state.objectives, activeFramework).text;
      text += `Implementation Statement:\n${statement.trim() !== '' ? statement : 'No implementation notes provided.'}\n`;
      if (evidence.length > 0) {
        text += `Evidence Artifacts: ${evidence.map(e => `${e.name} (SHA-256: ${e.fileHash || 'N/A'})`).join(', ')}\n`;
      }
    }

    void copyText(text).then((ok) => {
      setCopyFailed(!ok);
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Top Action Toolbar (Hidden during print) */}
      <div className="no-print bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-xl">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-xl bg-brand-500/20 text-brand-300">
              <FileText className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold text-white tracking-tight">
                  System Security Plan (SSP) Generator
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-slate-800 text-brand-300 border border-slate-700">
                  {currentTenant.name}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                {guidance.standardRef} compliance documentation automatically compiled for all {totalControls} controls.
              </p>
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 flex-wrap w-full md:w-auto justify-end">
          {/* Mode Switcher */}
          <div className="bg-slate-950 p-1 rounded-xl border border-slate-800 flex items-center gap-1">
            <button
              type="button"
              aria-pressed={viewMode === 'document'}
              onClick={() => setViewMode('document')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                viewMode === 'document'
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Audit Document</span>
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'form'}
              onClick={() => setViewMode('form')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                viewMode === 'form'
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Edit Sections</span>
            </button>
          </div>

          <button
            onClick={handleCopyText}
            className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-slate-400" />}
            <span>{copied ? 'Copied to Clipboard' : 'Copy Plaintext'}</span>
          </button>
          <span role="status" aria-live="polite" className={copyFailed ? 'text-xs text-amber-300' : 'sr-only'}>{copyFailed ? COPY_FAILED_MESSAGE : ''}</span>

          <button
            onClick={() => exportAssessmentMarkdown(profileHook.profile)}
            className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
          >
            <Download className="w-3.5 h-3.5 text-slate-400" />
            <span>Download MD</span>
          </button>

          <button
            onClick={handlePrint}
            className="px-3.5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-lg shadow-brand-500/20"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print Official SSP</span>
          </button>
        </div>
      </div>

      {/* VIEW 1: SECTION EDITOR */}
      {viewMode === 'form' && (
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6 shadow-xl">
          <div className="border-b border-slate-800 pb-4">
            <h3 className="text-lg font-bold text-white tracking-tight">
              Edit SSP Sections
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Each section lists what is still missing. Red counts are required items; a green check means the section is complete.
            </p>
          </div>

          {!canEdit && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center gap-2">
              <Lock className="w-4 h-4" />
              <span>{SSP_BUILDER_TEXT.readOnly}</span>
            </div>
          )}

          {/* Where these details are saved. Fixed text only: the values may be CUI. */}
          <p className="text-xs text-slate-400" role="status" aria-live="polite">
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'saved'
                ? 'Saved to the server'
                : saveState === 'loading'
                  ? 'Loading the server copy…'
                  : saveState === 'browser'
                    ? SSP_BUILDER_TEXT.browserOnly
                    : 'These details are saved to the server, separately for each program.'}
          </p>

          {sspMetadataNeedsOwner && (
            <div role="alert" className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center gap-2">
              <Lock className="w-4 h-4 shrink-0" />
              <span>{SSP_METADATA_NEED_OWNER_MESSAGE}</span>
            </div>
          )}

          {sspMetadataConflict && (
            <div role="alert" className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 space-y-3">
              <p>
                This browser and the server hold different text for: {sspMetadataConflict.fields.join(', ')}. Nothing has been changed yet. Choose which
                copy to keep.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!canEdit || resolvingConflict}
                  onClick={() => void resolveConflict('server')}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 font-semibold disabled:opacity-60"
                >
                  Keep the server&apos;s
                </button>
                <button
                  type="button"
                  disabled={!canEdit || resolvingConflict}
                  onClick={() => void resolveConflict('browser')}
                  className="px-3.5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold disabled:opacity-60"
                >
                  Use this browser&apos;s
                </button>
              </div>
              {!canEdit && <p>Only a Tenant Owner or Admin can choose.</p>}
              {conflictFailed && <p>The choice could not be saved to the server. Try again.</p>}
            </div>
          )}

          {serverBacked && profileHook.status === 'error' && (
            <div className="space-y-2">
              <ErrorNotice message={SSP_BUILDER_TEXT.profileLoadFailed} />
              <button
                type="button"
                onClick={() => void profileHook.reload()}
                className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold"
              >
                Try again
              </button>
            </div>
          )}

          {serverBacked && profileHook.status === 'stale' && (
            <div role="alert" className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 space-y-3">
              <p>{SSP_BUILDER_TEXT.profileStale}</p>
              <button
                type="button"
                onClick={reloadProfile}
                className="px-3.5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold"
              >
                Reload the server copy
              </button>
            </div>
          )}

          {serverBacked && profileHook.status !== 'stale' && profileHook.saveError && (
            <div className="space-y-2">
              <ErrorNotice message={profileSaveErrorText(profileHook.saveError)} />
              {profileHook.saveError === 'failed' && (
                <button
                  type="button"
                  onClick={() => void profileHook.save(profileHook.profile ?? {})}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold"
                >
                  Try again
                </button>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)] gap-6 items-start">
            <SspSectionNav entries={entries} activeId={activeSection} onSelect={selectSection} summary={completenessSummary(completeness)} />
            <section aria-labelledby={sectionHeadingId} className="min-w-0 space-y-5">
              <h3
                id={sectionHeadingId}
                ref={sectionHeadingRef}
                tabIndex={-1}
                className="text-base font-bold text-white tracking-tight focus:outline-none"
              >
                <span className="font-mono text-slate-400 mr-2">{def.number}</span>
                {def.title}
              </h3>

              {activeSection === 'identification' && (
                <SspIdentificationSection
                  key={sectionKey}
                  meta={meta}
                  canEdit={canEdit}
                  sspMetadataEditable={sspMetadataEditable}
                  updateSSPMetadata={updateSSPMetadata}
                  profile={profile}
                  profileEditable={profileEditable}
                  onProfileChange={(p) => void profileHook.save(p)}
                  section={sectionStatus}
                  framework={activeFramework}
                  baseline={activeProgram?.baseline ?? null}
                />
              )}
              {activeSection === 'roles' && (
                <SspRolesSection
                  key={sectionKey}
                  profile={profile}
                  legacySystemOwner={meta.systemOwner}
                  section={sectionStatus}
                  canEdit={canEdit}
                  profileEditable={profileEditable}
                  onProfileChange={(p) => void profileHook.save(p)}
                  members={members}
                  teamLoaded={teamLoaded}
                  teamError={teamError}
                  serverBacked={serverBacked}
                  framework={activeFramework}
                />
              )}
              {activeSection === 'environment' && (
                <SspEnvironmentSection
                  key={sectionKey}
                  meta={meta}
                  canEdit={canEdit}
                  sspMetadataEditable={sspMetadataEditable}
                  updateSSPMetadata={updateSSPMetadata}
                  section={sectionStatus}
                  boundaryFallback={activeProgram?.boundarySummary ?? ''}
                />
              )}
              {activeSection === 'maintenance' && (
                <SspMaintenanceSection
                  key={sectionKey}
                  profile={profile}
                  canEdit={canEdit}
                  profileEditable={profileEditable}
                  onProfileChange={(p) => void profileHook.save(p)}
                  section={sectionStatus}
                  maControls={maControls}
                  onOpenControl={setSelectedControlId}
                />
              )}

              <SspSectionReview
                sectionId={activeSection}
                supported={reviews.supported}
                status={reviews.status}
                state={reviews.sections[activeSection] ?? null}
                history={reviews.history}
                canEdit={canEdit}
                disabledReason={signOffDisabledReason({
                  savePending,
                  reviewsStatus: reviews.status,
                  profileStatus: profileHook.status,
                  metadataEditable: sspMetadataEditable,
                  canSignOff: reviews.canSignOff,
                  signing,
                })}
                signing={signing}
                error={reviewMsg?.section === activeSection ? reviewMsg.error : null}
                notice={reviewMsg?.section === activeSection ? reviewMsg.notice : null}
                onSignOff={() => void handleSignOff()}
                onRetry={() => void reviews.reload()}
              />
            </section>
          </div>

          <div className="pt-4 border-t border-slate-800 flex justify-end">
            <button
              type="button"
              onClick={() => setViewMode('document')}
              className="px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-xs transition-colors"
            >
              View Formatted SSP Document
            </button>
          </div>
        </div>
      )}

      {/* VIEW 2: FORMAL PRINTABLE AUDIT DOCUMENT */}
      {viewMode === 'document' && (
        <div className="ssp-print-document bg-white text-slate-900 rounded-3xl p-6 sm:p-12 shadow-2xl border border-slate-200 font-sans space-y-8 max-w-5xl mx-auto">

          {/* Document Header & Cover Banner */}
          <div className="border-b-2 border-slate-900 pb-6 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-500 font-mono">
              <span>SECURITY CLASSIFICATION: UNCLASSIFIED // COMPLIANCE CONTROL SET</span>
              <span>VERSION {meta.version}</span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-950 tracking-tight">
              SYSTEM SECURITY PLAN (SSP)
            </h1>
            <p className="text-sm font-semibold text-slate-700">
              {guidance.scopeDescription}
            </p>
            <div className="flex items-center gap-2 pt-1 flex-wrap">
              <span className="text-xs font-bold px-2 py-0.5 bg-slate-100 text-slate-800 rounded border border-slate-300">
                {guidance.authority}
              </span>
              <span className="text-xs font-bold px-2 py-0.5 bg-brand-50 text-brand-800 rounded border border-brand-200">
                {frameworkTitle} ({totalControls} Controls)
              </span>
              <span className="text-xs font-bold px-2 py-0.5 bg-emerald-50 text-emerald-800 rounded border border-emerald-200">
                {guidance.standardRef} Baseline
              </span>
            </div>
          </div>

          {/* Section 1: System Identification & Governance (1.1 identification and categorization, 1.2 roles) */}
          <div className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border-l-4 border-brand-600">
              1. System Identification & Governance
            </h2>

            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">1.1 System Identification & Categorization</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block font-medium">Organization Name</span>
                <span className="text-slate-900 font-bold text-sm">{meta.organizationName}</span>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block font-medium">CAGE Code</span>
                <span className="text-slate-900 font-mono font-bold text-sm">{meta.cageCode || NOT_RECORDED}</span>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block font-medium">Information System Name</span>
                <span className="text-slate-900 font-bold">{meta.systemName}</span>
                {activeProgram && <span className="text-slate-500 block text-xs mt-0.5">Program: {activeProgram.name}</span>}
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block font-medium">{identification[0].label}</span>
                <span className="text-slate-900 font-mono font-bold text-sm">{identification[0].value}</span>
              </div>

              <div className="sm:col-span-2 p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 block font-medium">Security Categorization (Confidentiality / Integrity / Availability)</span>
                <span className="text-slate-900 font-bold">{identification[1].value} / {identification[2].value} / {identification[3].value}</span>
                <span className="text-slate-500 block text-xs mt-0.5">Overall: {identification[4].value}</span>
              </div>
            </div>

            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 pt-2">1.2 Responsible Organization & Roles</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs border border-slate-200">
                <thead>
                  <tr className="bg-slate-50 text-left">
                    {SSP_ROLE_TABLE_HEADERS.map((h) => (
                      <th key={h} scope="col" className="px-3 py-2 border-b border-slate-200 font-semibold text-slate-700">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {roleRows.map((r, i) => (
                    <tr key={`${r.role}-${i}`} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2 text-slate-700">{r.role}</td>
                      <td className="px-3 py-2 text-slate-900 font-semibold">{r.name}</td>
                      <td className="px-3 py-2 text-slate-700 break-all">{r.email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 2: System Environment (2.1 boundary and environment, 2.2 cloud service providers, 2.3 maintenance and ownership) */}
          <div className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border-l-4 border-brand-600">
              2. System Environment
            </h2>

            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">2.1 System Boundary & Environment</h3>
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-800 leading-relaxed whitespace-pre-wrap">
              {boundaryScope || 'No boundary scope defined.'}
            </div>
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs">
              <span className="text-slate-500 block font-medium">System Architecture & Hosting Environment</span>
              <span className="text-slate-900">{meta.systemEnvironment}</span>
            </div>

            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 pt-2">2.2 Cloud Service Providers</h3>
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-800">
              {meta.cloudServiceProviders || NO_CSP_RECORDED}
            </div>

            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 pt-2">2.3 Hardware and Software Maintenance and Ownership</h3>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              {maintenanceItems.map((item) => (
                <div key={item.label} className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                  <dt className="text-slate-500 font-medium">{item.label}</dt>
                  <dd className="text-slate-900 font-semibold">{item.value}</dd>
                </div>
              ))}
            </dl>
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-800 leading-relaxed whitespace-pre-wrap">
              {sspMaintenanceExceptions(profile)}
            </div>
          </div>

          {/* Section 3: Executive Compliance Summary */}
          <div className="space-y-3 print-avoid-break">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border-l-4 border-brand-600">
              3. Executive Compliance Scorecard
            </h2>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
                <span className="text-2xl font-extrabold text-slate-900 font-mono">{metrics.metCount}/{totalControls}</span>
                <p className="text-[11px] font-semibold text-slate-600 mt-0.5">Practices Met</p>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
                <span className="text-2xl font-extrabold text-slate-900 font-mono">{metrics.completionPercentage}%</span>
                <p className="text-[11px] font-semibold text-slate-600 mt-0.5">Overall Readiness</p>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
                <span className="text-2xl font-extrabold text-slate-900 font-mono">{guidance.poamPermitted ? (totalControls - metrics.metCount) : 0}</span>
                <p className="text-[11px] font-semibold text-slate-600 mt-0.5">{guidance.poamPermitted ? 'Open Deficiencies' : 'Allowed POA&Ms'}</p>
              </div>
              <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
                <span className="text-2xl font-extrabold text-slate-900 font-mono">{state.evidenceIndex.length}</span>
                <p className="text-[11px] font-semibold text-slate-600 mt-0.5">Evidence Files</p>
              </div>
            </div>
          </div>

          {/* Section 4: Practices Evaluation Matrix */}
          <div className="space-y-4 print-page-break">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border-l-4 border-brand-600">
              4. {frameworkTitle} Practices Evaluation Matrix ({totalControls} Controls)
            </h2>

            <div className="space-y-4">
              {frameworkControls.map((ctrl) => {
                const cState = state.controls[ctrl.id];
                const status = cState?.status || 'NOT_STARTED';
                const evidenceList = state.evidenceIndex.filter((e) => e.controlId === ctrl.id);
                const authority = ctrl.authorityReference || cmmcDisplayId(ctrl.id, activeFramework);
                const statement = composeImplementationStatement(ctrl.id, cState?.implementationNotes, state.objectives, activeFramework).text;

                return (
                  <div
                    key={ctrl.id}
                    className="p-4 rounded-xl border border-slate-300 bg-white space-y-2.5 shadow-sm"
                  >
                    <div className="print-avoid-break space-y-2.5">
                    {/* Control Bar */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold text-xs bg-slate-900 text-white px-2 py-0.5 rounded">
                          {cmmcDisplayId(ctrl.id, activeFramework)}
                        </span>
                        <span className="font-bold text-sm text-slate-900">
                          {ctrl.title}
                        </span>
                        <span className="text-[11px] text-slate-500 font-mono">
                          ({authority})
                        </span>
                      </div>

                      {/* Status Badge */}
                      <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full self-start sm:self-auto ${
                        status === 'MET'
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : status === 'IN_PROGRESS'
                          ? 'bg-amber-100 text-amber-800 border border-amber-300'
                          : status === 'NOT_MET'
                          ? 'bg-rose-100 text-rose-800 border border-rose-300'
                          : 'bg-slate-100 text-slate-700 border border-slate-300'
                      }`}>
                        Status: {statusDisplayLabel(status)}
                      </span>
                    </div>

                    {/* Requirement Summary */}
                    <p className="text-[11px] text-slate-600 italic">
                      Requirement: {ctrl.plainEnglishSummary || ctrl.discussion}
                    </p>
                    </div>

                    {/* Implementation Narrative */}
                    <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">
                        Implementation Statement:
                      </span>
                      <p className="text-xs text-slate-800 leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                        {statement.trim() !== '' ? statement : (
                          <span className="text-slate-400 italic">No implementation notes documented.</span>
                        )}
                      </p>
                    </div>

                    {/* Evidence References with SHA-256 and vault path */}
                    <div className="flex items-start gap-2 flex-wrap text-[11px] pt-1">
                      <span className="font-semibold text-slate-600">Attached Evidence Artifacts:</span>
                      {evidenceList.length === 0 ? (
                        <span className="text-slate-400 italic">None attached</span>
                      ) : (
                        <div className="flex flex-col gap-1 w-full mt-1">
                          {evidenceList.map((e) => (
                            <div
                              key={e.id}
                              className="px-2.5 py-1 bg-slate-100 border border-slate-200 text-slate-800 rounded-lg font-mono text-[10px] flex items-center justify-between flex-wrap gap-2"
                            >
                              <span className="font-bold">{e.name}</span>
                              {e.fileHash && (
                                <span className="text-emerald-700 font-semibold">SHA-256: {e.fileHash.substring(0, 16)}...</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 5: Formal Attestation & Signature Block */}
          <div className="space-y-4 pt-6 border-t-2 border-slate-900 print-avoid-break">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900 bg-slate-100 px-3 py-1.5 rounded-lg border-l-4 border-brand-600">
              5. Formal Attestation & Self-Assessment Approval
            </h2>

            <p className="text-xs text-slate-700 leading-relaxed">
              I, the undersigned Senior Official / System Owner, hereby certify that the information contained within this System Security Plan (SSP) accurately reflects the security safeguards implemented within <strong>{meta.systemName}</strong> for <strong>{meta.organizationName}</strong> in accordance with {guidance.authority} and {frameworkTitle} standards.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 pt-6">
              <div className="border-t border-slate-900 pt-2">
                <p className="text-xs font-bold text-slate-900">{meta.systemOwner}</p>
                <p className="text-[11px] text-slate-500">System Owner / Authorized Representative Signature</p>
              </div>

              <div className="border-t border-slate-900 pt-2">
                <p className="text-xs font-bold text-slate-900">{meta.assessmentDate}</p>
                <p className="text-[11px] text-slate-500">Date of Attestation</p>
              </div>
            </div>
          </div>

        </div>
      )}
    </div>
  );
};
