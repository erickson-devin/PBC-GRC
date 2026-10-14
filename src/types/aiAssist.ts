import type { ControlParameter } from './framework';

/** Local-model editing helpers (Suggest Parameter Wording). Shapes of /ai-assist responses. */
export interface AiAssistStatus {
  enabled: boolean;
  available: boolean;
  model: string;
  /** Whether the signed-in role may ask for suggestions. */
  canUse: boolean;
  reason?: string;
}

export type WordingSuggestionRequest =
  | { controlId: string; parameterId: string }
  | { controlId: string; parameter: Pick<ControlParameter, 'kind' | 'label' | 'prompt' | 'choices' | 'selectionMode'>; /** The sentence of the narrative that holds the tag, with the tag marked <<like this>> */ context?: string }
  | { controlId: string; sentence: string };

export interface WordingSuggestions {
  mode: 'PARAMETER' | 'SENTENCE';
  options: Array<{ text: string; note: string }>;
  model: string;
  promptVersion: string;
  rejected: number;
}
