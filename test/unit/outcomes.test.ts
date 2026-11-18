import { describe, expect, test } from 'vitest';
import { describeOutcome, median, OutcomeLog, relativeTime, sessionLine, type CompletionOutcome } from '../../src/completion/outcomes';

const o = (n: number, patch: Partial<CompletionOutcome> = {}): CompletionOutcome => ({ at: n, uri: 'file:///a', kind: 'cache', ...patch });

describe('OutcomeLog', () => {
  test('keeps the last 20 outcomes', () => {
    const log = new OutcomeLog();
    for (let i = 0; i < 25; i++) log.record(o(i));
    const all = log.forUri('file:///a');
    expect(all).toHaveLength(20);
    expect(all[0].at).toBe(24);
    expect(all[19].at).toBe(5);
  });
  test('filters by document, newest first', () => {
    const log = new OutcomeLog();
    log.record(o(1));
    log.record(o(2, { uri: 'file:///b' }));
    log.record(o(3));
    expect(log.forUri('file:///a').map((x) => x.at)).toEqual([3, 1]);
    expect(log.forUri('file:///none')).toEqual([]);
  });
  test('counts requests, shown and accepted; median of answered latencies', () => {
    const log = new OutcomeLog();
    expect(log.stats()).toEqual({ requests: 0, shown: 0, accepted: 0 });
    for (const ms of [100, 300, 200]) {
      log.requestSent();
      log.record(o(1, { kind: 'shown', ms, chars: 5 }));
    }
    log.record(o(2, { kind: 'error', detail: 'HTTP 500' }));
    log.record(o(3, { kind: 'cache' }));
    log.accepted();
    expect(log.stats()).toEqual({ requests: 3, shown: 3, accepted: 1, medianMs: 200 });
  });
  test('latency window is the last 20 answered requests', () => {
    const log = new OutcomeLog();
    for (let i = 0; i < 20; i++) log.record(o(i, { kind: 'empty', ms: 1000 }));
    for (let i = 0; i < 20; i++) log.record(o(i, { kind: 'filtered', ms: 10 }));
    expect(log.stats().medianMs).toBe(10);
  });
});

test('median', () => {
  expect(median([])).toBeUndefined();
  expect(median([5])).toBe(5);
  expect(median([4, 2, 8, 6])).toBe(5);
});

describe('wording', () => {
  test('skipped and blocked reasons', () => {
    expect(describeOutcome(o(1, { kind: 'skipped', detail: 'mid-word' }))).toBe('Skipped: the cursor is inside a word (completions.skipMidWord)');
    expect(describeOutcome(o(1, { kind: 'skipped', detail: 'multi-cursor' }))).toBe('Skipped: there are several cursors');
    expect(describeOutcome(o(1, { kind: 'blocked', detail: 'thinking' }))).toContain('keeps thinking');
  });
  test('answers', () => {
    expect(describeOutcome(o(1, { kind: 'shown', chars: 12, ms: 340 }))).toBe('Suggestion shown (12 characters, 340 ms)');
    expect(describeOutcome(o(1, { kind: 'filtered' }))).toBe('Nothing left after cleanup');
    expect(describeOutcome(o(1, { kind: 'error', detail: 'HTTP 503' }))).toBe('Error: HTTP 503');
    expect(describeOutcome(o(1, { kind: 'cache', chars: 0 }))).toContain('empty');
  });
  test('relative time', () => {
    expect(relativeTime(12_000, 0)).toBe('12 s ago');
    expect(relativeTime(180_000, 0)).toBe('3 min ago');
    expect(relativeTime(7_300_000, 0)).toBe('2 h ago');
  });
  test('session line omits the median when there is none', () => {
    expect(sessionLine({ requests: 1, shown: 0, accepted: 0 })).toBe('This session: 1 request · 0 shown · 0 accepted');
  });
});
