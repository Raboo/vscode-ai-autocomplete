import { describe, expect, test } from 'vitest';
import type { ChatEvent, ChatRequest, FimBackend, FimRequest } from '../../src/backends/types';
import { CompletionAccumulator, type StreamFilterOptions } from '../../src/completion/filters';
import { collectCompletion, ThinkingError, type PlannedRequest } from '../../src/completion/stream';

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
const chatPlan = (linePrefix = ''): PlannedRequest => ({ route: 'chat', req: {} as ChatRequest, linePrefix, lineSuffix: '' });
const content = (text: string): ChatEvent => ({ type: 'content', text });
const finish = (reason = 'stop'): ChatEvent => ({ type: 'finish', reason });

describe('collectCompletion', () => {
  describe('failOnThinking', () => {
    const fail = { failOnThinking: true };
    test('a reasoning event fails fast with ThinkingError and aborts', async () => {
      const ctl = new AbortController();
      const pulled: number[] = [];
      const events: ChatEvent[] = [{ type: 'reasoning', text: 'hm' }, content('<COMPLETION>a'), finish()];
      const b = { streamChat: async function* () { for (const [i, e] of events.entries()) { pulled.push(i); yield e; } } } as unknown as FimBackend;
      await expect(collectCompletion(b, chatPlan(), new CompletionAccumulator(opts()), ctl, fail)).rejects.toBeInstanceOf(ThinkingError);
      expect(ctl.signal.aborted).toBe(true);
      expect(pulled).toEqual([0]); // nothing after the first reasoning event was pulled
    });
    test('think tags inside the answer are code, not reasoning', async () => {
      const chat = [content("<COMPLETION>const CLOSE = '</think>';"), finish()];
      const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController(), fail);
      expect(r.text).toBe("const CLOSE = '</think>';");
      const open = [content("<COMPLETION>x = '<think>hi"), finish()];
      const o = await collectCompletion(backend({ chat: open }), chatPlan(), new CompletionAccumulator(opts()), new AbortController(), fail);
      expect(o.text).toBe("x = '<think>hi");
    });
    test('unwrapped content with a think tag is code, not reasoning', async () => {
      const chat = [content("const CLOSE = '</think>';"), finish()];
      await expect(collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController(), fail)).resolves.toBeDefined();
    });
    test('a closer before the answer fails, even in the same chunk', async () => {
      const chat = [content('I should add them.</think><COMPLETION>a + b;'), finish()];
      await expect(collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController(), fail)).rejects.toBeInstanceOf(ThinkingError);
    });
    test('leaked reasoning before a bare closer, answered unwrapped, fails (prefilled <think>)', async () => {
      const chat = () => [content('The user wants the sum of a and b.'), content('</think>\n\na + b;'), finish()];
      for (const multiline of [false, true]) {
        const ctl = new AbortController();
        await expect(collectCompletion(backend({ chat: chat() }), chatPlan(), new CompletionAccumulator(opts({ multiline })), ctl, fail)).rejects.toBeInstanceOf(ThinkingError);
        expect(ctl.signal.aborted).toBe(true);
      }
    });
    test('a closer inside <COMPLETION> stays answer text', async () => {
      const chat = [content('<COMPLETION>x </think> y</COMPLETION>'), finish()];
      const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController(), fail);
      expect(r.text).toBe('x </think> y');
    });
    test('an inline think opener with text fails fast', async () => {
      const ctl = new AbortController();
      await expect(collectCompletion(backend({ chat: [content('<think>Let me')] }), chatPlan(), new CompletionAccumulator(opts()), ctl, fail)).rejects.toMatchObject({ name: 'ThinkingError' });
      expect(ctl.signal.aborted).toBe(true);
    });
    test('an empty think block does not fail the request', async () => {
      const chat = [content('<think>\n\n</think>\n\n<COMPLETION>a + b;'), finish()];
      const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController(), fail);
      expect(r.text).toBe('a + b;');
    });
    test('an empty reasoning event does not fail the request', async () => {
      const chat: ChatEvent[] = [{ type: 'reasoning', text: '\n' }, content('<COMPLETION>a + b;'), finish()];
      const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController(), fail);
      expect(r.text).toBe('a + b;');
    });
    test('without failOnThinking the old behaviour holds', async () => {
      const chat: ChatEvent[] = [{ type: 'reasoning', text: 'hm' }, content('<COMPLETION>a + b;'), finish()];
      const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController());
      expect(r).toMatchObject({ text: 'a + b;', thinking: true });
    });
  });

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

  test('a bare closing tag is answer text when the model may not think', async () => {
    const chat = [content('x = a;</thi'), content('nk> y'), finish()];
    for (const o of [{}, { failOnThinking: true }]) {
      const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController(), o);
      expect(r).toMatchObject({ text: 'x = a;</think> y', visible: 'x = a;</think> y', thinking: false });
    }
  });

  test('an opener and closer pair is reasoning', async () => {
    const chat = [content('<think>hm</think><COMPLETION>a + b;'), finish()];
    const r = await collectCompletion(backend({ chat }), chatPlan(), new CompletionAccumulator(opts()), new AbortController());
    expect(r).toMatchObject({ text: 'a + b;', thinking: true });
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

  test('a fenced answer after a whitespace-only line prefix loses the fence and the re-typed indentation', async () => {
    // Observed on Strata (Qwen3.8): the first line came out indented twice.
    const acc = new CompletionAccumulator(opts({ multiline: true }));
    const chat = [content('```python\n'), content('    print(c)\n'), content('    print(d)\n'), content('```'), finish()];
    const r = await collectCompletion(backend({ chat }), chatPlan('    '), acc, new AbortController());
    expect(r.text).toBe('print(c)\n    print(d)');
  });

  test('at the end of a line, an indented answer becomes the next line; a single-line request keeps its first line', async () => {
    const chat = () => [content('<COMPLETION>    print(c)\n'), content('    print(d)</COMPLETION>'), finish()];
    const plan: PlannedRequest = { route: 'chat', req: {} as ChatRequest, linePrefix: '    print(a)', lineSuffix: '' };
    const multi = await collectCompletion(backend({ chat: chat() }), plan, new CompletionAccumulator(opts({ multiline: true })), new AbortController());
    expect(multi.text).toBe('\n    print(c)\n    print(d)');
    const single = await collectCompletion(backend({ chat: chat() }), plan, new CompletionAccumulator(opts()), new AbortController());
    expect(single.text).toBe('\n    print(c)');
  });

  test('a single-line chat timeout rethrows the timeout', async () => {
    const chat: ChatEvent[] = [content('<COMPLETION>a + b')];
    await expect(
      collectCompletion(backend({ chat, fail: new TimeoutError('t') }), chatPlan(), new CompletionAccumulator(opts()), new AbortController()),
    ).rejects.toMatchObject({ name: 'TimeoutError', message: 't' });
  });
});
