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
    const chat = [content('<think>long'), finish('length')];
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
});
