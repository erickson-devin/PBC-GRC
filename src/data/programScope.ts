import { getFrameworkControls } from './frameworks/frameworkRegistry';
import type { CiaTriadSelection, ComplianceFramework, FrameworkControlDefinition, ImpactLevel, OverlayFilters } from '../types/framework';
import type { Program, ProgramBaseline, ProgramScoping } from '../types/program';

/**
 * What a program's framework and baseline mean for the controls shown. Pure; the catalogs in src/data/frameworks are read, not changed.
 */

/** The CIA triad a program's baseline stands for: the same level three times, or "all controls" without a baseline. */
export function programBaselineToCia(baseline: ProgramBaseline | null | undefined): CiaTriadSelection {
  if (baseline === 'LOW' || baseline === 'MODERATE' || baseline === 'HIGH') {
    const level: ImpactLevel = baseline;
    return { confidentiality: level, integrity: level, availability: level, isAllControlsApplied: false };
  }
  return { confidentiality: 'LOW', integrity: 'LOW', availability: 'LOW', isAllControlsApplied: true };
}

/**
 * The NIST SP 800-53 controls of a security baseline (a tier id such as 'LOW_LOW_LOW' / 'MOD_MOD_MOD' / 'HIGH_HIGH_HIGH', a program
 * baseline, or null for the whole catalog) plus, when `privacy` is true, the SP 800-53B privacy baseline: the union, each control
 * once, in catalog order. Overlays apply to both parts. Pure; usable by the server.
 */
export function nistControlsWithPrivacy(
  baseline: string | ProgramBaseline | null | undefined,
  privacy: boolean,
  overlays: Partial<OverlayFilters> = {}
): FrameworkControlDefinition[] {
  const security = getFrameworkControls('NIST_800_53_REV5', baseline ?? 'ALL_CONTROLS', overlays);
  return privacy ? addPrivacyControls(security, overlays) : security;
}

/** `security` plus the privacy-baseline controls, each once, in catalog order (built outside the registry, which ignores privacy). */
function addPrivacyControls(security: FrameworkControlDefinition[], overlays: Partial<OverlayFilters>): FrameworkControlDefinition[] {
  const ids = new Set(security.map((c) => c.id));
  const all = getFrameworkControls('NIST_800_53_REV5', 'ALL_CONTROLS', overlays);
  for (const c of all) if (c.baselines?.privacy) ids.add(c.id);
  return all.filter((c) => ids.has(c.id));
}

/** The four overlay keys a program's scoping may hold (the keys of OverlayFilters). */
export const PROGRAM_SCOPING_KEYS = ['nonNetworkedOnly', 'noWireless', 'noMobileDevices', 'noPiiProcessing'] as const;

/**
 * Checks the scoping (overlays) a program is created or edited with and returns it in stored form: only the keys set to true. Refuses
 * anything but a plain object, an unknown key, a value that is not a boolean, `noPiiProcessing` on a program with the privacy
 * baseline, and any true key on a program that is not NIST SP 800-53 (CMMC assesses every requirement). Absent or null is `{}`. Pure.
 */
export function normalizeProgramScoping(
  raw: unknown,
  program: { frameworkId: string; privacyBaseline?: boolean }
): { ok: true; value: ProgramScoping } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'The scoping is an object of overlay switches' };
  const known: readonly string[] = PROGRAM_SCOPING_KEYS;
  const value: ProgramScoping = {};
  for (const [key, flag] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.includes(key)) return { ok: false, error: `Unknown scoping key: ${key}` };
    if (typeof flag !== 'boolean') return { ok: false, error: `The scoping key ${key} is true or false` };
    if (flag) value[key as keyof ProgramScoping] = true;
  }
  if (Object.keys(value).length === 0) return { ok: true, value };
  const isNist = program.frameworkId === 'NIST_800_53_REV5' || program.frameworkId === 'nist-800-53-r5';
  if (!isNist) return { ok: false, error: 'Only a NIST SP 800-53 program can be scoped' };
  if (value.noPiiProcessing && program.privacyBaseline === true) return { ok: false, error: 'A program with the privacy baseline cannot exclude PII processing' };
  return { ok: true, value };
}

/** The overlay switches a program's scoping stands for (every key present). */
export function scopingToOverlays(scoping: ProgramScoping | null | undefined): OverlayFilters {
  const s = scoping ?? {};
  return { nonNetworkedOnly: !!s.nonNetworkedOnly, noWireless: !!s.noWireless, noMobileDevices: !!s.noMobileDevices, noPiiProcessing: !!s.noPiiProcessing };
}

/** The controls of a program: its framework's catalog, narrowed by the baseline (NIST SP 800-53, plus the privacy baseline when the program has it) and the overlays. */
export function programFrameworkControls(
  program: Pick<Program, 'framework' | 'baseline'> & { privacyBaseline?: boolean },
  overlays: OverlayFilters
): FrameworkControlDefinition[] {
  const framework: ComplianceFramework | string = program.framework;
  const isNist = framework === 'NIST_800_53_REV5' || framework === 'nist-800-53-r5';
  const baseline = isNist ? programBaselineToCia(program.baseline) : 'ALL_CONTROLS';
  const controls = getFrameworkControls(framework, baseline, overlays);
  return isNist && program.privacyBaseline === true ? addPrivacyControls(controls, overlays) : controls;
}
