import { describe, expect, test } from 'vitest';
import type { ChatEvent, ChatRequest, FimBackend, FimRequest } from '../../src/backends/types';
import { CompletionAccumulator, type StreamFilterOptions } from '../../src/completion/filters';
import { collectCompletion, type PlannedRequest } from '../../src/completion/stream';

const opts = (o: Partial<StreamFilterOptions> = {}): StreamFilterOptions => ({ stop: [], multiline: false, maxLines: 16, suffix: '', ...o });

class TimeoutError extends Error {
  override name = 'TimeoutError';
}

async function* gen<T>(items: T[], failure?: Error): AsyncGenerator<T> {
  for (const i of items) yield i;
  if (failure) throw failure;
}

const backend = (o: { fim?: string[]; chat?: ChatEvent[]; fail?: Error }): FimBackend =>
  ({
    streamFim: () => gen(o.fim ?? [], o.fail),
    streamChat: () => gen(o.chat ?? [], o.fail),
  }) as unknown as FimBackend;

const fimPlan: PlannedRequest = { route: 'native', req: {} as FimRequest };
const chatPlan = (linePrefix = ''): PlannedRequest => ({ route: 'chat', req: {} as ChatRequest, linePrefix });
const content = (text: string): ChatEvent => ({ type: 'content', text });
const finish = (reason = 'stop'): ChatEvent => ({ type: 'finish', reason });

describe('collectCompletion', () => {
  test('a FIM route returns the filtered text', async () => {
    const ctl = new AbortController();
    const r = await collectCompletion(backend({ fim: ['a + b;\n', 'x'] }), fimPlan, new CompletionAccumulator(opts()), ctl);
    expect(r).toMatchObject({ text: 'a + b;', stoppedEarly: true, timedOut: false });
    expect(ctl.signal.aborted).toBe(true);
  });

  test('chat: reasoning is dropped and the answer extracted', async () => {
    const chat: ChatEvent[] = [{ type: 'reasoning', text: 'hm' }, content('<COMPLETION>a + b;'), finish()];
    const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController());
    expect(r).toMatchObject({ text: 'a + b;', thinking: true, stoppedEarly: false });
  });

  test('an unclosed think at length yields no text and flags thinking', async () => {
    const chat = [content('x<think>long'), finish('length')];
    const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController());
    expect(r).toMatchObject({ text: '', thinking: true });
  });

  test('a bare closing tag resets the answer', async () => {
    const chat = [content('x<COMPLETION>no'), content('</think><COMPLETION>a + b;'), finish()];
    const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController());
    expect(r.text).toBe('a + b;');
  });

  test('nothing from before a bare closing tag is exposed', async () => {
    const acc = new CompletionAccumulator(opts());
    const seen: string[] = [];
    const orig = acc.replace.bind(acc);
    acc.replace = (t: string) => (seen.push(t), orig(t));
    const chat = [content('I think.'), content('</think><COMPLETION>a + b;</COMPLETION>'), finish()];
    const r = await collectCompletion(backend({ chat }), chatPlan(), acc, new AbortController());
    expect(r.text).toBe('a + b;');
    expect(seen.some((t) => t.includes('I think.'))).toBe(false);
  });

  test('chat stops early once the single line is complete', async () => {
    const ctl = new AbortController();
    const chat = [content('<COMPLETION>a + b;\nmore'), content('never'), finish()];
    const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), ctl);
    expect(r).toMatchObject({ text: 'a + b;', stoppedEarly: true });
    expect(ctl.signal.aborted).toBe(true);
  });

  test('a timeout after complete lines keeps them', async () => {
    const r = await collectCompletion(
      backend({ fim: ['l1\nl2\nl'], fail: new TimeoutError('t') }),
      fimPlan,
      new CompletionAccumulator(opts({ multiline: true })),
      new AbortController(),
    );
    expect(r).toMatchObject({ text: 'l1\nl2', timedOut: true });
  });

  test('a timeout before any complete line throws', async () => {
    await expect(
      collectCompletion(backend({ fim: ['partial'], fail: new TimeoutError('t') }), fimPlan, new CompletionAccumulator(opts({ multiline: true })), new AbortController()),
    ).rejects.toThrow('t');
  });

  test('a non-timeout error is rethrown even with complete lines', async () => {
    await expect(
      collectCompletion(backend({ fim: ['l1\nl2\n'], fail: new Error('boom') }), fimPlan, new CompletionAccumulator(opts({ multiline: true })), new AbortController()),
    ).rejects.toThrow('boom');
  });

  test('chat never feeds acc an answer that is not an extension of the last one mid-stream', async () => {
    const acc = new CompletionAccumulator(opts());
    const seen: string[] = [];
    const orig = acc.replace.bind(acc);
    acc.replace = (t: string) => (seen.push(t), orig(t));
    const chat = [content('x<COMPLETION>no'), content('</think><COMPLETION>a + b;'), finish()];
    const r = await collectCompletion(backend({ chat }), chatPlan(), acc, new AbortController());
    expect(r.text).toBe('a + b;');
    // The shorter, different answer only arrives with the final settle.
    expect(seen.indexOf('a + b;')).toBe(seen.length - 1);
  });

  test('a chat timeout keeps the thinking flag and the complete lines', async () => {
    const chat: ChatEvent[] = [{ type: 'reasoning', text: 'hm' }, content('<COMPLETION>l1\nl2\nl')];
    const r = await collectCompletion(
      backend({ chat, fail: new TimeoutError('t') }),
      chatPlan(),
      new CompletionAccumulator(opts({ multiline: true })),
      new AbortController(),
    );
    expect(r).toMatchObject({ text: 'l1\nl2', timedOut: true, thinking: true });
  });

  test('an indentation drop that a later line undoes reaches acc only at the end, whole', async () => {
    const acc = new CompletionAccumulator(opts({ multiline: true }));
    const seen: string[] = [];
    const orig = acc.replace.bind(acc);
    acc.replace = (t: string) => (seen.push(t), orig(t));
    const chat = [content('<COMPLETION>  x = 1;\n'), content('}'), finish()];
    const r = await collectCompletion(backend({ chat }), chatPlan('  '), acc, new AbortController());
    expect(r.text).toBe('  x = 1;\n}');
    expect(seen).toEqual(['x = 1;\n', '  x = 1;\n}']);
  });

  test('a single-line chat timeout keeps the thinking flag', async () => {
    const chat: ChatEvent[] = [{ type: 'reasoning', text: 'hm' }, content('<COMPLETION>a + b')];
    await expect(
      collectCompletion(backend({ chat, fail: new TimeoutError('t') }), chatPlan(), new CompletionAccumulator(opts()), new AbortController()),
    ).rejects.toMatchObject({ name: 'TimeoutError', message: 't', thinking: true });
  });

  test('a chat timeout without reasoning reports thinking false', async () => {
    await expect(
      collectCompletion(backend({ chat: [content('<COMPLETION>a')], fail: new TimeoutError('t') }), chatPlan(), new CompletionAccumulator(opts()), new AbortController()),
    ).rejects.toMatchObject({ name: 'TimeoutError', thinking: false });
  });

  test('a multi-line timeout after a bare closer does not return pre-closer lines', async () => {
    const chat = [content('<COMPLETION>l1\nl2\n'), content('</think><COMPLETION>x')];
    await expect(
      collectCompletion(backend({ chat, fail: new TimeoutError('t') }), chatPlan(), new CompletionAccumulator(opts({ multiline: true })), new AbortController()),
    ).rejects.toMatchObject({ name: 'TimeoutError', thinking: true });
    const after = [content('<COMPLETION>l1\nl2\n'), content('</think><COMPLETION>a\nb')];
    const r = await collectCompletion(backend({ chat: after, fail: new TimeoutError('t') }), chatPlan(), new CompletionAccumulator(opts({ multiline: true })), new AbortController());
    expect(r).toMatchObject({ text: 'a', timedOut: true, thinking: true });
  });
});
