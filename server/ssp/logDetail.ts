import { errorMessage } from '../../src/utils/errors';

/** What may be logged about an error in the SSP import: fs and pg messages can carry a stored path or row values, so only their code is kept (#290). */
export function logDetail(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') return `code ${code}`;
  return errorMessage(err) || 'unknown';
}
