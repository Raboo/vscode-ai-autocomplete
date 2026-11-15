import { afterEach, describe, expect, test, vi } from 'vitest';
import { chatBody, rejectedFields, streamOpenAiChat } from '../../src/backends/chat';
import { HttpError, StreamError } from '../../src/backends/http';
import type { ChatEvent, ChatRequest } from '../../src/backends/types';
import { startMockHttp, type MockResponse } from './helpers/mockHttp';

type Mock = Awaited<ReturnType<typeof startMockHttp>>;
let m: Mock;
afterEach(async () => {
  await m?.close();
});

const messages = [{ role: 'user' as const, content: 'hi' }];
const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'm',
  messages,
  maxTokens: 160,
  stop: ['</COMPLETION>'],
  sampling: { temperature: 0.2, topP: 0.8, topK: 20, presencePenalty: 0 },
  thinking: { chat_template_kwargs: { enable_thinking: false } },
  extraBody: {},
  signal: new AbortController().signal,
  timeoutMs: 5000,
  ...o,
});

async function run(r: ChatRequest, hosted = false): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of streamOpenAiChat(`${m.url}/v1/chat/completions`, {}, r, hosted)) out.push(e);
  return out;
}

const ok = (...chunks: string[]): MockResponse => ({ sse: [...chunks, '[DONE]'] });

describe('streamOpenAiChat', () => {
  test('posts the chat body and yields reasoning, content and finish events', async () => {
    m = await startMockHttp(() =>
      ok(
        '{"choices":[{"delta":{"reasoning_content":"hm"}}]}',
        '{"choices":[{"delta":{"content":"<COMPLETION>a"}}]}',
        '{"choices":[{"delta":{"content":" + b;"},"finish_reason":"stop"}]}',
      ),
    );
    expect(await run(req())).toEqual([
      { type: 'reasoning', text: 'hm' },
      { type: 'content', text: '<COMPLETION>a' },
      { type: 'content', text: ' + b;' },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(m.requests[0].body).toMatchObject({
      model: 'm', messages, max_tokens: 160, temperature: 0.2, top_p: 0.8, top_k: 20, presence_penalty: 0,
      stop: ['</COMPLETION>'], stream: true, chat_template_kwargs: { enable_thinking: false },
    });
  });

  test('reads reasoning, reasoning_details and Mistral thinking chunks', async () => {
    m = await startMockHttp(() =>
      ok(
        '{"choices":[{"delta":{"reasoning":"r1"}}]}',
        '{"choices":[{"delta":{"thinking":"hm"}}]}',
        '{"choices":[{"delta":{"reasoning_details":[{"text":"d1"},{"summary":"d2"}]}}]}',
        '{"choices":[{"delta":{"reasoning_details":[{"encrypted":"x"}]}}]}',
        '{"choices":[{"delta":{"reasoning_details":[]}}]}',
        '{"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"text":"t"}]},{"type":"text","text":"c"}]}}]}',
      ),
    );
    expect(await run(req())).toEqual([
      { type: 'reasoning', text: 'r1' },
      { type: 'reasoning', text: 'hm' },
      { type: 'reasoning', text: 'd1d2' },
      { type: 'reasoning', text: '…' },
      { type: 'reasoning', text: 't' },
      { type: 'content', text: 'c' },
    ]);
  });

  test('hosted drops top_k, keeps 4 stops; empty stop and unset sampling are not sent', async () => {
    m = await startMockHttp(() => ok());
    await run(req({ stop: ['1', '2', '3', '4', '5'] }), true);
    expect(m.requests[0].body.stop).toEqual(['1', '2', '3', '4']);
    expect('top_k' in m.requests[0].body).toBe(false);
    expect(chatBody(req({ stop: [], sampling: {}, thinking: {} }), false)).toEqual({ model: 'm', messages, max_tokens: 160, stream: true });
  });

  test('a 400 naming a field retries once without it and reports it', async () => {
    let n = 0;
    m = await startMockHttp(() => (n++ === 0 ? { status: 400, json: { error: { message: 'Unrecognized request argument supplied: chat_template_kwargs' } } } : ok('{"choices":[{"delta":{"content":"a"}}]}')));
    const onRejected = vi.fn();
    expect(await run(req({ onRejected }))).toEqual([{ type: 'content', text: 'a' }]);
    expect(m.requests).toHaveLength(2);
    expect('chat_template_kwargs' in m.requests[1].body).toBe(false);
    expect(m.requests[1].body.temperature).toBe(0.2);
    expect(onRejected).toHaveBeenCalledWith(['chat_template_kwargs']);
  });

  test('a 400 naming nothing retries without the thinking fields only', async () => {
    let n = 0;
    m = await startMockHttp(() => (n++ === 0 ? { status: 422, json: { error: 'bad' } } : ok()));
    const onRejected = vi.fn();
    await run(req({ onRejected }));
    expect('chat_template_kwargs' in m.requests[1].body).toBe(false);
    expect(m.requests[1].body.temperature).toBe(0.2);
    expect(onRejected).toHaveBeenCalledWith(['chat_template_kwargs']);
  });

  test('a 400 naming a sampling field drops that field', async () => {
    let n = 0;
    m = await startMockHttp(() => (n++ === 0 ? { status: 400, json: { error: 'unsupported parameter: top_k' } } : ok()));
    const onRejected = vi.fn();
    await run(req({ onRejected }));
    expect('top_k' in m.requests[1].body).toBe(false);
    expect(m.requests[1].body.chat_template_kwargs).toBeDefined();
    expect(onRejected).toHaveBeenCalledWith(['top_k']);
  });

  test('a 400 the retry does not fix teaches nothing', async () => {
    m = await startMockHttp(() => ({ status: 400, json: { error: { type: 'exceed_context_size_error' } } }));
    const onRejected = vi.fn();
    await expect(run(req({ onRejected }))).rejects.toMatchObject({ name: 'HttpError', status: 400 });
    expect(m.requests).toHaveLength(2);
    expect(onRejected).not.toHaveBeenCalled();
  });

  test('no retry when nothing optional was sent', async () => {
    m = await startMockHttp(() => ({ status: 400, json: {} }));
    await expect(run(req({ thinking: {}, sampling: {} }))).rejects.toBeInstanceOf(HttpError);
    expect(m.requests).toHaveLength(1);
  });

  test('other statuses are not retried', async () => {
    m = await startMockHttp(() => ({ status: 500, json: {} }));
    await expect(run(req())).rejects.toMatchObject({ status: 500 });
    expect(m.requests).toHaveLength(1);
  });

  test('an SSE error event becomes a StreamError', async () => {
    m = await startMockHttp(() => ok('{"error":{"message":"boom"}}'));
    await expect(run(req())).rejects.toBeInstanceOf(StreamError);
  });
});

describe('rejectedFields', () => {
  test('matches whole words only, case-insensitively', () => {
    expect(rejectedFields('unknown field: reasoning_effort', ['reasoning', 'reasoning_effort'])).toEqual(['reasoning_effort']);
    expect(rejectedFields('Unknown field "Reasoning"', ['reasoning', 'reasoning_effort'])).toEqual(['reasoning']);
    expect(rejectedFields('nothing here', ['reasoning'])).toEqual([]);
  });
});
