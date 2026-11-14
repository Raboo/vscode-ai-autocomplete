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
      if (path === '/props') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(props));
      } else if (path === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: alias, object: 'model' }] }));
      } else if (path === '/infill') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ content: 'a + b;' })}\n\n`);
        res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
      } else {
        res.writeHead(404).end();
      }
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
