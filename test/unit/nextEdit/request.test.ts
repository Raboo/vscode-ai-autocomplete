import { describe, expect, test } from 'vitest';
import type { ChatEvent, ChatRequest, FimBackend } from '../../../src/backends/types';
import { resolveNextEdit } from '../../../src/completion/effective';
import { ThinkingError } from '../../../src/completion/stream';
import { parseSettings, type RawSettingsSource } from '../../../src/config/settings';
import { CHAT_XTAB_SYSTEM, chatXtabMessages, type NextEditInput } from '../../../src/nextEdit/formats/chatXtab';
import { editableRegion } from '../../../src/nextEdit/region';
import { nextEditMaxTokens, runNextEdit, type NextEditSnapshot } from '../../../src/nextEdit/request';
import type { BackendConfig, HostFlavor } from '../../../src/types';

const none: RawSettingsSource = { inspect: () => undefined };
const backendCfg: BackendConfig = { id: 'b', kind: 'openai', baseUrl: 'http://127.0.0.1:8012', fimMode: 'auto', headers: {} };
const values = resolveNextEdit(backendCfg, 'qwen3.8-flash-next-iq3_s', parseSettings(none).settings);

const CIRCLE = [
  'import math', '', '', 'def circle_area(radius):', '    return math.pi * radius ** 2', '', '',
  'def circle_circumference(r):', '    return 2 * math.pi * r', '', '', 'def circle_diameter(r):', '    return 2 * r',
];
const snapshot = (lines = CIRCLE, line = 4): NextEditSnapshot => {
  const input: NextEditInput = {
    path: 'circle.py', lines, cursor: { line, character: lines[line].length },
    region: editableRegion(line, lines.length), history: [], snippets: [],
  };
  return { uri: 'file:///circle.py', version: 3, input };
};
const fence = (lines: string[]): string => '```\n' + lines.join('\n') + '\n```\n';
const renamed = CIRCLE.map((l, i) => (i === 7 ? 'def circle_circumference(radius):' : i === 8 ? '    return 2 * math.pi * radius' : l));
const regionOf = (s: NextEditSnapshot, answer: string[]): string => fence(answer.slice(s.input.region.start, s.input.region.end + 1));

const content = (text: string): ChatEvent => ({ type: 'content', text });
class TimeoutError extends Error { override name = 'TimeoutError'; }

function run(events: ChatEvent[], o: { snap?: NextEditSnapshot; flavor?: HostFlavor; fail?: Error } = {}) {
  const captured: { req?: ChatRequest; pulled: number } = { pulled: 0 };
  const backend = {
    streamChat: async function* (req: ChatRequest) {
      captured.req = req;
      for (const e of events) {
        captured.pulled++;
        yield e;
      }
      if (o.fail) throw o.fail;
    },
  } as unknown as FimBackend;
  const ctl = new AbortController();
  const snap = o.snap ?? snapshot();
  const result = runNextEdit({ backend, values, flavor: o.flavor ?? 'llamacpp', model: 'm', snapshot: snap, rejected: new Set(), signal: ctl.signal, onRejected: undefined });
  return { result, captured, ctl, snap };
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
