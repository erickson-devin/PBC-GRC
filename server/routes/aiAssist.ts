import { Router, Request, Response } from 'express';
import { getFrameworkControls } from '../../src/data/frameworks';
import { findVagueWording, resolveParameters } from '../../src/data/frameworks/parameters';
import type { ComplianceFramework, ControlParameter, FrameworkControlDefinition } from '../../src/types/framework';
import { frameworksDefiningControl, ensureControlInProgram } from '../middleware/frameworkGuard';
import { OllamaClient, OllamaError } from '../ssp/ollama';
import { WordingError, suggestWording, type WordingRequest } from '../ssp/parameterWording';
import { ensureActiveTenant } from './tenantGuards';
import { canRoleWrite } from '../../src/utils/roles';
import { errorMessage } from '../../src/utils/errors';

/**
 * Local-model helpers for the control editor, mounted at /api/v1/tenants/:tenantId/ai-assist AFTER requireWriteRole: asking the
 * model for wording is a write-role action (it uses the GPU and is part of editing), reading the status is open to any member.
 *
 * Only the control's own public text and the ONE sentence or parameter being worked on go to the model, never the rest of the
 * narrative, and nothing here writes a control.
 */
const router = Router({ mergeParams: true });

const CONTROL_ID = /^[A-Za-z0-9._()-]{1,64}$/;
const MAX_SENTENCE = 600;
const MAX_CHOICES = 12;
const MAX_CHOICE_CHARS = 200;

// ---- per-user throttle (the model serves one request at a time; this stops one person monopolising it)
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();
function throttled(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5_000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}
/** Test hook. */
export function __resetAiAssistThrottleForTests(): void {
  hits.clear();
}

router.use((req: Request, res: Response, next) => {
  if (!ensureActiveTenant(req, res)) return;
  next();
});

/** GET /status: can the editor offer the AI helper right now, and if not, why not. */
router.get('/status', async (req: Request, res: Response): Promise<void> => {
  const s = await new OllamaClient().getStatus();
  const available = s.enabled && s.reachable && s.modelPresent;
  res.json({ enabled: s.enabled, available, model: s.model, canUse: canRoleWrite(req.tenantRole), ...(available ? {} : { reason: s.reason ?? 'The AI helper is not available.' }) });
});

function findControl(controlId: string): FrameworkControlDefinition | null {
  for (const fw of frameworksDefiningControl(controlId)) {
    // NIST SP 800-53 has several baselines with different control sets
    for (const baseline of fw === 'NIST_800_53_REV5' ? (['MOD_MOD_MOD', 'LOW_LOW_LOW', 'LOW_LOW_MOD'] as const) : ([undefined] as const)) {
      const hit = getFrameworkControls(fw as ComplianceFramework, baseline).find((c) => c.id.toUpperCase() === controlId.toUpperCase());
      if (hit) return hit;
    }
  }
  return null;
}

type Parsed = { ok: true; request: WordingRequest } | { ok: false; status: number; error: string };

function parseRequest(body: unknown, control: FrameworkControlDefinition): Parsed {
  const b = (body ?? {}) as Record<string, unknown>;
  const modes = [b.parameterId !== undefined, b.parameter !== undefined, b.sentence !== undefined].filter(Boolean).length;
  if (modes !== 1) return { ok: false, status: 400, error: 'Send exactly one of: parameterId, parameter, sentence' };
  const ctl = { id: control.id, title: control.title, requirement: [control.plainEnglishSummary, control.discussion].filter(Boolean).join(' ') };

  if (b.sentence !== undefined) {
    if (typeof b.sentence !== 'string' || !b.sentence.trim() || b.sentence.length > MAX_SENTENCE) return { ok: false, status: 400, error: `sentence must be text of at most ${MAX_SENTENCE} characters` };
    const spans = findVagueWording(b.sentence);
    if (spans.length === 0) return { ok: false, status: 400, error: 'That sentence has no vague wording to replace.' };
    return { ok: true, request: { mode: 'SENTENCE', control: ctl, sentence: b.sentence.trim(), terms: [...new Set(spans.flatMap((s) => s.terms))] } };
  }

  if (b.parameterId !== undefined) {
    if (typeof b.parameterId !== 'string') return { ok: false, status: 400, error: 'parameterId must be text' };
    const found = resolveParameters(control).find((p) => p.id === b.parameterId);
    if (!found) return { ok: false, status: 400, error: 'This control has no such parameter.' };
    return { ok: true, request: { mode: 'PARAMETER', control: ctl, parameter: found } };
  }

  // A parameter found as a tag in the person's own narrative: not in the catalog, so it is validated strictly here
  const p = b.parameter as Partial<ControlParameter> | null;
  if (!p || typeof p !== 'object') return { ok: false, status: 400, error: 'parameter must be an object' };
  if ((p.kind !== 'ASSIGNMENT' && p.kind !== 'SELECTION') || typeof p.prompt !== 'string' || !p.prompt.trim() || p.prompt.length > 300) return { ok: false, status: 400, error: 'parameter needs a kind (ASSIGNMENT or SELECTION) and a prompt of at most 300 characters' };
  if (p.kind === 'SELECTION') {
    const choices = p.choices;
    if (!Array.isArray(choices) || choices.length === 0 || choices.length > MAX_CHOICES || choices.some((c) => typeof c !== 'string' || !c.trim() || c.length > MAX_CHOICE_CHARS)) return { ok: false, status: 400, error: `a Selection needs 1 to ${MAX_CHOICES} choices of at most ${MAX_CHOICE_CHARS} characters` };
  }
  return {
    ok: true,
    request: {
      mode: 'PARAMETER',
      control: ctl,
      parameter: {
        kind: p.kind,
        label: typeof p.label === 'string' ? p.label.slice(0, 100) : 'parameter',
        prompt: p.prompt.trim(),
        choices: p.kind === 'SELECTION' ? (p.choices as string[]).map((c) => c.trim()) : undefined,
        selectionMode: p.selectionMode === 'ONE_OR_MORE' ? 'ONE_OR_MORE' : 'ONE',
      },
    },
  };
}

/**
 * POST /parameter-wording
 * Body: { controlId, and exactly one of: parameterId (a catalog / registry parameter of that control), parameter (a tag found
 * in the narrative: { kind, label?, prompt, choices?, selectionMode? }), sentence (a narrative sentence with vague wording) }.
 * Responds { mode, options: [{ text, note }], model, promptVersion, rejected }. `options` may be empty: the model's answers
 * did not pass the checks (see ssp/parameterWording.ts); that is a normal result, not an error.
 */
router.post('/parameter-wording', async (req: Request, res: Response): Promise<void> => {
  const controlId = (req.body ?? {}).controlId;
  if (typeof controlId !== 'string' || !CONTROL_ID.test(controlId)) {
    res.status(400).json({ error: 'controlId is required' });
    return;
  }
  if (!(await ensureControlInProgram(req, res, controlId))) return;
  const control = findControl(controlId);
  if (!control) {
    res.status(404).json({ error: 'Unknown control' });
    return;
  }
  const parsed = parseRequest(req.body, control);
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error });
    return;
  }
  if (throttled(`${req.tenantId}:${req.user?.uid ?? 'anon'}`)) {
    res.setHeader('Retry-After', String(WINDOW_MS / 1000));
    res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    return;
  }

  // Stop the model's work if the person closes the page
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    const client = new OllamaClient();
    await client.ensureReady();
    res.json(await suggestWording(client, parsed.request, abort.signal));
  } catch (err: unknown) {
    if (res.headersSent) return;
    if (err instanceof OllamaError) {
      if (err.code === 'cancelled') return;
      if (err.code === 'timeout') res.status(504).json({ error: 'The model took too long. Try again.', code: 'ai_timeout' });
      else if (err.code === 'bad_response' || err.code === 'truncated') res.status(502).json({ error: 'The model did not give a usable answer. Try again.', code: 'ai_bad_answer' });
      else res.status(503).json({ error: `The AI helper is not available: ${err.message}`, code: 'ai_unavailable' });
      return;
    }
    if (err instanceof WordingError) {
      res.status(502).json({ error: 'The model did not give a usable answer. Try again.', code: 'ai_bad_answer' });
      return;
    }
    console.error('[AI Assist] parameter-wording failed:', errorMessage(err));
    res.status(500).json({ error: 'The AI helper failed.' });
  }
});

export default router;
