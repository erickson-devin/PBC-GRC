import { useEffect, useId, useRef } from 'react';
import { registerUnsavedTextProvider, type UnsavedTextEntry } from '../services/unsavedText';

/**
 * Reports an editor's unsaved fields to the rescue registry (see services/unsavedText.ts). The latest getter is kept in a
 * ref, so the registration happens once and the rescue (which runs synchronously when the server ends a session) always
 * reads current values. Read refs or current state inside the getter.
 */
export function useUnsavedTextProvider(getEntries: () => UnsavedTextEntry[]): void {
  const id = useId();
  const getterRef = useRef(getEntries);
  getterRef.current = getEntries;
  useEffect(() => registerUnsavedTextProvider(id, () => getterRef.current()), [id]);
}
