import { describe, expect, test } from 'vitest';
import type { ChatEvent, ChatRequest, FimBackend, FimRequest } from '../../../src/backends/types';
import { resolveNextEdit } from '../../../src/completion/effective';
import { ThinkingError } from '../../../src/completion/stream';
import { parseSettings, type RawSettingsSource } from '../../../src/config/settings';
import { pickFormat } from '../../../src/nextEdit/formats';
import { CHAT_XTAB_SYSTEM, chatXtabMessages } from '../../../src/nextEdit/formats/chatXtab';
import { sweepFormat } from '../../../src/nextEdit/formats/sweep';
import type { CompletionFormat, FormatAnswer, NextEditFormat, NextEditInput } from '../../../src/nextEdit/formats/format';
import { cursorWithin } from '../../../src/nextEdit/diff';
import { editableRegion, nextEditBudgets } from '../../../src/nextEdit/region';
import { nextEditMaxTokens, runNextEdit, warmNextEdit, type NextEditSnapshot } from '../../../src/nextEdit/request';
import type { BackendConfig, HostFlavor } from '../../../src/types';

const none: RawSettingsSource = { inspect: () => undefined };
const backendCfg: BackendConfig = { id: 'b', kind: 'openai', baseUrl: 'http://127.0.0.1:8012', fimMode: 'auto', headers: {}, use: { completions: true, nextEdit: true } };
const values = resolveNextEdit(backendCfg, 'qwen3.8-flash-next-iq3_s', parseSettings(none).settings);

const CIRCLE = [
  'import math', '', '', 'def circle_area(radius):', '    return math.pi * radius ** 2', '', '',
  'def circle_circumference(r):', '    return 2 * math.pi * r', '', '', 'def circle_diameter(r):', '    return 2 * r',
];
const snapshot = (lines = CIRCLE, line = 4): NextEditSnapshot => {
  const input: NextEditInput = {
    path: 'circle.py', lines, cursor: { line, character: lines[line].length },
    region: editableRegion(line, lines.length), history: [], snippets: [], budgets: nextEditBudgets(3500),
  };
  return { uri: 'file:///circle.py', version: 3, input };
};
const fence = (lines: string[]): string => '```\n' + lines.join('\n') + '\n```\n';
const renamed = CIRCLE.map((l, i) => (i === 7 ? 'def circle_circumference(radius):' : i === 8 ? '    return 2 * math.pi * radius' : l));
const regionOf = (s: NextEditSnapshot, answer: string[]): string => fence(answer.slice(s.input.region.start, s.input.region.end + 1));

const content = (text: string): ChatEvent => ({ type: 'content', text });
class TimeoutError extends Error { override name = 'TimeoutError'; }

function run(
  events: ChatEvent[],
  o: { snap?: NextEditSnapshot; flavor?: HostFlavor; fail?: Error; format?: NextEditFormat; chunks?: string[]; truncate?: boolean } = {},
) {
  const captured: { req?: ChatRequest; fim?: FimRequest; pulled: number; prompts: (ChatRequest['messages'] | string)[]; truncated: number; parsed: FormatAnswer[] } = {
    pulled: 0,
    prompts: [],
    truncated: 0,
    parsed: [],
  };
  const backend = {
    streamChat: async function* (req: ChatRequest) {
      captured.req = req;
      for (const e of events) {
        captured.pulled++;
        yield e;
      }
      if (o.fail) throw o.fail;
    },
    streamFim: async function* (req: FimRequest) {
      captured.fim = req;
      for (const c of o.chunks ?? []) {
        captured.pulled++;
        yield c;
      }
      if (o.truncate) req.onTruncated?.();
      if (o.fail) throw o.fail;
    },
  } as unknown as FimBackend;
  const ctl = new AbortController();
  const snap = o.snap ?? snapshot();
  const result = runNextEdit({
    backend, values, flavor: o.flavor ?? 'llamacpp', model: 'm', format: o.format ?? pickFormat('chatXtab', 'm'), snapshot: snap,
    rejected: new Set(), signal: ctl.signal, onRejected: undefined, onPrompt: (p) => captured.prompts.push(p),
    onTruncated: () => captured.truncated++, onParsed: (a) => captured.parsed.push(a),
  });
  return { result, captured, ctl, snap };
}

/** A completion format that records what it parses and answers with `answer`. */
function stubFormat(answer: (text: string) => FormatAnswer = () => ({ kind: 'noChange' })): CompletionFormat & { parsed: string[] } {
  const parsed: string[] = [];
  return {
    id: 'sweep',
    transport: 'completion',
    parsed,
    region: (c, n) => editableRegion(c, n.length),
    problem: () => undefined,
    prompt: () => ({ prompt: 'P', prefill: 'pre\n', stop: ['<|x|>'], maxTokens: 99 }),
    parse: (text) => {
      parsed.push(text);
      return answer(text);
    },
  };
}

describe('nextEditMaxTokens', () => {
  test('scales with the region and caps at 2048', () => {
    expect(nextEditMaxTokens(350)).toBe(Math.ceil((350 / 3.5) * 1.5) + 64);
    expect(nextEditMaxTokens(1_000_000)).toBe(2048);
  });
});

describe('runNextEdit', () => {
  test('a rename in the answer becomes an inline edit', async () => {
    const snap = snapshot();
    const r = run([content(regionOf(snap, renamed))], { snap });
    const res = await r.result;
    expect(res).toMatchObject({ uri: 'file:///circle.py', version: 3, cursor: { line: 4, character: CIRCLE[4].length } });
    expect(res?.show.kind).toBe('edit');
    expect(res?.edit).toMatchObject({ startLine: 7, endLine: 9, newLines: ['def circle_circumference(radius):', '    return 2 * math.pi * radius'] });
    expect(res?.show).toMatchObject({ kind: 'edit', start: { line: 7, character: 0 } });
  });

  test('the request uses chatXtab messages, NES sampling and the Next Edit deadline', async () => {
    const snap = snapshot();
    const r = run([content('NO_CHANGE')], { snap });
    await r.result;
    const req = r.captured.req!;
    expect(req.messages[0].content).toBe(CHAT_XTAB_SYSTEM);
    expect(req.messages).toEqual(chatXtabMessages(snap.input).messages);
    expect(req.sampling).toEqual({ temperature: 0.2, topP: 0.8, topK: 20, presencePenalty: 0 });
    expect(req.timeoutMs).toBe(values.timeoutMs);
    expect(req.stop).toEqual([]);
    const regionChars = snap.input.lines.slice(snap.input.region.start, snap.input.region.end + 1).join('\n').length;
    expect(req.maxTokens).toBe(nextEditMaxTokens(regionChars));
  });

  test('Strata gets the cache pin', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const snap = snapshot(lines, 20);
    const r = run([content('NO_CHANGE')], { snap, flavor: 'strata' });
    await r.result;
    const { stableChars } = chatXtabMessages(snap.input);
    expect(stableChars).toBeGreaterThan(0);
    expect(r.captured.req!.extraBody.strata_prefix).toEqual({ message: 1, chars: stableChars });
  });

  test('the stream is aborted once the closing fence arrives', async () => {
    const snap = snapshot();
    const r = run([content('```\n'), content('x\n'), content('```\n'), content('chatter that never ends')], { snap });
    await r.result;
    expect(r.captured.req!.signal.aborted).toBe(true);
    expect(r.captured.pulled).toBe(3);
  });

  test('a closing fence still being typed does not end the stream', async () => {
    const snap = snapshot();
    const r = run([content('```\n'), content('x\n```'), content('bash\n'), content('y\n```\n'), content('chatter that never ends')], { snap });
    await r.result;
    expect(r.captured.pulled).toBe(4);
  });

  test('a finished stream whose closing fence has no line break is a rewrite', async () => {
    const snap = snapshot();
    const answer = regionOf(snap, renamed).replace(/\n$/, '');
    const r = run([content(answer), { type: 'finish', reason: 'stop' }], { snap });
    expect((await r.result)?.edit).toMatchObject({ startLine: 7, endLine: 9 });
  });

  test('an instinct answer cut at max tokens is invalid', async () => {
    const snap = snapshot();
    const r = run([content('x = 1\n'), { type: 'finish', reason: 'length' }], { snap, format: pickFormat('instinct', 'm') });
    expect(await r.result).toBeUndefined();
    expect(r.captured.parsed).toEqual([{ kind: 'invalid', why: 'truncated' }]);
  });

  test('a reasoning event fails fast with ThinkingError', async () => {
    const r = run([{ type: 'reasoning', text: 'hm' }, content('NO_CHANGE')]);
    await expect(r.result).rejects.toBeInstanceOf(ThinkingError);
    expect(r.captured.req!.signal.aborted).toBe(true);
    expect(r.captured.pulled).toBe(1);
  });

  test('an inline think block with text fails; an empty one is stripped', async () => {
    await expect(run([content('<think>Let me')]).result).rejects.toBeInstanceOf(ThinkingError);
    await expect(run([content('<think>\n\n</think>\n\nNO_CHANGE')]).result).resolves.toBeUndefined();
  });

  test('leaked reasoning before a bare closer and the fence fails with ThinkingError', async () => {
    const snap = snapshot();
    const leaked = 'The user renamed r, so\n</think>\n' + regionOf(snap, renamed);
    const r = run([content(leaked), { type: 'finish', reason: 'stop' }], { snap });
    await expect(r.result).rejects.toBeInstanceOf(ThinkingError);
    await expect(run([content('hm, nothing to do\n</think>\nNO_CHANGE')]).result).rejects.toBeInstanceOf(ThinkingError);
  });

  test('a normal fenced answer still parses', async () => {
    const snap = snapshot();
    const r = run([content(regionOf(snap, renamed)), { type: 'finish', reason: 'stop' }], { snap });
    expect((await r.result)?.edit).toMatchObject({ startLine: 7, endLine: 9 });
  });

  test('a closing think tag inside the answer is answer text', async () => {
    const snap = snapshot();
    const answer = renamed.map((l, i) => (i === 8 ? "    return '</think>'" : l));
    const r = run([content(regionOf(snap, answer)), { type: 'finish', reason: 'stop' }], { snap });
    const got = await r.result;
    expect(got?.edit).toMatchObject({ startLine: 7 });
    expect(JSON.stringify(got)).toContain('</think>');
  });

  test('a stream that ends inside the fence is dropped (truncated)', async () => {
    await expect(run([content('```\nimport math\nx')]).result).resolves.toBeUndefined();
  });

  test('NO_CHANGE resolves undefined, and so does a whitespace-only edit', async () => {
    await expect(run([content('NO_CHANGE')]).result).resolves.toBeUndefined();
    const snap = snapshot();
    const spaced = CIRCLE.map((l) => (l === '' ? '' : l + '  '));
    await expect(run([content(regionOf(snap, spaced))], { snap }).result).resolves.toBeUndefined();
  });

  test('an empty fence body for a non-blank region resolves undefined', async () => {
    await expect(run([content('```\n```\n')]).result).resolves.toBeUndefined();
  });

  test('a timeout propagates', async () => {
    await expect(run([content('```\nx')], { fail: new TimeoutError('t') }).result).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('runNextEdit with a completion format', () => {
  test('a completion format sends a template prompt with temperature 0', async () => {
    const format = stubFormat();
    const r = run([], { format, chunks: ['a', 'b\n'] });
    await expect(r.result).resolves.toBeUndefined();
    const req = r.captured.fim!;
    expect(r.captured.req).toBeUndefined();
    expect(req.payload).toEqual({ route: 'template', prompt: 'P' });
    expect(req.sampling).toEqual({ temperature: 0, maxTokens: 99 });
    expect(req.stop).toEqual(['<|x|>']);
    expect(req.model).toBe('m');
    expect(req.timeoutMs).toBe(values.timeoutMs);
    expect(req.extraBody).toBe(values.extraBody);
    expect(req.timeMaxPredictMs).toBeUndefined();
    expect(typeof req.onTruncated).toBe('function');
    expect(format.parsed).toEqual(['pre\nab\n']);
    expect(r.captured.prompts).toEqual(['P']);
  });

  test('a stop string echoed at the end is removed before parsing', async () => {
    const format = stubFormat();
    await run([], { format, chunks: ['ab', '<|x|>'] }).result;
    expect(format.parsed).toEqual(['pre\nab']);
  });

  test('a rewrite becomes an edit, as on the chat route', async () => {
    const snap = snapshot();
    const format = stubFormat(() => ({ kind: 'rewrite', lines: renamed.slice(snap.input.region.start, snap.input.region.end + 1) }));
    const res = await run([], { format, snap, chunks: ['x'] }).result;
    expect(res?.edit).toMatchObject({ startLine: 7, endLine: 9, newLines: ['def circle_circumference(radius):', '    return 2 * math.pi * radius'] });
  });

  test('a predicted cursor becomes cursorAfter in document coordinates when the edit holds its line', async () => {
    const snap = snapshot();
    const start = snap.input.region.start;
    const region = renamed.slice(start, snap.input.region.end + 1);
    const at = (line: number) => stubFormat(() => ({ kind: 'rewrite', lines: region, cursor: { line: line - start, character: 10 } }));
    expect((await run([], { format: at(8), snap, chunks: ['x'] }).result)?.cursorAfter).toEqual({ line: 8, character: 10 });
    expect((await run([], { format: at(7), snap, chunks: ['x'] }).result)?.cursorAfter).toEqual({ line: 7, character: 10 });
    // Lines 4 and 9 are not part of the shown edit (lines 7 and 8).
    const four = await run([], { format: at(4), snap, chunks: ['x'] }).result;
    expect(four?.edit.startLine).toBe(7);
    expect(four?.cursorAfter).toBeUndefined();
    expect((await run([], { format: at(9), snap, chunks: ['x'] }).result)?.cursorAfter).toBeUndefined();
    const plain = await run([], { format: stubFormat(() => ({ kind: 'rewrite', lines: region })), snap, chunks: ['x'] }).result;
    expect(plain && 'cursorAfter' in plain).toBe(false);
  });

  test('a pure deletion has no cursorAfter', async () => {
    const snap = snapshot();
    const start = snap.input.region.start;
    const region = CIRCLE.filter((_, n) => n !== 8).slice(start, snap.input.region.end);
    const format = stubFormat(() => ({ kind: 'rewrite', lines: region, cursor: { line: 8 - start, character: 0 } }));
    const res = await run([], { format, snap, chunks: ['x'] }).result;
    expect(res?.edit).toMatchObject({ startLine: 8, endLine: 9, newLines: [] });
    expect(res?.cursorAfter).toBeUndefined();
  });

  test('cursorWithin keeps a position only on the new lines of the edit', () => {
    const edit = { startLine: 7, endLine: 9, newLines: ['a', 'b'] };
    expect(cursorWithin(edit, { line: 7, character: 1 })).toEqual({ line: 7, character: 1 });
    expect(cursorWithin(edit, { line: 8, character: 0 })).toEqual({ line: 8, character: 0 });
    expect(cursorWithin(edit, { line: 6, character: 0 })).toBeUndefined();
    expect(cursorWithin(edit, { line: 9, character: 0 })).toBeUndefined();
    expect(cursorWithin({ startLine: 7, endLine: 8, newLines: [] }, { line: 7, character: 0 })).toBeUndefined();
    expect(cursorWithin(edit, undefined)).toBeUndefined();
  });

  test('a truncated completion gives no result', async () => {
    const snap = snapshot();
    const format = stubFormat(() => ({ kind: 'rewrite', lines: renamed.slice(snap.input.region.start, snap.input.region.end + 1) }));
    await expect(run([], { format, snap, chunks: ['x'], truncate: true }).result).resolves.toBeUndefined();
  });

  test('a truncated completion is reported through onTruncated, a complete one is not', async () => {
    const cut = run([], { format: stubFormat(), chunks: ['x'], truncate: true });
    await cut.result;
    expect(cut.captured.truncated).toBe(1);
    const whole = run([], { format: stubFormat(), chunks: ['x'] });
    await whole.result;
    expect(whole.captured.truncated).toBe(0);
  });

  test('onParsed receives the parsed answer, also when it gives no result, and is not called for a truncated answer', async () => {
    const noChange = run([], { format: stubFormat(), chunks: ['x'] });
    await noChange.result;
    expect(noChange.captured.parsed).toEqual([{ kind: 'noChange' }]);
    const invalid = run([], { format: stubFormat(() => ({ kind: 'invalid', why: 'markers' })), chunks: ['x'] });
    await expect(invalid.result).resolves.toBeUndefined();
    expect(invalid.captured.parsed).toEqual([{ kind: 'invalid', why: 'markers' }]);
    const cut = run([], { format: stubFormat(), chunks: ['x'], truncate: true });
    await cut.result;
    expect(cut.captured.parsed).toEqual([]);
  });

  test('onParsed also receives a chat answer', async () => {
    const snap = snapshot();
    const r = run([content(regionOf(snap, renamed))], { snap });
    await r.result;
    expect(r.captured.parsed).toEqual([{ kind: 'rewrite', lines: renamed.slice(snap.input.region.start, snap.input.region.end + 1) }]);
  });

  test('an empty rewrite of a non-blank region gives no result', async () => {
    const format = stubFormat(() => ({ kind: 'rewrite', lines: [] }));
    await expect(run([], { format, chunks: ['x'] }).result).resolves.toBeUndefined();
  });

  test('an answer that drops the blank last line of a region at the end of the file keeps the final newline', async () => {
    const lines = [...CIRCLE, ''];
    const snap = snapshot(lines, 12);
    expect(snap.input.region.end).toBe(lines.length - 1);
    const region = (src: string[]) => src.slice(snap.input.region.start, snap.input.region.end + 1);
    const answer = region([...renamed, '']).slice(0, -1);
    const res = await run([], { format: stubFormat(() => ({ kind: 'rewrite', lines: answer })), snap, chunks: ['x'] }).result;
    expect(res?.edit).toMatchObject({ startLine: 7, endLine: 9, newLines: ['def circle_circumference(radius):', '    return 2 * math.pi * radius'] });
    const echo = region(lines).slice(0, -1);
    await expect(run([], { format: stubFormat(() => ({ kind: 'rewrite', lines: echo })), snap, chunks: ['x'] }).result).resolves.toBeUndefined();
  });

  test('the same answer on the chat route keeps the final newline too', async () => {
    const lines = [...CIRCLE, ''];
    const snap = snapshot(lines, 12);
    const answer = renamed.slice(snap.input.region.start, snap.input.region.end + 1);
    const res = await run([content(fence(answer))], { snap }).result;
    expect(res?.edit).toMatchObject({ startLine: 7, endLine: 9, newLines: ['def circle_circumference(radius):', '    return 2 * math.pi * radius'] });
  });

  test('a Sweep v2 generation that stops at once gives no result, not a deletion below the cursor', async () => {
    const lines = Array.from({ length: 30 }, (_, n) => `line ${n}`);
    const format = sweepFormat('v2');
    const input: NextEditInput = {
      path: 'a.py', lines, cursor: { line: 12, character: 0 }, region: format.region(12, lines, { above: 5, below: 10 }),
      history: [], snippets: [], budgets: nextEditBudgets(3500),
    };
    const snap = { uri: 'file:///a.py', version: 1, input };
    await expect(run([], { format, snap, chunks: ['<|file_sep|>'] }).result).resolves.toBeUndefined();
    await expect(run([], { format, snap, chunks: [] }).result).resolves.toBeUndefined();
  });

  test('a timeout propagates and aborts the request', async () => {
    const r = run([], { format: stubFormat(), chunks: ['x'], fail: new TimeoutError('t') });
    await expect(r.result).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(r.captured.fim!.signal.aborted).toBe(true);
  });
});

describe('warmNextEdit', () => {
  test('sends the format prompt with maxTokens 0 on the Next Edit slot and returns nothing', async () => {
    let fim: FimRequest | undefined;
    const backend = {
      streamFim: async function* (req: FimRequest) {
        fim = req;
        yield 'ignored';
      },
    } as unknown as FimBackend;
    const format = sweepFormat('v2');
    const snap = snapshot();
    const out = await warmNextEdit({ backend, values, model: 'm', format, input: snap.input, signal: new AbortController().signal });
    expect(out).toBeUndefined();
    expect(fim?.sampling.maxTokens).toBe(0);
    expect(fim?.slot).toBe('nextEdit');
    expect(fim?.payload).toEqual({ route: 'template', prompt: format.prompt(snap.input).prompt });
  });
});
