import http from 'http';
import type { AddressInfo } from 'net';

/**
 * A stand-in for a local Ollama server, so the AI pipeline is tested without a GPU or a model. It speaks the two endpoints
 * the client uses: GET /api/tags and POST /api/chat.
 */
export interface FakeChatRequest {
  model: string;
  system: string;
  user: string;
  format: Record<string, any>;
  options: Record<string, any>;
}

export interface FakeOllama {
  url: string;
  port: number;
  /** Every chat request received, oldest first. */
  chats: FakeChatRequest[];
  /** Installed model names reported by /api/tags (change it between tests). */
  models: string[];
  /** Replaces the chat handler. Return the reply object; throw to answer HTTP 500; return { __raw } for a raw string. */
  onChat: (req: FakeChatRequest) => unknown | Promise<unknown>;
  /** Make the next N chat requests fail with HTTP 500. */
  failNext: number;
  /** Delay every chat reply, in ms. */
  delayMs: number;
  /** Every request received, as "METHOD /path", oldest first. */
  hits: string[];
  /** When set, every request is answered with a redirect to this origin (same path). */
  redirectTo: string | null;
  /** Status of that redirect. */
  redirectStatus: number;
  close: () => Promise<void>;
}

export async function startFakeOllama(models: string[] = ['llama3.2:3b']): Promise<FakeOllama> {
  const fake: FakeOllama = {
    url: '',
    port: 0,
    chats: [],
    models,
    onChat: () => ({}),
    failNext: 0,
    delayMs: 0,
    hits: [],
    redirectTo: null,
    redirectStatus: 307,
    close: () => Promise.resolve(),
  };

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    fake.hits.push(`${req.method} ${req.url}`);
    if (fake.redirectTo) {
      res.writeHead(fake.redirectStatus, { Location: fake.redirectTo + (req.url ?? '/') });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/api/tags') {
      send(200, { models: fake.models.map((name) => ({ name, model: name })) });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw);
          const messages = body.messages as Array<{ role: string; content: string }>;
          const chat: FakeChatRequest = {
            model: body.model,
            system: messages.find((m) => m.role === 'system')?.content ?? '',
            user: messages.find((m) => m.role === 'user')?.content ?? '',
            format: body.format,
            options: body.options ?? {},
          };
          fake.chats.push(chat);
          if (!fake.models.some((m) => m === chat.model)) {
            send(404, { error: `model '${chat.model}' not found` });
            return;
          }
          if (fake.failNext > 0) {
            fake.failNext--;
            send(500, { error: 'boom' });
            return;
          }
          if (fake.delayMs) await new Promise((r) => setTimeout(r, fake.delayMs));
          const reply = (await fake.onChat(chat)) as { __raw?: string; __truncated?: boolean } | unknown;
          const r = reply as { __raw?: string; __truncated?: boolean };
          send(200, {
            model: chat.model,
            message: { role: 'assistant', content: r && typeof r === 'object' && '__raw' in r ? r.__raw : JSON.stringify(reply) },
            done: true,
            done_reason: r && typeof r === 'object' && r.__truncated ? 'length' : 'stop',
            prompt_eval_count: 100,
            eval_count: 50,
          });
        } catch (err) {
          send(500, { error: String(err) });
        }
      });
      return;
    }
    send(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.url = `http://127.0.0.1:${fake.port}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}
