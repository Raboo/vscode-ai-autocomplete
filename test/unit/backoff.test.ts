import { beforeEach, describe, expect, test } from 'vitest';
import { ErrorBackoff } from '../../src/backends/backoff';

describe('ErrorBackoff', () => {
  const t0 = 1_000_000;
  let now: number;
  let b: ErrorBackoff;
  beforeEach(() => {
    now = t0;
    b = new ErrorBackoff(() => now);
  });

  test('401/402/403 are fatal until reset', () => {
    for (const status of [401, 402, 403]) {
      b.reset();
      b.recordFailure({ kind: 'http', status });
      expect(b.canRequest()).toBe(false);
      expect(b.state()).toEqual({ kind: 'fatal', status });
    }
    b.reset();
    expect(b.canRequest()).toBe(true);
    expect(b.state()).toEqual({ kind: 'ok' });
  });

  test('429 backs off exponentially 2s→120s cap', () => {
    const deltas = [2000, 4000, 8000, 16000];
    for (const d of deltas) {
      b.recordFailure({ kind: 'http', status: 429 });
      expect(b.state()).toEqual({ kind: 'backoff', until: now + d });
    }
    // success resets the counter
    b.recordSuccess();
    expect(b.state()).toEqual({ kind: 'ok' });
    b.recordFailure({ kind: 'http', status: 429 });
    expect(b.state()).toEqual({ kind: 'backoff', until: now + 2000 });
    // The 120000 cap is unreachable before the circuit opens (5th failure would be 32000),
    // so on the 5th consecutive failure the circuit value applies.
    for (let i = 0; i < 4; i++) {
      b.recordFailure({ kind: 'http', status: 429 });
    }
    expect(b.state()).toEqual({ kind: 'backoff', until: now + 300000 });
    // many more failures never exceed the circuit value
    for (let i = 0; i < 20; i++) {
      b.recordFailure({ kind: 'http', status: 429 });
    }
    expect(b.state()).toEqual({ kind: 'backoff', until: now + 300000 });
  });

  test('network errors back off', () => {
    b.recordFailure({ kind: 'network' });
    expect(b.state()).toEqual({ kind: 'backoff', until: t0 + 2000 });
    expect(b.canRequest()).toBe(false);
  });

  test('circuit opens for 5 min after 5 consecutive failures', () => {
    for (let i = 0; i < 5; i++) {
      b.recordFailure({ kind: 'http', status: 500 });
    }
    expect(b.state()).toEqual({ kind: 'backoff', until: now + 300000 });
  });

  test('abort never counts', () => {
    b.recordFailure({ kind: 'abort' });
    expect(b.state()).toEqual({ kind: 'ok' });
    expect(b.canRequest()).toBe(true);
  });

  test('canRequest true again after until passes', () => {
    b.recordFailure({ kind: 'network' });
    expect(b.canRequest()).toBe(false);
    now = t0 + 1999;
    expect(b.canRequest()).toBe(false);
    now = t0 + 2000;
    expect(b.canRequest()).toBe(true);
    expect(b.state()).toEqual({ kind: 'ok' });
  });
});
