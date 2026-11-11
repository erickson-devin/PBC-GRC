/**
 * Maps a reported operating system (name, version) to one of the operating system profile keys the asset form offers.
 * The mapping is strict: a name that is not clearly one of the known profiles is 'custom', and the reported OS stays in the notes.
 */

export const OS_PROFILE_KEYS = ['rhel9', 'rhel8', 'win11', 'win2022', 'ubuntu2204', 'cisco_ios'] as const;
export type OsProfileKey = (typeof OS_PROFILE_KEYS)[number];

export const isKnownOsProfile = (v: unknown): v is OsProfileKey => typeof v === 'string' && (OS_PROFILE_KEYS as readonly string[]).includes(v);

/** The profile key for a reported OS name and version; 'custom' when it does not clearly match a known profile. */
export function osProfileFor(name: string, version: string): string {
  const n = String(name ?? '');
  const v = String(version ?? '').trim();
  if (/\bwindows server 2022\b/i.test(n)) return 'win2022';
  if (/\bwindows 11\b/i.test(n)) return 'win11';
  if (/\bred hat enterprise linux\b/i.test(n)) {
    const major = /^(\d+)(?:\.|$)/.exec(v)?.[1];
    if (major === '9') return 'rhel9';
    if (major === '8') return 'rhel8';
    return 'custom';
  }
  if (/\bubuntu\b/i.test(n) && v.startsWith('22.04')) return 'ubuntu2204';
  if (/cisco ios/i.test(n)) return 'cisco_ios';
  return 'custom';
}

/** The value for the asset form's operating system select: a known key is itself, anything else is 'custom'. */
export const osProfileSelectValue = (raw: string | null | undefined): string => (isKnownOsProfile(raw) ? raw : 'custom');
