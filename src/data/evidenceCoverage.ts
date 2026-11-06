// Evidence Vault coverage: how many of the program's controls have at least one evidence file. Pure.

/** covered = distinct evidence control ids that are among `controlIds` (evidence for a control outside the program does not count); total = distinct `controlIds`. */
export function evidenceCoverage(
  evidence: ReadonlyArray<{ controlId: string }>,
  controlIds: readonly string[]
): { covered: number; total: number } {
  const all = new Set(controlIds);
  const covered = new Set<string>();
  for (const e of evidence) {
    if (all.has(e.controlId)) covered.add(e.controlId);
  }
  return { covered: covered.size, total: all.size };
}
