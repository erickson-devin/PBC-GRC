// Per-domain summary for the Framework Guidance page. Pure: counts come from the controls of the active program.
import { FRAMEWORK_REGISTRY } from '../frameworks/frameworkRegistry';

export interface GuidanceDomainSummary {
  code: string;
  name: string;
  description: string;
  color: string;
  count: number;
  /** The first `maxIds` control ids of the domain. */
  ids: string[];
  /** How many more controls the domain has beyond `ids`. */
  more: number;
}

export function guidanceDomainSummary(
  framework: string,
  controls: ReadonlyArray<{ id: string; domain: string }>,
  maxIds = 6
): GuidanceDomainSummary[] {
  const domains = FRAMEWORK_REGISTRY[framework]?.domains ?? {};
  const out: GuidanceDomainSummary[] = [];
  for (const code of Object.keys(domains)) {
    const inDomain = controls.filter((c) => c.domain === code);
    if (inDomain.length === 0) continue;
    const info = domains[code];
    out.push({
      code,
      name: info.name,
      description: info.description,
      color: info.color,
      count: inDomain.length,
      ids: inDomain.slice(0, maxIds).map((c) => c.id),
      more: Math.max(0, inDomain.length - maxIds),
    });
  }
  return out;
}
