import React, { useId, useMemo, useRef, useState } from 'react';
import { Plus, UsersRound } from 'lucide-react';
import { ErrorNotice } from '../common/ErrorNotice';
import { useTenant } from '../../context/TenantContext';
import { useTeams } from '../../hooks/useTeams';
import { ASSIGNMENT_TEXT, assigneeOptions, teamErrorMessage } from '../../data/assignments/assignmentsUiView';
import { MAX_TEAM_MEMBERS, TEAM_DESCRIPTION_MAX, TEAM_NAME_MAX } from '../../types/assignments';
import type { Team } from '../../types/assignments';
import type { TeamMember } from '../../types/tenant';

const NO_MEMBERS: TeamMember[] = [];
const FIELD_CLASS = 'w-full bg-slate-800/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-cyan-500';
const LINK_BTN = 'text-xs font-semibold text-cyan-300 hover:text-cyan-200 hover:underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500';

type Mode = { kind: 'edit' | 'members'; teamId: string } | { kind: 'delete'; teamId: string; assignments: number; programs: number } | null;

const memberName = (m: Pick<TeamMember, 'name' | 'email'>): string => (m.name || '').trim() || m.email;

/**
 * Teams (#253): a named group of members that can be assigned a control, an objective or an SSP section. A Tenant Owner or Admin creates, renames, fills
 * and deletes teams; every role can read the list. A team is a label: being in one gives nobody access. Deleting a team that has assignments asks first
 * and says how many are removed with it.
 */
export const TeamsSection: React.FC = () => {
  const { currentTenant, teamMembers, canManageTenant } = useTenant();
  const { supported, status, teams, reload, create, update, setMembers, usage, remove } = useTeams();
  const members = teamMembers[currentTenant.id] ?? NO_MEMBERS;
  const uid = useId();
  const [mode, setMode] = useState<Mode>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const newNameRef = useRef<HTMLInputElement>(null);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) if (m.userId) map.set(m.userId, memberName(m));
    return map;
  }, [members]);
  const focusButton = (key: string): void => {
    requestAnimationFrame(() => buttons.current.get(key)?.focus());
  };
  const bind = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) buttons.current.set(key, el);
    else buttons.current.delete(key);
  };
  const close = (focusKey?: string): void => {
    setMode(null);
    setError(null);
    if (focusKey) focusButton(focusKey);
  };
  const guard = async (run: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await run();
      return true;
    } catch (err: unknown) {
      setError(teamErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!supported) return <p className="text-xs text-slate-400">{ASSIGNMENT_TEXT.browserOnly}</p>;

  const submitCreate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!newName.trim()) return;
    const ok = await guard(async () => {
      await create({ name: newName.trim(), description: newDescription.trim() });
      setNotice('Team created. It has no members yet.');
    });
    if (ok) {
      setCreating(false);
      setNewName('');
      setNewDescription('');
      focusButton('new');
    }
  };
  const startEdit = (t: Team): void => {
    setError(null);
    setEditName(t.name);
    setEditDescription(t.description);
    setMode({ kind: 'edit', teamId: t.id });
  };
  const submitEdit = async (e: React.FormEvent, t: Team): Promise<void> => {
    e.preventDefault();
    if (!editName.trim()) return;
    const ok = await guard(async () => {
      await update(t.id, { name: editName.trim(), description: editDescription.trim() });
      setNotice('Team saved.');
    });
    if (ok) close(`${t.id}:edit`);
  };
  const startMembers = (t: Team): void => {
    setError(null);
    setFilter('');
    setPicked(new Set(t.memberIds));
    setMode({ kind: 'members', teamId: t.id });
  };
  const submitMembers = async (t: Team): Promise<void> => {
    const add = [...picked].filter((id) => !t.memberIds.includes(id));
    const removed = t.memberIds.filter((id) => !picked.has(id));
    if (add.length === 0 && removed.length === 0) return;
    const ok = await guard(async () => {
      await setMembers(t.id, { add, remove: removed });
      setNotice('Team members saved.');
    });
    if (ok) close(`${t.id}:members`);
  };
  const startDelete = async (t: Team): Promise<void> => {
    setError(null);
    let assignments = 0;
    let programs = 0;
    const ok = await guard(async () => {
      const rows = await usage(t.id);
      assignments = rows.reduce((n, r) => n + r.assignments, 0);
      programs = rows.filter((r) => r.assignments > 0).length;
    });
    if (ok) setMode({ kind: 'delete', teamId: t.id, assignments, programs });
  };
  const confirmDelete = async (t: Team, assignments: number): Promise<void> => {
    const changed: { use: { assignments: number; programs: number } | null } = { use: null };
    const ok = await guard(async () => {
      try {
        await remove(t.id, assignments > 0);
      } catch (err: unknown) {
        // The team was given assignments since the check: show the new counts and ask again
        const use = (err as { teamUse?: { assignments: number; programs: number } } | null)?.teamUse;
        if (use) changed.use = use;
        throw err;
      }
      setNotice('Team deleted.');
    });
    if (ok) {
      close();
      requestAnimationFrame(() => newNameRef.current?.focus() ?? buttons.current.get('new')?.focus());
    } else if (changed.use) {
      setMode({ kind: 'delete', teamId: t.id, assignments: changed.use.assignments, programs: changed.use.programs });
    }
  };

  return (
    <div className="space-y-4 animate-fadeIn">
      <div className="space-y-1">
        <h3 className="text-sm font-bold text-white flex items-center gap-2"><UsersRound className="w-4 h-4 text-cyan-400" aria-hidden="true" />Teams</h3>
        <p className="text-xs text-slate-400">Group members so a control, an objective or an SSP section can be assigned to the whole team.</p>
        <p className="text-[11px] text-slate-400">{ASSIGNMENT_TEXT.labelOnly}</p>
      </div>

      {canManageTenant && (
        creating ? (
          <form
            onSubmit={(e) => void submitCreate(e)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setCreating(false); setError(null); focusButton('new'); } }}
            className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-3"
          >
            <div>
              <label htmlFor={`${uid}-name`} className="block font-semibold text-slate-300 mb-1.5 text-xs">Team name</label>
              <input id={`${uid}-name`} ref={newNameRef} autoFocus required maxLength={TEAM_NAME_MAX} value={newName} onChange={(e) => setNewName(e.target.value)} className={FIELD_CLASS} />
            </div>
            <div>
              <label htmlFor={`${uid}-desc`} className="block font-semibold text-slate-300 mb-1.5 text-xs">Description</label>
              <textarea id={`${uid}-desc`} maxLength={TEAM_DESCRIPTION_MAX} rows={2} value={newDescription} onChange={(e) => setNewDescription(e.target.value)} className={FIELD_CLASS} />
            </div>
            <ErrorNotice message={error} />
            <div className="flex gap-2">
              <button type="submit" disabled={busy || !newName.trim()} className="btn-primary px-3.5 py-2 text-xs rounded-xl disabled:opacity-50">{busy ? 'Creating…' : 'Create team'}</button>
              <button type="button" onClick={() => { setCreating(false); setError(null); focusButton('new'); }} className="px-3.5 py-2 text-xs font-semibold text-slate-300 hover:text-white">Cancel</button>
            </div>
          </form>
        ) : (
          <button type="button" ref={bind('new')} onClick={() => { setError(null); setCreating(true); }} className="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />New team
          </button>
        )
      )}

      {status === 'loading' && teams.length === 0 && <p role="status" className="text-xs text-slate-400">Loading teams…</p>}
      {status === 'error' && (
        <div className="space-y-2">
          <ErrorNotice message="Teams could not be loaded." />
          <button type="button" onClick={() => void reload()} className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold">Try again</button>
        </div>
      )}
      {status === 'ready' && teams.length === 0 && (
        <p className="text-xs text-slate-400">{canManageTenant ? 'There are no teams yet. Create one to assign work to a group.' : 'There are no teams yet.'}</p>
      )}

      <ul className="space-y-3">
        {teams.map((t) => {
          const editing = mode?.kind === 'edit' && mode.teamId === t.id;
          const picking = mode?.kind === 'members' && mode.teamId === t.id;
          const deleting = mode?.kind === 'delete' && mode.teamId === t.id ? mode : null;
          const count = t.memberIds.length;
          const pickable = assigneeOptions(members, [], Date.now(), null).people;
          const shownPickable = pickable.filter((o) => o.label.toLowerCase().includes(filter.trim().toLowerCase()));
          const deleteId = `${uid}-del-${t.id}`;
          return (
            <li key={t.id} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h4 className="text-sm font-bold text-white">{t.name}</h4>
                <span className="text-xs text-slate-400">{count} {count === 1 ? 'member' : 'members'}</span>
              </div>
              {t.description && <p className="text-xs text-slate-300">{t.description}</p>}
              {count > 0 && <p className="text-xs text-slate-400">{t.memberIds.map((id) => names.get(id) ?? 'Former member').join(', ')}</p>}

              {canManageTenant && !editing && !picking && !deleting && (
                <div className="flex flex-wrap gap-3 pt-1">
                  <button type="button" ref={bind(`${t.id}:edit`)} onClick={() => startEdit(t)} aria-label={`Edit team ${t.name}`} className={LINK_BTN}>Edit</button>
                  <button type="button" ref={bind(`${t.id}:members`)} onClick={() => startMembers(t)} aria-label={`Members of team ${t.name}`} className={LINK_BTN}>Members</button>
                  <button type="button" ref={bind(`${t.id}:delete`)} onClick={() => void startDelete(t)} disabled={busy} aria-label={`Delete team ${t.name}`} className="text-xs font-semibold text-rose-300 hover:text-rose-200 hover:underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:opacity-50">Delete</button>
                </div>
              )}

              {editing && (
                <form
                  onSubmit={(e) => void submitEdit(e, t)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(`${t.id}:edit`); } }}
                  className="space-y-3 pt-1"
                >
                  <div>
                    <label htmlFor={`${uid}-en-${t.id}`} className="block font-semibold text-slate-300 mb-1.5 text-xs">Team name</label>
                    <input id={`${uid}-en-${t.id}`} autoFocus required maxLength={TEAM_NAME_MAX} value={editName} onChange={(e) => setEditName(e.target.value)} className={FIELD_CLASS} />
                  </div>
                  <div>
                    <label htmlFor={`${uid}-ed-${t.id}`} className="block font-semibold text-slate-300 mb-1.5 text-xs">Description</label>
                    <textarea id={`${uid}-ed-${t.id}`} maxLength={TEAM_DESCRIPTION_MAX} rows={2} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className={FIELD_CLASS} />
                  </div>
                  <ErrorNotice message={error} />
                  <div className="flex gap-2">
                    <button type="submit" disabled={busy || !editName.trim()} className="btn-primary px-3.5 py-2 text-xs rounded-xl disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
                    <button type="button" onClick={() => close(`${t.id}:edit`)} className="px-3.5 py-2 text-xs font-semibold text-slate-300 hover:text-white">Cancel</button>
                  </div>
                </form>
              )}

              {picking && (
                <div
                  role="group"
                  aria-labelledby={`${uid}-mh-${t.id}`}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(`${t.id}:members`); } }}
                  className="space-y-3 pt-1"
                >
                  <p id={`${uid}-mh-${t.id}`} className="text-xs font-semibold text-slate-300">Members of {t.name}</p>
                  <div>
                    <label htmlFor={`${uid}-mf-${t.id}`} className="sr-only">Filter people</label>
                    <input id={`${uid}-mf-${t.id}`} autoFocus type="search" placeholder="Filter people" value={filter} onChange={(e) => setFilter(e.target.value)} className={FIELD_CLASS} />
                  </div>
                  <ul className="max-h-56 overflow-y-auto divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-950/60">
                    {shownPickable.length === 0 && <li className="px-3 py-2 text-xs text-slate-400">No one matches.</li>}
                    {shownPickable.map((o) => {
                      const id = o.value.slice('user:'.length);
                      const checked = picked.has(id);
                      const full = !checked && picked.size >= MAX_TEAM_MEMBERS;
                      return (
                        <li key={o.value}>
                          <label className="flex items-center gap-2 px-3 py-2 text-xs text-slate-200">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={(o.disabled && !t.memberIds.includes(id)) || full}
                              onChange={(e) => setPicked((prev) => { const next = new Set(prev); if (e.target.checked) next.add(id); else next.delete(id); return next; })}
                            />
                            {o.label}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  <ErrorNotice message={error} />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void submitMembers(t)} disabled={busy} className="btn-primary px-3.5 py-2 text-xs rounded-xl disabled:opacity-50">{busy ? 'Saving…' : 'Save members'}</button>
                    <button type="button" onClick={() => close(`${t.id}:members`)} className="px-3.5 py-2 text-xs font-semibold text-slate-300 hover:text-white">Cancel</button>
                  </div>
                </div>
              )}

              {deleting && (
                <div
                  role="alertdialog"
                  aria-labelledby={deleteId}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(`${t.id}:delete`); } }}
                  className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 space-y-3"
                >
                  <p id={deleteId} className="text-xs text-rose-100">
                    {deleting.assignments === 0
                      ? `Delete the team ${t.name}?`
                      : `${t.name} is assigned to ${deleting.assignments} ${deleting.assignments === 1 ? 'item' : 'items'} in ${deleting.programs} ${deleting.programs === 1 ? 'program' : 'programs'}. Deleting it removes ${deleting.assignments === 1 ? 'that assignment' : `those ${deleting.assignments} assignments`}.`}
                  </p>
                  <ErrorNotice message={error} />
                  <div className="flex gap-2">
                    <button type="button" autoFocus onClick={() => void confirmDelete(t, deleting.assignments)} disabled={busy} className="btn-danger px-3.5 py-2 text-xs rounded-xl disabled:opacity-50">
                      {busy ? 'Deleting…' : deleting.assignments === 0 ? 'Delete team' : 'Delete team and assignments'}
                    </button>
                    <button type="button" onClick={() => close(`${t.id}:delete`)} className="px-3.5 py-2 text-xs font-semibold text-slate-300 hover:text-white">Cancel</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!canManageTenant && teams.length > 0 && <p className="text-[11px] text-slate-400">Teams are managed by a Tenant Owner or Admin.</p>}
      <ErrorNotice message={mode === null && !creating ? error : null} />
      <span role="status" aria-live="polite" className="sr-only">{notice}</span>
    </div>
  );
};
