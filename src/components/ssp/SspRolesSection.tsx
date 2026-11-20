import React, { useEffect, useId, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { TeamMember } from '../../types/tenant';
import type { SspProfile, SspRoleEntry } from '../../types/sspProfile';
import type { SspSectionStatus } from '../../data/ssp/sspCompleteness';
import { effectiveSspRoles } from '../../data/ssp/sspSections';
import {
  SSP_BUILDER_TEXT,
  addCustomRole,
  editRoleRow,
  isBlankRole,
  isLegacyOwnerShown,
  missingItemsLine,
  pickableMembers,
  removeRoleRow,
  roleRowError,
  roleRowsView,
  rolesForSave,
  selectMember,
} from '../../data/ssp/sspBuilderView';

interface SspRolesSectionProps {
  profile: SspProfile | null;
  legacySystemOwner: string;
  section?: SspSectionStatus;
  canEdit: boolean;
  profileEditable: boolean;
  onProfileChange: (p: SspProfile) => void;
  members: readonly TeamMember[];
  teamLoaded: boolean;
  teamError: string | null;
  serverBacked: boolean;
  framework: string;
}

const INPUT = 'w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-sm text-white focus:border-brand-500 focus:outline-none disabled:opacity-70 read-only:opacity-80';
const LABEL = 'block text-xs font-semibold text-slate-300 mb-1.5';
const MAX_ROLES = 40;

/**
 * 1.2: who is responsible for the system. A role holder is a team member (their name and email are copied: a snapshot) or free text. The
 * System Owner role is mirrored into the legacy System Owner field by the profile hook; this component never writes SSP metadata.
 */
export const SspRolesSection: React.FC<SspRolesSectionProps> = ({
  profile,
  legacySystemOwner,
  section,
  canEdit,
  profileEditable,
  onProfileChange,
  members,
  teamLoaded,
  teamError,
  serverBacked,
  framework,
}) => {
  const baseId = useId();
  // null: show the saved rows. Once the user edits, the draft keeps rows the server would refuse (or that are still blank) on screen.
  const [draft, setDraft] = useState<SspRoleEntry[] | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const removeRefs = useRef(new Map<string, HTMLButtonElement>());
  const titleRefs = useRef(new Map<string, HTMLInputElement>());

  const rows = draft ?? effectiveSspRoles(profile, legacySystemOwner);
  const pickable = pickableMembers(members);
  const views = roleRowsView({
    rows,
    rolesStatus: section,
    teamLoaded,
    members,
    legacy: draft === null && isLegacyOwnerShown(profile, legacySystemOwner),
    framework,
  });
  const invalid = rolesForSave(rows).some((r) => roleRowError(r) !== null);
  const atLimit = rolesForSave(rows).length >= MAX_ROLES;
  const missingLine = missingItemsLine(section);
  const editable = canEdit && profileEditable;

  const commit = (next: SspRoleEntry[]) => {
    setDraft(next);
    const toSave = rolesForSave(next);
    if (toSave.some((r) => roleRowError(r) !== null)) return;
    onProfileChange({ ...(profile ?? {}), roles: toSave });
  };

  useEffect(() => {
    if (confirmRemoveId) confirmRef.current?.focus();
  }, [confirmRemoveId]);
  useEffect(() => {
    if (!focusRowId) return;
    titleRefs.current.get(focusRowId)?.focus();
    setFocusRowId(null);
  }, [focusRowId]);
  useEffect(() => {
    if (!returnFocusId) return;
    removeRefs.current.get(returnFocusId)?.focus();
    setReturnFocusId(null);
  }, [returnFocusId]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">
        The people responsible for this system. Pick a team member or type a name and email; what you enter is stored in the SSP as written.
      </p>
      {missingLine && <p className="text-xs text-rose-300">{missingLine}</p>}
      {serverBacked && teamError && <p className="text-[11px] text-amber-300">{SSP_BUILDER_TEXT.teamFailed}</p>}
      {serverBacked && !teamError && !teamLoaded && <p className="text-[11px] text-slate-400">{SSP_BUILDER_TEXT.teamLoading}</p>}
      <p role="status" className={invalid ? 'text-xs text-rose-300' : 'sr-only'}>{invalid ? SSP_BUILDER_TEXT.rolesNotSaved : ''}</p>

      <div className="space-y-3">
        {views.map((v) => {
          const row = v.row;
          const rid = `${baseId}-${row.id}`;
          const err = isBlankRole(row) ? null : roleRowError(row);
          const errId = `${rid}-error`;
          const isCustom = row.roleKey === 'custom';
          const confirmId = `${rid}-confirm`;
          const confirming = confirmRemoveId === row.id;
          return (
            <fieldset
              key={row.id}
              className={`rounded-xl border bg-slate-950/40 p-3 sm:p-4 space-y-3 ${v.missing ? 'border-rose-500/40' : 'border-slate-800'}`}
            >
              <legend className="px-1 text-xs font-semibold text-slate-200 flex items-center gap-2">
                {v.label}
                {v.required ? (
                  <span className="px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-[10px] font-semibold text-rose-300">Required</span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] font-semibold text-slate-400">Optional</span>
                )}
              </legend>

              {isCustom && (
                <div>
                  <label htmlFor={`${rid}-title`} className={LABEL}>
                    Role title<span className="text-rose-300" aria-hidden="true"> *</span>
                  </label>
                  <input
                    id={`${rid}-title`}
                    ref={(el) => {
                      if (el) titleRefs.current.set(row.id, el);
                      else titleRefs.current.delete(row.id);
                    }}
                    type="text"
                    maxLength={128}
                    autoComplete="off"
                    aria-required="true"
                    aria-invalid={err?.field === 'customTitle' || undefined}
                    aria-describedby={err?.field === 'customTitle' ? errId : undefined}
                    disabled={!editable}
                    value={row.customTitle ?? ''}
                    onChange={(e) => commit(editRoleRow(rows, { rowId: row.id, roleKey: row.roleKey }, { customTitle: e.target.value }))}
                    className={INPUT}
                    placeholder="e.g. Facility security officer"
                  />
                </div>
              )}

              <div className={`grid grid-cols-1 ${serverBacked ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-3`}>
                {serverBacked && (
                  <div>
                    <label htmlFor={`${rid}-member`} className={LABEL}>Team member</label>
                    <select
                      id={`${rid}-member`}
                      disabled={!editable || !teamLoaded}
                      value={row.memberUserId ?? ''}
                      onChange={(e) => commit(selectMember(rows, row, e.target.value, pickable))}
                      className={INPUT}
                    >
                      <option value="">Not a team member (type below)</option>
                      {v.memberGone && row.memberUserId && (
                        <option value={row.memberUserId} disabled>{row.name || 'Former member'} (no longer on the team)</option>
                      )}
                      {pickable.map((m) => (
                        <option key={m.userId} value={m.userId}>{m.name} ({m.email})</option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label htmlFor={`${rid}-name`} className={LABEL}>
                    Name{v.required && <span className="text-rose-300" aria-hidden="true"> *</span>}
                  </label>
                  <input
                    id={`${rid}-name`}
                    type="text"
                    maxLength={128}
                    autoComplete="off"
                    readOnly={Boolean(row.memberUserId)}
                    aria-required={v.required || undefined}
                    aria-invalid={err?.field === 'name' || undefined}
                    aria-describedby={err?.field === 'name' ? errId : undefined}
                    disabled={!editable}
                    value={row.name}
                    onChange={(e) => commit(editRoleRow(rows, { rowId: row.id, roleKey: row.roleKey }, { name: e.target.value }))}
                    className={INPUT}
                    placeholder="Full name"
                  />
                </div>
                <div>
                  <label htmlFor={`${rid}-email`} className={LABEL}>Email</label>
                  <input
                    id={`${rid}-email`}
                    type="email"
                    inputMode="email"
                    maxLength={120}
                    autoComplete="off"
                    readOnly={Boolean(row.memberUserId)}
                    aria-invalid={err?.field === 'email' || undefined}
                    aria-describedby={err?.field === 'email' ? errId : undefined}
                    disabled={!editable}
                    value={row.email}
                    onChange={(e) => commit(editRoleRow(rows, { rowId: row.id, roleKey: row.roleKey }, { email: e.target.value }))}
                    className={INPUT}
                    placeholder="name@example.com"
                  />
                </div>
              </div>

              {v.showCertificate && (
                <label className="flex items-start gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-brand-500"
                    disabled={!editable}
                    checked={row.certificateOnFile === true}
                    onChange={(e) => commit(editRoleRow(rows, { rowId: row.id, roleKey: row.roleKey }, { certificateOnFile: e.target.checked }))}
                  />
                  <span>
                    {SSP_BUILDER_TEXT.certificate}
                    <span className="block text-[11px] text-slate-500">{SSP_BUILDER_TEXT.certificateHint}</span>
                  </span>
                </label>
              )}

              {v.legacy && <p className="text-[11px] text-cyan-300">{SSP_BUILDER_TEXT.legacyOwner}</p>}
              {v.memberGone && <p className="text-[11px] text-amber-300">{SSP_BUILDER_TEXT.memberGone}</p>}
              {row.memberUserId && !v.memberGone && <p className="text-[11px] text-slate-500">{SSP_BUILDER_TEXT.memberCopied}</p>}
              {err && <p id={errId} className="text-[11px] text-rose-300">{err.text}</p>}

              {isCustom && canEdit && (
                <div className="space-y-2">
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) removeRefs.current.set(row.id, el);
                      else removeRefs.current.delete(row.id);
                    }}
                    disabled={!profileEditable}
                    aria-expanded={isBlankRole(row) ? undefined : confirming}
                    aria-controls={isBlankRole(row) ? undefined : confirmId}
                    onClick={() => {
                      if (isBlankRole(row)) {
                        setDraft(removeRoleRow(rows, row.id));
                        addRef.current?.focus();
                        return;
                      }
                      setConfirmRemoveId(confirming ? null : row.id);
                    }}
                    className="text-xs text-rose-300 hover:text-rose-200 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded disabled:opacity-60"
                  >
                    Remove<span className="sr-only"> custom role</span>
                  </button>
                  {confirming && (
                    <div
                      id={confirmId}
                      role="group"
                      aria-labelledby={`${confirmId}-text`}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          setConfirmRemoveId(null);
                          setReturnFocusId(row.id);
                        }
                      }}
                      className="space-y-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3"
                    >
                      <p id={`${confirmId}-text`} className="text-xs text-rose-200">{SSP_BUILDER_TEXT.removeRoleConfirm}</p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmRemoveId(null);
                            setReturnFocusId(row.id);
                          }}
                          className="px-3 py-1.5 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-700 text-xs"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          ref={confirmRef}
                          onClick={() => {
                            const next = removeRoleRow(rows, row.id);
                            setConfirmRemoveId(null);
                            commit(next);
                            addRef.current?.focus();
                          }}
                          className="btn-danger px-3 py-1.5 rounded-xl text-xs"
                        >
                          Remove role
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </fieldset>
          );
        })}
      </div>

      {canEdit && (
        <div className="space-y-2">
          <button
            ref={addRef}
            type="button"
            disabled={!profileEditable || atLimit}
            onClick={() => {
              const r = addCustomRole(rows);
              setDraft(r.rows);
              setFocusRowId(r.id);
            }}
            className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            Add custom role
          </button>
          {atLimit && <p className="text-[11px] text-slate-400">{SSP_BUILDER_TEXT.rolesLimit}</p>}
        </div>
      )}
    </div>
  );
};
