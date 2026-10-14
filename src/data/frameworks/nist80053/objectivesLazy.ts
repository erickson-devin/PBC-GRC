import { hasNist80053Objectives, setNist80053Objectives } from './objectives';

let loading: Promise<void> | null = null;

/** Loads the SP 800-53A objectives into the browser, once, as a separate file. Resolves when they are available. */
export function loadNist80053Objectives(): Promise<void> {
  if (hasNist80053Objectives()) return Promise.resolve();
  loading ??= import('./objectives.generated.json').then((m) => setNist80053Objectives((m.default as { objectives: Parameters<typeof setNist80053Objectives>[0] }).objectives));
  return loading;
}
