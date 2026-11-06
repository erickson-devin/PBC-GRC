/**
 * What a person is told about the local AI helper (pure, so it can be tested without a browser). The wording never includes a
 * reason sent by the server: that text can name the AI service's address, which end users must not see (issue #191).
 */
export type AiAvailability = 'readOnly' | 'checking' | 'ready' | 'noRole' | 'off' | 'unavailable';

export function aiAvailability(s: { enabled: boolean; available: boolean; canUse?: boolean } | null, canEdit: boolean): AiAvailability {
  if (!canEdit) return 'readOnly';
  if (!s) return 'checking';
  if (!s.enabled) return 'off';
  if (!s.available) return 'unavailable';
  if (s.canUse === false) return 'noRole';
  return 'ready';
}

export interface AiNoticeCopy {
  line: string;
  /** Only for administrators. */
  adminHint?: string;
}

export function aiNoticeCopy(a: AiAvailability, where: 'assist' | 'import'): AiNoticeCopy | null {
  const importing = where === 'import';
  switch (a) {
    case 'off':
      return {
        line: importing ? 'Local AI reading is turned off. Rule-based matching is used for this import.' : 'Local AI suggestions are turned off for this workspace. You can still fill in every value yourself.',
        adminHint: `Administrator: set SSP_AI_ENABLED=true and connect a local Ollama service to turn ${importing ? 'AI reading' : 'suggestions'} on.`,
      };
    case 'unavailable':
      return importing
        ? {
            line: 'Local AI reading is unavailable right now. Rule-based matching still works.',
            adminHint: 'Administrator: the server could not reach its local Ollama service, or the model is not installed. Check the server log.',
          }
        : {
            line: 'Local AI suggestions are unavailable right now. Ask your administrator to check the local AI service.',
            adminHint: 'Administrator: the server could not reach its local Ollama service, or the model is not installed. Check the server log.',
          };
    case 'noRole':
      return importing ? null : { line: 'Your role cannot ask for AI suggestions.' };
    default:
      return null;
  }
}

export const AI_BUTTON_CHECKING_TITLE = 'Checking whether local AI suggestions are available…';

const UNAVAILABLE_ASSIST_LINE = 'Local AI suggestions are unavailable right now. Ask your administrator to check the local AI service.';

/** An error message from the AI endpoints, made safe to show: anything about the service being unreachable becomes the plain line. */
export function aiErrorForUser(message: string | undefined): string {
  if (!message) return 'The AI helper failed. Try again.';
  return /not available|Cannot reach|at https?:\/\//i.test(message) ? UNAVAILABLE_ASSIST_LINE : message;
}
