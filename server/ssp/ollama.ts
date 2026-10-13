/**
 * Client for a LOCAL Ollama instance (https://github.com/ollama/ollama), used to read System Security Plans with a model such
 * as Llama 3.1 8B. Nothing here can reach the internet: the base URL comes from server configuration only, and a host that
 * is not on this machine or a private network is refused unless an operator explicitly allows it.
 *
 *   SSP_AI_ENABLED=true            turn the AI analysis on (off by default: imports then use the rule-based mapping)
 *   OLLAMA_BASE_URL                default http://127.0.0.1:11434 ; in Docker http://ollama:11434 or
 *                                  http://host.docker.internal:11434 for an Ollama running on the host
 *   OLLAMA_MODEL                   default llama3.1:8b
 *   OLLAMA_NUM_CTX                 context window to request, default 8192
 *   OLLAMA_TIMEOUT_MS              per request, default 240000 (a first request also loads the model onto the GPU)
 *   OLLAMA_ALLOW_REMOTE=true       permit a base URL outside the local / private network (not recommended: SSPs contain CUI)
 *
 * The model is never pulled by this code: an air-gapped install loads it ahead of time (ollama pull / ollama create).
 */

export type OllamaErrorCode = 'disabled' | 'blocked_host' | 'unreachable' | 'model_missing' | 'timeout' | 'cancelled' | 'truncated' | 'bad_response';

export class OllamaError extends Error {
  constructor(public code: OllamaErrorCode, message: string) {
    super(message);
    this.name = 'OllamaError';
  }
}

export interface OllamaConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  numCtx: number;
  timeoutMs: number;
  allowRemote: boolean;
}

const bool = (v: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
const int = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Read on every call, so tests and operators can change the environment without restarting the module. */
export function getOllamaConfig(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
  return {
    enabled: bool(env.SSP_AI_ENABLED),
    baseUrl: (env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, ''),
    model: (env.OLLAMA_MODEL || 'llama3.1:8b').trim(),
    numCtx: int(env.OLLAMA_NUM_CTX, 8192, 2048, 131072),
    timeoutMs: int(env.OLLAMA_TIMEOUT_MS, 240_000, 5_000, 3_600_000),
    allowRemote: bool(env.OLLAMA_ALLOW_REMOTE),
  };
}

/**
 * Is this host on this machine or a private network? Loopback, RFC 1918, link-local, unique-local IPv6, and names that
 * cannot be public (a bare Docker service name such as "ollama", or *.local / *.internal / *.lan / *.localdomain).
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '::') return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.includes(':')) return /^(fc|fd|fe80)/.test(h);
  if (!h.includes('.')) return true; // a bare name: a Docker / LAN service, not a public host
  return /\.(local|internal|lan|localdomain|home\.arpa)$/.test(h);
}

export function assertAllowedBaseUrl(config: Pick<OllamaConfig, 'baseUrl' | 'allowRemote'>): URL {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new OllamaError('blocked_host', `OLLAMA_BASE_URL is not a valid URL: ${config.baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OllamaError('blocked_host', 'OLLAMA_BASE_URL must be an http(s) URL.');
  if (url.username || url.password) throw new OllamaError('blocked_host', 'OLLAMA_BASE_URL must not contain credentials.');
  if (!config.allowRemote && !isLocalHost(url.hostname)) {
    throw new OllamaError(
      'blocked_host',
      `Refusing to send documents to ${url.hostname}: it is not on this machine or a private network. Set OLLAMA_ALLOW_REMOTE=true only if you accept that.`
    );
  }
  return url;
}

export interface OllamaStatus {
  enabled: boolean;
  reachable: boolean;
  modelPresent: boolean;
  model: string;
  baseUrl: string;
  installedModels: string[];
  /** Why the AI analysis cannot be used right now (absent when it can). */
  reason?: string;
  code?: OllamaErrorCode;
}

export interface ChatRequest {
  system: string;
  user: string;
  /** JSON Schema the reply must follow (Ollama structured outputs). */
  schema: Record<string, unknown>;
  /** Cap on the reply length, in tokens. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  data: unknown;
  raw: string;
  promptTokens: number | null;
  replyTokens: number | null;
  durationMs: number;
}

// One request at a time: the GPU is the bottleneck, and parallel requests would only fight over it
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const STATUS_TTL_MS = 10_000;
const STATUS_TIMEOUT_MS = 4_000;
let statusCache: { key: string; at: number; value: OllamaStatus } | null = null;

/** Test hook. */
export function __resetOllamaCacheForTests(): void {
  statusCache = null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function combine(signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => Boolean(s)));
}

/** Does the installed list contain the configured model? "llama3.1" means "llama3.1:latest", as in Ollama itself. */
export function hasModel(installed: string[], wanted: string): boolean {
  const w = wanted.includes(':') ? wanted : `${wanted}:latest`;
  return installed.some((m) => m === w || m === wanted);
}

export class OllamaClient {
  readonly config: OllamaConfig;

  constructor(config: OllamaConfig = getOllamaConfig()) {
    this.config = config;
  }

  private url(pathname: string): string {
    const base = assertAllowedBaseUrl(this.config); // throws for a host that is not local
    return `${base.origin}${base.pathname.replace(/\/+$/, '')}${pathname}`;
  }

  /**
   * Is the AI analysis usable right now: switched on, Ollama reachable, and the configured model installed? Never throws.
   * Cached for a few seconds so a page that asks repeatedly does not hit Ollama each time.
   */
  async getStatus(force = false): Promise<OllamaStatus> {
    const { config } = this;
    const base: OllamaStatus = { enabled: config.enabled, reachable: false, modelPresent: false, model: config.model, baseUrl: config.baseUrl, installedModels: [] };
    if (!config.enabled) return { ...base, reason: 'The AI analysis is switched off on this server (SSP_AI_ENABLED).', code: 'disabled' };

    const key = `${config.baseUrl}|${config.model}`;
    if (!force && statusCache && statusCache.key === key && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;

    let value: OllamaStatus;
    try {
      const res = await fetch(this.url('/api/tags'), { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      if (!res.ok) throw new OllamaError('unreachable', `Ollama answered ${res.status}.`);
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const installed = (body.models ?? []).map((m) => String(m.name ?? m.model ?? '')).filter(Boolean);
      const present = hasModel(installed, config.model);
      value = {
        ...base,
        reachable: true,
        modelPresent: present,
        installedModels: installed,
        ...(present
          ? {}
          : {
              reason: `The model "${config.model}" is not installed on the Ollama server${installed.length ? ` (installed: ${installed.join(', ')})` : ''}. Load it first, for example: ollama pull ${config.model}`,
              code: 'model_missing' as const,
            }),
      };
    } catch (err: unknown) {
      const e = err instanceof OllamaError ? err : null;
      value = {
        ...base,
        reason: e ? e.message : `Cannot reach Ollama at ${config.baseUrl}.`,
        code: e?.code ?? 'unreachable',
      };
    }
    statusCache = { key, at: Date.now(), value };
    return value;
  }

  /** Throws unless the analysis can run: checked before a job starts, never in the middle of one. */
  async ensureReady(): Promise<void> {
    const s = await this.getStatus(true);
    if (!s.enabled) throw new OllamaError('disabled', s.reason ?? 'The AI analysis is switched off.');
    if (!s.reachable) throw new OllamaError(s.code ?? 'unreachable', s.reason ?? 'Ollama is not reachable.');
    if (!s.modelPresent) throw new OllamaError('model_missing', s.reason ?? 'The model is not installed.');
  }

  /** One structured-output chat completion. The reply is parsed JSON; the caller validates its shape. */
  chatJson(req: ChatRequest): Promise<ChatResult> {
    return serialize(async () => {
      const { config } = this;
      const body = JSON.stringify({
        model: config.model,
        stream: false,
        format: req.schema,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        options: { temperature: 0, seed: 7, num_ctx: config.numCtx, ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
        keep_alive: '15m',
      });
      const endpoint = this.url('/api/chat');

      for (let attempt = 0; ; attempt++) {
        if (req.signal?.aborted) throw new OllamaError('cancelled', 'The analysis was cancelled.');
        const started = Date.now();
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: combine([req.signal, AbortSignal.timeout(config.timeoutMs)]),
          });
          if (res.status === 404) {
            statusCache = null;
            throw new OllamaError('model_missing', `Ollama does not have the model "${config.model}" (HTTP 404).`);
          }
          if (res.status >= 500 && attempt === 0) {
            await sleep(1000);
            continue;
          }
          if (!res.ok) throw new OllamaError('bad_response', `Ollama answered ${res.status}.`);

          const payload = (await res.json()) as {
            message?: { content?: string };
            done_reason?: string;
            prompt_eval_count?: number;
            eval_count?: number;
          };
          const raw = payload.message?.content ?? '';
          if (payload.done_reason === 'length') throw new OllamaError('truncated', 'The model ran out of room before finishing its answer.');
          let data: unknown;
          try {
            data = JSON.parse(raw);
          } catch {
            const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
            try {
              data = JSON.parse(fenced ? fenced[1] : raw);
            } catch {
              throw new OllamaError('bad_response', 'The model did not answer with valid JSON.');
            }
          }
          return { data, raw, promptTokens: payload.prompt_eval_count ?? null, replyTokens: payload.eval_count ?? null, durationMs: Date.now() - started };
        } catch (err: unknown) {
          if (err instanceof OllamaError) throw err;
          if (req.signal?.aborted) throw new OllamaError('cancelled', 'The analysis was cancelled.');
          const name = (err as { name?: string })?.name;
          if (name === 'TimeoutError' || name === 'AbortError') throw new OllamaError('timeout', `Ollama did not answer within ${Math.round(config.timeoutMs / 1000)} s.`);
          if (attempt === 0) {
            await sleep(1000);
            continue;
          }
          throw new OllamaError('unreachable', `Cannot reach Ollama at ${config.baseUrl}.`);
        }
      }
    });
  }
}
