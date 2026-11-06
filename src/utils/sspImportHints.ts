/** True when the suggestions are all cross-references (the document mentions controls but has no section per control). */
export function isCrossReferenceOnly(staged: ReadonlyArray<{ matchKind: string }>): boolean {
  return staged.length > 0 && staged.every((s) => s.matchKind === 'MENTION');
}
