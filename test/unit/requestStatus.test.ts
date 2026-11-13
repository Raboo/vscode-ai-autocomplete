import { describe, expect, test } from 'vitest';
import { ErrorBackoff } from '../../src/backends/backoff';
import { classifyError, HttpError } from '../../src/backends/http';
import { describeFailure, RequestStatus, recordBackendFailure, type StatusSink } from '../../src/completion/requestStatus';

function sink(): StatusSink & { calls: [string, string | undefined][] } {
  const calls: [string, string | undefined][] = [];
  return { calls, set: (state, detail) => void calls.push([state, detail]) };
}
const last = (s: ReturnType<typeof sink>) => s.calls[s.calls.length - 1];

describe('RequestStatus', () => {
  test('success: loading then idle', () => {
    const s = sink();
    const r = new RequestStatus(s);
    r.begin();
    expect(last(s)).toEqual(['loading', undefined]);
    r.end({ state: 'idle' });
    expect(last(s)).toEqual(['idle', undefined]);
  });

  test('failure: loading then error with detail', () => {
    const s = sink();
    const r = new RequestStatus(s);
    r.begin();
    r.end({ state: 'error', detail: 'local: HTTP 500' });
    expect(last(s)).toEqual(['error', 'local: HTTP 500']);
  });

  test('a cancel never leaves loading: it restores the previous outcome', () => {
    const s = sink();
    const r = new RequestStatus(s);
    r.begin();
    r.end(undefined);
    expect(last(s)).toEqual(['idle', undefined]);
    r.begin();
    r.end({ state: 'error', detail: 'x' });
    r.begin();
    r.end(undefined);
    expect(last(s)).toEqual(['error', 'x']);
  });

  test('a cancelled older request does not clobber a newer one that is still loading', () => {
    const s = sink();
    const r = new RequestStatus(s);
    r.begin(); // older
    r.begin(); // newer
    r.end(undefined); // older aborted by the newer one
    expect(last(s)).toEqual(['loading', undefined]);
    r.end({ state: 'idle' });
    expect(last(s)).toEqual(['idle', undefined]);
  });

  test('the last request to finish shows the latest real outcome', () => {
    const s = sink();
    const r = new RequestStatus(s);
    r.begin();
    r.begin();
    r.end({ state: 'error', detail: 'a: HTTP 500' });
    expect(last(s)).toEqual(['loading', undefined]);
    r.end(undefined);
    expect(last(s)).toEqual(['error', 'a: HTTP 500']);
  });
});

describe('recordBackendFailure', () => {
  const at = (t: number) => () => t;

  test('warns once per backoff transition, not per failure', () => {
    const b = new ErrorBackoff(at(0));
    const first = recordBackendFailure(b, 'local', new TypeError('fetch failed'), { kind: 'network' }, false, 0);
    expect(first.detail).toBe('local: fetch failed');
    expect(first.warn).toBe('local: fetch failed; retrying in 2 s');
    // a second request failing while already backing off (e.g. another file) changes nothing
    const second = recordBackendFailure(b, 'local', new TypeError('fetch failed'), { kind: 'network' }, false, 0);
    expect(second.warn).toBeUndefined();
    expect(b.canRequest()).toBe(false);
  });

  test('401 is fatal and says so', () => {
    const b = new ErrorBackoff(at(0));
    const err = new HttpError(401, '{"error":"bad key"}', 'https://x/v1/completions');
    const r = recordBackendFailure(b, 'cloud', err, classifyError(err), false, 0);
    expect(r.detail).toBe('cloud: HTTP 401');
    expect(r.warn).toBe('cloud: HTTP 401; requests stopped until the settings change');
    expect(b.state()).toEqual({ kind: 'fatal', status: 401 });
  });

  test('the error body (servers may echo the prompt) is logged only with logPrompts', () => {
    const err = new HttpError(422, '{"detail":[{"input":"def secret():"}]}', 'https://x/v1/completions');
    const off = recordBackendFailure(new ErrorBackoff(at(0)), 'vllm', err, classifyError(err), false, 0);
    expect(off.warn).toBe('vllm: HTTP 422; retrying in 2 s');
    const on = recordBackendFailure(new ErrorBackoff(at(0)), 'vllm', err, classifyError(err), true, 0);
    expect(on.warn).toBe('vllm: HTTP 422 "{\\"detail\\":[{\\"input\\":\\"def secret():\\"}]}"; retrying in 2 s');
    expect(on.detail).toBe('vllm: HTTP 422');
  });

  test('aborts are not failures', () => {
    const b = new ErrorBackoff(at(0));
    const r = recordBackendFailure(b, 'local', new DOMException('aborted', 'AbortError'), { kind: 'abort' }, false, 0);
    expect(r.warn).toBeUndefined();
    expect(b.canRequest()).toBe(true);
  });
});

describe('describeFailure', () => {
  test('http status', () => expect(describeFailure(new HttpError(503, '', 'u'), { kind: 'http', status: 503 })).toBe('HTTP 503'));
  test('timeout', () => expect(describeFailure(new DOMException('t', 'TimeoutError'), { kind: 'network' })).toBe('timed out after 5 s'));
  test('connection refused shows the cause code', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    expect(describeFailure(err, { kind: 'network' })).toBe('fetch failed (ECONNREFUSED)');
  });
  test('non-Error values', () => expect(describeFailure('boom', { kind: 'network' })).toBe('boom'));
});
