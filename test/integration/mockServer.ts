import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  /** Parsed JSON body; undefined for an empty or non-JSON body. */
  body: Record<string, unknown> | undefined;
}

/** The tag only a Next Edit prompt's user message contains. */
export const NEXT_EDIT_TAG = '<|code_to_edit|>';

/** The user message of a chat request, or '' for any other request. */
export function userMessage(body: Record<string, unknown> | undefined): string {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return '';
  const user = (messages as { role?: unknown; content?: unknown }[]).find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

export interface MockServer {
  baseUrl: string;
  /** Every request received since the last reset, in arrival order. */
  requests: RecordedRequest[];
  reset(): void;
  /** Changes what later Next Edit prompts get; a request already received keeps the answer it arrived to. */
  setNextEdit(nextEdit: MockOptions['nextEdit']): void;
  close(): Promise<void>;
}

export interface MockOptions {
  /** The model name `/props` and `/v1/models` report; default `qwen2.5-coder-1.5b`. */
  alias?: string;
  /** The context window `/props` reports as `default_generation_settings.n_ctx`; left out when not set. */
  nCtx?: number;
  /** Delays every answer by this many milliseconds (the request is recorded when it arrives). */
  delayMs?: number;
  /**
   * What `POST /v1/chat/completions` streams; default content `['<COMPLETION>a + b;']` (real servers drop the stop string) and finish `stop`.
   * `stallMs` waits that long after the reasoning before the content, like a model that keeps thinking.
   * `reasoningUnlessBody` skips the reasoning when the request body has all of those fields (a thinking switch that works).
   */
  chat?: { reasoning?: string[]; reasoningUnlessBody?: Record<string, unknown>; content?: string[]; finish?: string; stallMs?: number };
  /** `POST /infill` answers 501 and `POST /completion` streams `a + b;`. */
  infill501?: boolean;
  /** `POST /v1/chat/completions` answers 400 "Unrecognized request argument supplied: <field>" while the body has that field. */
  rejectField?: string;
  /** `POST /infill` answers 404 with this body (a string) instead of streaming. */
  infill404Body?: string;
  /**
   * What `POST /v1/chat/completions` streams for a Next Edit prompt (the user message contains `<|code_to_edit|>`), with finish `stop`,
   * instead of the `chat` answer. `delayMs` delays only these answers (the request is recorded when it arrives).
   */
  nextEdit?: { content: string[]; delayMs?: number };
  /**
   * A raw Next Edit answer, ending with a normal stop: `POST /completion` streams it as llama.cpp events when the prompt
   * contains `<|file_sep|>updated/` (Sweep), `POST /v1/completions` as OpenAI events when it contains `<[fim-middle]>` (Zeta).
   */
  nextEditRaw?: { content: string[] };
}

/** What only a Sweep Next Edit prompt contains. */
export const SWEEP_TAG = '<|file_sep|>updated/';
/** What only a Zeta Next Edit prompt contains. */
export const ZETA_TAG = '<[fim-middle]>';

/** A stand-in llama.cpp server on 127.0.0.1 with an ephemeral port. It also answers `GET /v1/models` like an OpenAI-compatible server. */
export async function startMockServer(o: MockOptions = {}): Promise<MockServer> {
  const alias = o.alias ?? 'qwen2.5-coder-1.5b';
  const props = { model_alias: alias, ...(o.nCtx !== undefined ? { default_generation_settings: { n_ctx: o.nCtx } } : {}) };
  const requests: RecordedRequest[] = [];
  let nextEdit = o.nextEdit;
  const delta = (d: Record<string, unknown>, finish: string | null = null): string => `data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: finish }] })}\n\n`;
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
        } else if (path === '/completion' && o.nextEditRaw !== undefined && typeof body?.prompt === 'string' && body.prompt.includes(SWEEP_TAG)) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const c of o.nextEditRaw.content) res.write(`data: ${JSON.stringify({ content: c })}\n\n`);
          res.end(`data: ${JSON.stringify({ content: '', stop: true, stop_type: 'eos' })}\n\n`);
        } else if (path === '/v1/completions' && req.method === 'POST' && o.nextEditRaw !== undefined && typeof body?.prompt === 'string' && body.prompt.includes(ZETA_TAG)) {
          const text = (t: string, finish: string | null = null): string => `data: ${JSON.stringify({ choices: [{ text: t, finish_reason: finish }] })}\n\n`;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const c of o.nextEditRaw.content) res.write(text(c));
          res.write(text('', 'stop'));
          res.end('data: [DONE]\n\n');
        } else if (path === '/completion' && o.infill501) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ content: 'a + b;' })}\n\n`);
          res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
        } else if (path === '/v1/chat/completions' && req.method === 'POST') {
          if (o.rejectField !== undefined && body !== undefined && o.rejectField in body) {
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `Unrecognized request argument supplied: ${o.rejectField}` } }));
          } else if (nextEdit !== undefined && userMessage(body).includes(NEXT_EDIT_TAG)) {
            const { content, delayMs } = nextEdit;
            const send = (): void => {
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              for (const c of content) res.write(delta({ content: c }));
              res.write(delta({}, 'stop'));
              res.end('data: [DONE]\n\n');
            };
            // A client that gave up meanwhile gets no answer.
            if (delayMs) setTimeout(() => (res.socket && !res.socket.destroyed ? send() : undefined), delayMs);
            else send();
          } else {
            const chat = o.chat ?? {};
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const switchedOff = chat.reasoningUnlessBody !== undefined && body !== undefined && Object.entries(chat.reasoningUnlessBody).every(([k, v]) => body[k] === v);
            if (!switchedOff) for (const r of chat.reasoning ?? []) res.write(delta({ reasoning_content: r }));
            const rest = (): void => {
              for (const c of chat.content ?? ['<COMPLETION>a + b;']) res.write(delta({ content: c }));
              res.write(delta({}, chat.finish ?? 'stop'));
              res.end('data: [DONE]\n\n');
            };
            // A client that gave up meanwhile gets nothing more.
            if (chat.stallMs) setTimeout(() => (res.socket && !res.socket.destroyed ? rest() : undefined), chat.stallMs);
            else rest();
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
    setNextEdit: (ne) => {
      nextEdit = ne;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
