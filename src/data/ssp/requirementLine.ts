import { cmmcRequirementStatement } from '../cmmcGuide/guide';

/**
 * The line an SSP prints above a control's implementation statement (#322). A CMMC requirement prints the assessment guide's own
 * wording, labelled "Requirement". Any other control has only the catalog's short summary, so it is labelled "Summary": a paraphrase
 * is never presented as the text of the standard.
 */
export interface RequirementLine {
  label: 'Requirement' | 'Summary';
  text: string;
}

export function sspRequirementLine(
  ctrl: { id: string; plainEnglishSummary?: string; discussion?: string; title?: string },
  framework: string
): RequirementLine {
  const statement = cmmcRequirementStatement(ctrl.id, framework);
  if (statement) return { label: 'Requirement', text: statement };
  return { label: 'Summary', text: ctrl.plainEnglishSummary || ctrl.discussion || ctrl.title || '' };
}
