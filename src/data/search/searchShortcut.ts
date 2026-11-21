// The keyboard shortcut that opens the global search (#254): "/" when the focus is not in a field, and Ctrl+K or Cmd+K anywhere. Never while an input
// method is composing text or when another handler already took the key. Pure: reads the event's plain fields only.

export interface SearchShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
}

const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True when the key press should open the search (the caller then calls preventDefault). */
export function isSearchShortcut(e: SearchShortcutEvent): boolean {
  if (e.isComposing === true || e.defaultPrevented === true || e.altKey) return false;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return true;
  if (e.key !== '/' || e.ctrlKey || e.metaKey) return false;
  const t = e.target;
  if (t && (t.isContentEditable === true || FIELD_TAGS.has((t.tagName ?? '').toUpperCase()))) return false;
  return true;
}
