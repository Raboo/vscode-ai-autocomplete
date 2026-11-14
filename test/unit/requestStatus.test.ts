import { describe, expect, test } from 'vitest';
import { ErrorBackoff } from '../../src/backends/backoff';
import { classifyError, HttpError } from '../../src/backends/http';
import { describeFailure, RequestStatus, recordBackendFailure, retryHint, type StatusSink } from '../../src/completion/requestStatus';

function sink(): StatusSink & { calls: [string, string | undefined][]; actions: unknown[] } {
  const calls: [string, string | undefined][] = [];
  const actions: unknown[] = [];
  return { calls, actions, set: (state, detail, action) => void (calls.push([state, detail]), actions.push(action)) };
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

  test('report: an outcome without a request is shown on every call', () => {
    const s = sink();
    const r = new RequestStatus(s);
    r.report({ state: 'error', detail: 'local: model not detected' });
    r.report({ state: 'error', detail: 'local: model not detected' });
    expect(s.calls).toEqual([
      ['error', 'local: model not detected'],
      ['error', 'local: model not detected'],
    ]);
  });

  test('RequestStatus forwards the action of an error outcome', () => {
    const s = sink();
    const r = new RequestStatus(s);
    const action = { command: 'aiAutocomplete.manageBackends', args: [{ focus: 'a' }] };
    r.report({ state: 'error', detail: 'a: no completion template', action });
    expect(last(s)).toEqual(['error', 'a: no completion template']);
    expect(s.actions[s.actions.length - 1]).toEqual(action);
    r.begin();
    r.end({ state: 'idle' });
    expect(s.actions[s.actions.length - 1]).toBeUndefined();
  });

  test('report while a request runs: loading stays, and a later cancel restores the reported outcome', () => {
    const s = sink();
    const r = new RequestStatus(s);
    r.begin();
    r.report({ state: 'error', detail: 'local: model not detected' });
    expect(last(s)).toEqual(['loading', undefined]);
    r.end(undefined);
    expect(last(s)).toEqual(['error', 'local: model not detected']);
    // a later successful request clears it
    r.begin();
    r.end({ state: 'idle' });
    expect(last(s)).toEqual(['idle', undefined]);
  });
});

describe('recordBackendFailure', () => {
  const at = (t: number) => () => t;

  test('warns once per backoff transition, not per failure', () => {
    const b = new ErrorBackoff(at(0));
    const first = recordBackendFailure(b, 'local', new TypeError('fetch failed'), { kind: 'network' }, false, 5000, 0);
    expect(first.detail).toBe('local: cannot reach backend');
    expect(first.warn).toBe('local: cannot reach backend; retrying in 2 s');
    // a second request failing while already backing off (e.g. another file) changes nothing
    const second = recordBackendFailure(b, 'local', new TypeError('fetch failed'), { kind: 'network' }, false, 5000, 0);
    expect(second.warn).toBeUndefined();
    expect(b.canRequest()).toBe(false);
  });

  test('401 is fatal and says so', () => {
    const b = new ErrorBackoff(at(0));
    const err = new HttpError(401, '{"error":"bad key"}', 'https://x/v1/completions');
    const r = recordBackendFailure(b, 'cloud', err, classifyError(err), false, 5000, 0);
    expect(r.detail).toBe('cloud: HTTP 401');
    expect(r.warn).toBe('cloud: HTTP 401; requests stopped until the API key or settings change, or "Retry now"');
    expect(b.state()).toEqual({ kind: 'fatal', status: 401 });
  });

  test('the error body (servers may echo the prompt) is logged only with logPrompts', () => {
    const err = new HttpError(422, '{"detail":[{"input":"def secret():"}]}', 'https://x/v1/completions');
    const off = recordBackendFailure(new ErrorBackoff(at(0)), 'vllm', err, classifyError(err), false, 5000, 0);
    expect(off.warn).toBe('vllm: HTTP 422; retrying in 2 s');
    const on = recordBackendFailure(new ErrorBackoff(at(0)), 'vllm', err, classifyError(err), true, 5000, 0);
    expect(on.warn).toBe('vllm: HTTP 422 "{\\"detail\\":[{\\"input\\":\\"def secret():\\"}]}"; retrying in 2 s');
    expect(on.detail).toBe('vllm: HTTP 422');
  });

  test('aborts are not failures', () => {
    const b = new ErrorBackoff(at(0));
    const r = recordBackendFailure(b, 'local', new DOMException('aborted', 'AbortError'), { kind: 'abort' }, false, 5000, 0);
    expect(r.warn).toBeUndefined();
    expect(b.canRequest()).toBe(true);
  });
});

describe('retryHint', () => {
  test('counts the seconds left while the backend backs off, rounding up', () => {
    expect(retryHint({ kind: 'backoff', until: 10_000 }, 0)).toBe('retrying in 10 s');
    expect(retryHint({ kind: 'backoff', until: 10_000 }, 9_001)).toBe('retrying in 1 s');
  });
  test('reads the until of a real ErrorBackoff (open circuit: 5 min)', () => {
    let now = 0;
    const b = new ErrorBackoff(() => now);
    for (let i = 0; i < 5; i++) b.recordFailure({ kind: 'network' });
    expect(retryHint(b.state(), now)).toBe('retrying in 300 s');
    now = 299_500;
    expect(retryHint(b.state(), now)).toBe('retrying in 1 s');
  });
  test('nothing when the backend may be tried, or is stopped for good', () => {
    expect(retryHint({ kind: 'ok' }, 0)).toBeUndefined();
    expect(retryHint({ kind: 'fatal', status: 401 }, 0)).toBeUndefined();
  });
});

describe('describeFailure', () => {
  test('http status', () => expect(describeFailure(new HttpError(503, '', 'u'), { kind: 'http', status: 503 }, 5000)).toBe('HTTP 503'));
  test('timeout detail names the actual timeout', () => expect(describeFailure(new DOMException('t', 'TimeoutError'), { kind: 'network' }, 9000)).toBe('timed out after 9 s'));
  test('timeout', () => expect(describeFailure(new DOMException('t', 'TimeoutError'), { kind: 'network' }, 5000)).toBe('timed out after 5 s'));
  test('connection refused shows the system error code, not the message', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('connect 127.0.0.1:8012'), { code: 'ECONNREFUSED' }) });
    expect(describeFailure(err, { kind: 'network' }, 5000)).toBe('cannot reach backend (ECONNREFUSED)');
    expect(describeFailure(new TypeError('fetch failed'), { kind: 'network' }, 5000)).toBe('cannot reach backend');
  });
  test('a malformed stream never leaks server output', () => {
    // Node's JSON.parse quotes the start of the bad input in its message
    const err = new SyntaxError('Unexpected token \'d\', "def secret"... is not valid JSON');
    const d = describeFailure(err, { kind: 'network' }, 5000);
    expect(d).toBe('malformed response from server');
    expect(d).not.toContain('secret');
  });
  test('unknown errors use fixed text', () => {
    expect(describeFailure(new Error('server said: def secret()'), { kind: 'network' }, 5000)).toBe('request failed');
    expect(describeFailure('boom', { kind: 'network' }, 5000)).toBe('request failed');
    // a cause code that is not a plain system code is ignored
    expect(describeFailure(new TypeError('x', { cause: { code: 'def secret' } }), { kind: 'network' }, 5000)).toBe('cannot reach backend');
  });
});
