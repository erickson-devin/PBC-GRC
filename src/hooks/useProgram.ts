import { useMemo } from 'react';
import { useTenant } from '../context/TenantContext';

/**
 * The programs of the active tenant and the active one, with what a switcher or a programs page needs.
 * A thin view of TenantContext (which owns the state and the switch sequence).
 */
export function useProgram() {
  const {
    programs,
    activeProgram,
    programsStatus,
    switchProgram,
    refreshPrograms,
    createProgram,
    updateProgram,
    archiveProgram,
    unarchiveProgram,
    deleteProgram,
    canManagePrograms,
  } = useTenant();

  /** Programs that can be switched to (archived ones stay readable on the programs page only). */
  const openPrograms = useMemo(() => programs.filter((p) => !p.archived), [programs]);

  return {
    programs,
    openPrograms,
    activeProgram,
    programsStatus,
    switchProgram,
    refreshPrograms,
    createProgram,
    updateProgram,
    archiveProgram,
    unarchiveProgram,
    deleteProgram,
    canManagePrograms,
  };
}
