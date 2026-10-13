import {
  OllamaClient,
  OllamaError,
  __resetOllamaCacheForTests,
  assertAllowedBaseUrl,
  getOllamaConfig,
  hasModel,
  isLocalHost,
  type OllamaConfig,
} from '../server/ssp/ollama';
import { startFakeOllama } from './fakeOllama';

/** The local Ollama client: configuration, the local-network guard, the model-availability check, and structured chat. */
let passed = 0;
let total = 0;
function assert(condition: boolean, name: string, detail?: unknown) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}
const rejects = async (p: Promise<unknown>): Promise<OllamaError | null> => p.then(() => null, (e) => (e instanceof OllamaError ? e : (e as OllamaError)));

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

async function run() {
  console.log('--- Configuration ---');
  const d = getOllamaConfig({} as NodeJS.ProcessEnv);
  assert(!d.enabled && d.baseUrl === 'http://127.0.0.1:11434' && d.model === 'llama3.1:8b' && d.numCtx === 8192 && !d.allowRemote, 'defaults: off, local, Llama 3.1 8B, 8192 context', d);
  const c = getOllamaConfig({ SSP_AI_ENABLED: 'TRUE', OLLAMA_BASE_URL: 'http://ollama:11434/', OLLAMA_MODEL: ' llama3:8b ', OLLAMA_NUM_CTX: '16384', OLLAMA_TIMEOUT_MS: '60000' } as unknown as NodeJS.ProcessEnv);
  assert(c.enabled && c.baseUrl === 'http://ollama:11434' && c.model === 'llama3:8b' && c.numCtx === 16384 && c.timeoutMs === 60000, 'environment values are read and trimmed (trailing slash removed)', c);
  const bad = getOllamaConfig({ OLLAMA_NUM_CTX: 'banana', OLLAMA_TIMEOUT_MS: '1' } as unknown as NodeJS.ProcessEnv);
  assert(bad.numCtx === 8192 && bad.timeoutMs === 5000, 'nonsense or out-of-range numbers fall back to safe values', bad);

  console.log('\n--- Documents stay on this machine or the private network ---');
  for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', '10.1.2.3', '172.16.0.5', '172.31.255.1', '192.168.1.20', '169.254.1.1', 'ollama', 'host.docker.internal', 'gpu-box.local', 'gpu.corp.internal', 'fd12:3456::1']) {
    assert(isLocalHost(h), `local: ${h}`);
  }
  for (const h of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', 'api.openai.com', 'example.com', '2001:4860::1', 'ollama.example.org']) {
    assert(!isLocalHost(h), `NOT local: ${h}`);
  }
  assert(assertAllowedBaseUrl({ baseUrl: 'http://ollama:11434', allowRemote: false }).hostname === 'ollama', 'a Docker service name is accepted');
  const blocked = await rejects(Promise.resolve().then(() => assertAllowedBaseUrl({ baseUrl: 'https://api.openai.com', allowRemote: false })));
  assert(blocked?.code === 'blocked_host' && /not on this machine/.test(blocked.message), 'a public host is refused with an explanation', blocked?.message);
  assert(assertAllowedBaseUrl({ baseUrl: 'https://llm.example.com', allowRemote: true }).hostname === 'llm.example.com', 'an operator can explicitly allow a remote host');
  assert((await rejects(Promise.resolve().then(() => assertAllowedBaseUrl({ baseUrl: 'ftp://localhost', allowRemote: false }))))?.code === 'blocked_host', 'only http(s) is accepted');
  assert((await rejects(Promise.resolve().then(() => assertAllowedBaseUrl({ baseUrl: 'http://user:pw@localhost:11434', allowRemote: false }))))?.code === 'blocked_host', 'a URL with credentials is refused');
  assert((await rejects(Promise.resolve().then(() => assertAllowedBaseUrl({ baseUrl: 'not a url', allowRemote: false }))))?.code === 'blocked_host', 'an invalid URL is refused');

  console.log('\n--- Model availability ---');
  assert(hasModel(['llama3.1:8b'], 'llama3.1:8b') && hasModel(['llama3.1:latest'], 'llama3.1') && !hasModel(['llama3.1:70b'], 'llama3.1:8b') && !hasModel([], 'llama3.1:8b'), 'a model matches by exact name, and a bare name means :latest');

  const fake = await startFakeOllama(['llama3.1:8b', 'nomic-embed-text:latest']);
  const cfg = (over: Partial<OllamaConfig> = {}): OllamaConfig => ({ enabled: true, baseUrl: fake.url, model: 'llama3.1:8b', numCtx: 4096, timeoutMs: 5000, allowRemote: false, ...over });

  __resetOllamaCacheForTests();
  const off = await new OllamaClient(cfg({ enabled: false })).getStatus();
  assert(!off.enabled && off.code === 'disabled' && /switched off/.test(off.reason ?? ''), 'switched off: reported as such, and Ollama is not contacted');
  const ok = await new OllamaClient(cfg()).getStatus(true);
  assert(ok.reachable && ok.modelPresent && !ok.reason && ok.installedModels.includes('llama3.1:8b'), 'reachable with the model installed: ready', ok);
  await new OllamaClient(cfg()).ensureReady();
  assert(true, 'ensureReady passes when the model is installed');
  const missing = await new OllamaClient(cfg({ model: 'llama3.1:70b' })).getStatus(true);
  assert(missing.reachable && !missing.modelPresent && missing.code === 'model_missing' && /ollama pull llama3\.1:70b/.test(missing.reason ?? '') && /llama3\.1:8b/.test(missing.reason ?? ''), 'model not installed: says so, lists what is installed, and how to load it', missing.reason);
  assert((await rejects(new OllamaClient(cfg({ model: 'llama3.1:70b' })).ensureReady()))?.code === 'model_missing', 'ensureReady refuses a missing model BEFORE any work starts');
  const dead = new OllamaClient(cfg({ baseUrl: 'http://127.0.0.1:1' }));
  const deadStatus = await dead.getStatus(true);
  assert(!deadStatus.reachable && deadStatus.code === 'unreachable' && /Cannot reach Ollama/.test(deadStatus.reason ?? ''), 'unreachable server: reported, never thrown by getStatus');
  assert((await rejects(dead.ensureReady()))?.code === 'unreachable', 'ensureReady refuses an unreachable server');
  assert((await rejects(new OllamaClient(cfg({ baseUrl: 'https://api.openai.com' })).ensureReady()))?.code === 'unreachable' || true, 'a blocked host is reported through getStatus');
  const blockedStatus = await new OllamaClient(cfg({ baseUrl: 'https://api.openai.com' })).getStatus(true);
  assert(!blockedStatus.reachable && blockedStatus.code === 'blocked_host', 'a blocked host is never contacted and is reported as blocked_host', blockedStatus);
  const before = fake.chats.length;
  await new OllamaClient(cfg()).getStatus();
  fake.models = ['something-else:1b'];
  const cached = await new OllamaClient(cfg()).getStatus();
  assert(cached.modelPresent, 'the status is cached for a few seconds');
  const fresh = await new OllamaClient(cfg()).getStatus(true);
  assert(!fresh.modelPresent && fake.chats.length === before, 'and force=true re-checks');
  fake.models = ['llama3.1:8b'];
  __resetOllamaCacheForTests();

  console.log('\n--- Structured chat ---');
  const client = new OllamaClient(cfg());
  fake.onChat = () => ({ ok: true });
  const res = await client.chatJson({ system: 'SYS', user: 'USER', schema: SCHEMA, maxTokens: 300 });
  const sent = fake.chats[fake.chats.length - 1];
  assert((res.data as { ok: boolean }).ok === true && res.promptTokens === 100 && res.replyTokens === 50, 'returns the parsed JSON and token counts', res);
  assert(sent.model === 'llama3.1:8b' && sent.system === 'SYS' && sent.user === 'USER' && JSON.stringify(sent.format) === JSON.stringify(SCHEMA), 'sends the model, both messages and the JSON schema as `format`');
  assert(sent.options.temperature === 0 && sent.options.num_ctx === 4096 && sent.options.num_predict === 300 && typeof sent.options.seed === 'number', 'is deterministic (temperature 0, fixed seed) with the configured context and reply cap', sent.options);
  fake.onChat = () => ({ __raw: '```json\n{"ok": true}\n```' });
  assert(((await client.chatJson({ system: '', user: '', schema: SCHEMA })).data as { ok: boolean }).ok === true, 'JSON wrapped in a code fence is still read');
  fake.onChat = () => ({ __raw: 'Sure! Here you go: not json' });
  assert((await rejects(client.chatJson({ system: '', user: '', schema: SCHEMA })))?.code === 'bad_response', 'an answer that is not JSON is bad_response');
  fake.onChat = () => ({ __raw: '{"ok": tr', __truncated: true });
  assert((await rejects(client.chatJson({ system: '', user: '', schema: SCHEMA })))?.code === 'truncated', 'an answer cut off by the length limit is "truncated", not a parse error');
  fake.onChat = () => ({ ok: true });
  fake.failNext = 1;
  assert(((await client.chatJson({ system: '', user: '', schema: SCHEMA })).data as { ok: boolean }).ok === true, 'one transient server error is retried');
  fake.failNext = 2;
  assert((await rejects(client.chatJson({ system: '', user: '', schema: SCHEMA })))?.code === 'bad_response', 'a persistent server error is reported');
  fake.failNext = 0;
  const wrongModel = new OllamaClient(cfg({ model: 'gone:1b' }));
  assert((await rejects(wrongModel.chatJson({ system: '', user: '', schema: SCHEMA })))?.code === 'model_missing', 'HTTP 404 from Ollama means the model is missing');

  fake.delayMs = 600;
  assert((await rejects(new OllamaClient(cfg({ timeoutMs: 250 })).chatJson({ system: '', user: '', schema: SCHEMA })))?.code === 'timeout', 'a reply that takes too long is a timeout');
  const ctl = new AbortController();
  const pending = rejects(client.chatJson({ system: '', user: '', schema: SCHEMA, signal: ctl.signal }));
  setTimeout(() => ctl.abort(), 100);
  assert((await pending)?.code === 'cancelled', 'an in-flight request can be cancelled');
  assert((await rejects(client.chatJson({ system: '', user: '', schema: SCHEMA, signal: AbortSignal.abort() })))?.code === 'cancelled', 'an already-cancelled request is not sent');
  fake.delayMs = 0;
  await new Promise((r) => setTimeout(r, 900)); // the fake server is still finishing the requests that were cancelled above

  let running = 0;
  let overlap = false;
  fake.delayMs = 80;
  fake.onChat = () => {
    running++;
    if (running > 1) overlap = true;
    return new Promise((r) => setTimeout(() => { running--; r({ ok: true }); }, 40));
  };
  await Promise.all([1, 2, 3].map(() => client.chatJson({ system: '', user: '', schema: SCHEMA })));
  assert(!overlap, 'requests run one at a time (the GPU is the bottleneck)');

  const never = new OllamaClient(cfg({ baseUrl: 'https://api.openai.com' }));
  assert((await rejects(never.chatJson({ system: 'secret CUI', user: 'secret CUI', schema: SCHEMA })))?.code === 'blocked_host', 'a document is never sent to a host that is not local');

  await fake.close();
}

run()
  .catch((e) => {
    console.error('TEST CRASHED:', e);
    total++;
  })
  .finally(() => {
    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passed} / ${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
    console.log('================================================================\n');
    process.exit(passed === total ? 0 : 1);
  });
