import { describe, expect, test } from 'vitest';
import { isLoopback, shouldPrefetch, shouldWarm, shouldWarmNextEdit, WARM_INTERVAL_MS, WarmLimiter, type NextEditWarmInput, type SpeculateInput } from '../../src/completion/warmup';

const base: SpeculateInput = {
  kind: 'llamacpp',
  baseUrl: 'http://127.0.0.1:8012',
  enabled: true,
  snoozedUntil: 0,
  now: 100_000,
  scheme: 'file',
  languageId: 'typescript',
  disabledLanguages: ['plaintext'],
  fileExcluded: false,
  inBackoff: false,
  busy: false,
};
const warm = (o: Partial<SpeculateInput> = {}, lastWarmAt?: number) => shouldWarm({ ...base, ...o }, lastWarmAt);
const prefetch = (o: Partial<SpeculateInput> = {}) => shouldPrefetch({ ...base, ...o });

describe('isLoopback', () => {
  test('loopback hosts', () => {
    for (const url of ['http://127.0.0.1:8012', 'http://127.1.2.3', 'http://localhost:8080/v1', 'http://LOCALHOST', 'http://foo.localhost', 'http://[::1]:8012', 'http://localhost.']) {
      expect(isLoopback(url), url).toBe(true);
    }
  });
  test('private network and public hosts are not loopback', () => {
    for (const url of ['http://192.168.1.5:8012', 'http://10.0.0.1', 'https://example.com', 'http://[fe80::1]', 'http://0.0.0.0', 'not a url', '']) {
      expect(isLoopback(url), url).toBe(false);
    }
  });
});

describe('shouldWarm', () => {
  test('a loopback llama.cpp backend warms', () => expect(warm()).toEqual({ ok: true }));
  test('only llama.cpp', () => {
    expect(warm({ kind: 'openai' })).toEqual({ ok: false, reason: 'not llama.cpp' });
    expect(warm({ kind: 'mistral' })).toEqual({ ok: false, reason: 'not llama.cpp' });
    expect(warm({ kind: undefined, baseUrl: undefined })).toEqual({ ok: false, reason: 'not llama.cpp' });
  });
  test('only loopback hosts', () => {
    expect(warm({ baseUrl: 'http://192.168.1.5:8012' })).toEqual({ ok: false, reason: 'not loopback' });
    expect(warm({ baseUrl: 'https://llama.example.com' })).toEqual({ ok: false, reason: 'not loopback' });
  });
  test('skipped states', () => {
    expect(warm({ enabled: false })).toEqual({ ok: false, reason: 'disabled' });
    expect(warm({ snoozedUntil: base.now + 1 })).toEqual({ ok: false, reason: 'snoozed' });
    expect(warm({ scheme: 'output' })).toEqual({ ok: false, reason: 'scheme' });
    expect(warm({ languageId: 'plaintext' })).toEqual({ ok: false, reason: 'language' });
    expect(warm({ fileExcluded: true })).toEqual({ ok: false, reason: 'excluded file' });
    expect(warm({ inBackoff: true })).toEqual({ ok: false, reason: 'backoff' });
    expect(warm({ busy: true })).toEqual({ ok: false, reason: 'busy' });
  });
  test('at most once per document per 30 s', () => {
    expect(warm({}, base.now - 1_000)).toEqual({ ok: false, reason: 'recent' });
    expect(warm({}, base.now - WARM_INTERVAL_MS + 1)).toEqual({ ok: false, reason: 'recent' });
    expect(warm({}, base.now - WARM_INTERVAL_MS)).toEqual({ ok: true });
  });
});

describe('shouldPrefetch', () => {
  test('a loopback llama.cpp backend prefetches', () => expect(prefetch()).toEqual({ ok: true }));
  test('only loopback llama.cpp', () => {
    expect(prefetch({ kind: 'openai' })).toEqual({ ok: false, reason: 'not llama.cpp' });
    expect(prefetch({ baseUrl: 'http://10.0.0.2:8012' })).toEqual({ ok: false, reason: 'not loopback' });
  });
  test('skipped states', () => {
    expect(prefetch({ enabled: false })).toEqual({ ok: false, reason: 'disabled' });
    expect(prefetch({ snoozedUntil: base.now + 1 })).toEqual({ ok: false, reason: 'snoozed' });
    expect(prefetch({ fileExcluded: true })).toEqual({ ok: false, reason: 'excluded file' });
    expect(prefetch({ inBackoff: true })).toEqual({ ok: false, reason: 'backoff' });
    expect(prefetch({ busy: true })).toEqual({ ok: false, reason: 'busy' });
  });
});

describe('WarmLimiter', () => {
  test('forget and clear let a document be warmed again', () => {
    const l = new WarmLimiter(() => 0);
    l.mark('a');
    l.mark('b');
    l.forget('a');
    expect(l.last('a')).toBeUndefined();
    expect(l.last('b')).toBe(0);
    l.clear();
    expect(l.last('b')).toBeUndefined();
  });
  test('remembers when each document was warmed', () => {
    let now = 0;
    const l = new WarmLimiter(() => now);
    expect(l.last('a')).toBeUndefined();
    l.mark('a');
    now = 5_000;
    expect(l.last('a')).toBe(0);
    expect(l.last('b')).toBeUndefined();
  });
  test('forgets documents warmed longer ago than the interval', () => {
    let now = 0;
    const l = new WarmLimiter(() => now);
    l.mark('a');
    now = WARM_INTERVAL_MS + 1;
    l.mark('b');
    expect(l.last('a')).toBeUndefined();
    expect(l.last('b')).toBe(now);
  });
});

describe('shouldWarmNextEdit', () => {
  const ne: NextEditWarmInput = { ...base, completionsOn: false, format: 'zeta21' };
  const warmNe = (o: Partial<NextEditWarmInput> = {}, lastWarmAt?: number) => shouldWarmNextEdit({ ...ne, ...o }, lastWarmAt);
  test('completions off, loopback llama.cpp and a raw format warm', () => {
    expect(warmNe()).toEqual({ ok: true });
    expect(warmNe({ format: 'sweep' })).toEqual({ ok: true });
  });
  test('never while completions are on', () => expect(warmNe({ completionsOn: true })).toEqual({ ok: false, reason: 'completions on' }));
  test('only a raw format', () => expect(warmNe({ format: 'chatXtab' })).toEqual({ ok: false, reason: 'not a raw format' }));
  test('only loopback llama.cpp', () => {
    expect(warmNe({ kind: 'openai' })).toEqual({ ok: false, reason: 'not llama.cpp' });
    expect(warmNe({ baseUrl: 'http://192.168.1.5:8012' })).toEqual({ ok: false, reason: 'not loopback' });
  });
  test('skipped states and the 30 s limit follow the completions rules', () => {
    expect(warmNe({ enabled: false })).toEqual({ ok: false, reason: 'disabled' });
    expect(warmNe({ busy: true })).toEqual({ ok: false, reason: 'busy' });
    expect(warmNe({ inBackoff: true })).toEqual({ ok: false, reason: 'backoff' });
    expect(warmNe({}, ne.now - 1_000)).toEqual({ ok: false, reason: 'recent' });
    expect(warmNe({}, ne.now - WARM_INTERVAL_MS)).toEqual({ ok: true });
  });
});
