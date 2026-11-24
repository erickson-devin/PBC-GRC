import { FRAMEWORK_REGISTRY } from './frameworks/frameworkRegistry';

/** Whether a framework has baselines to filter by (today only NIST SP 800-53 Rev. 5, under its id or its alias). */
export function frameworkHasBaselines(fw: string): boolean {
  return (FRAMEWORK_REGISTRY[fw]?.supportedBaselines?.length ?? 0) > 0;
}
