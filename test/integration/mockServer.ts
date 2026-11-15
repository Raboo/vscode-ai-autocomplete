import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  /** Parsed JSON body; undefined for an empty or non-JSON body. */
  body: Record<string, unknown> | undefined;
}

export interface MockServer {
  baseUrl: string;
  /** Every request received since the last reset, in arrival order. */
  requests: RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
}

export interface MockOptions {
  /** The model name `/props` and `/v1/models` report; default `qwen2.5-coder-1.5b`. */
  alias?: string;
  /** The context window `/props` reports as `default_generation_settings.n_ctx`; left out when not set. */
  nCtx?: number;
  /** Delays every answer by this many milliseconds (the request is recorded when it arrives). */
  delayMs?: number;
  /** What `POST /v1/chat/completions` streams; default content `['<COMPLETION>a + b;']` (real servers drop the stop string) and finish `stop`. */
  chat?: { reasoning?: string[]; content?: string[]; finish?: string };
  /** `POST /infill` answers 501 and `POST /completion` streams `a + b;`. */
  infill501?: boolean;
  /** `POST /v1/chat/completions` answers 400 "Unrecognized request argument supplied: <field>" while the body has that field. */
  rejectField?: string;
  /** `POST /infill` answers 404 with this body (a string) instead of streaming. */
  infill404Body?: string;
}

/** A stand-in llama.cpp server on 127.0.0.1 with an ephemeral port. It also answers `GET /v1/models` like an OpenAI-compatible server. */
export async function startMockServer(o: MockOptions = {}): Promise<MockServer> {
  const alias = o.alias ?? 'qwen2.5-coder-1.5b';
  const props = { model_alias: alias, ...(o.nCtx !== undefined ? { default_generation_settings: { n_ctx: o.nCtx } } : {}) };
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> | undefined;
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      } catch {
        body = undefined;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      requests.push({ method: req.method ?? '', path, body });
      const answer = (): void => {
        if (path === '/props') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(props));
        } else if (path === '/v1/models' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: alias, object: 'model' }] }));
        } else if (path === '/infill' && o.infill404Body !== undefined) {
          res.writeHead(404, { 'content-type': 'application/json' }).end(o.infill404Body);
        } else if (path === '/infill' && o.infill501) {
          res.writeHead(501, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Infill is not supported by this model' } }));
        } else if (path === '/completion' && o.infill501) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ content: 'a + b;' })}\n\n`);
          res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
        } else if (path === '/v1/chat/completions' && req.method === 'POST') {
          if (o.rejectField !== undefined && body !== undefined && o.rejectField in body) {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `Unrecognized request argument supplied: ${o.rejectField}` } }));
          } else {
            const chat = o.chat ?? {};
            const delta = (d: Record<string, unknown>, finish: string | null = null): string => `data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: finish }] })}\n\n`;
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const r of chat.reasoning ?? []) res.write(delta({ reasoning_content: r }));
            for (const c of chat.content ?? ['<COMPLETION>a + b;']) res.write(delta({ content: c }));
            res.write(delta({}, chat.finish ?? 'stop'));
            res.end('data: [DONE]\n\n');
          }
        } else if (path === '/infill') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ content: 'a + b;' })}\n\n`);
          res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
        } else {
          res.writeHead(404).end();
        }
      };
      if (!o.delayMs) answer();
      // A client that gave up meanwhile gets no answer.
      else setTimeout(() => (res.socket && !res.socket.destroyed ? answer() : undefined), o.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    reset: () => void requests.splice(0),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
