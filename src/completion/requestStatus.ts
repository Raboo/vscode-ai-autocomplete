import type { BackoffState, ErrorBackoff } from '../backends/backoff';
import { HttpError, type ErrorClass } from '../backends/http';

/** What a request leaves the status in. `disabled` and `snoozed` are derived from the settings by the status bar. */
export type RequestState = 'idle' | 'loading' | 'error';
export type StatusState = RequestState | 'disabled' | 'snoozed';
/** A command a shown error offers instead of the menu, e.g. opening the page that fixes it. */
export interface StatusAction { command: string; args: unknown[] }
export interface StatusSink { set(state: RequestState, detail?: string, action?: StatusAction): void }

/** How a finished request leaves the status; undefined (a cancel) keeps the previous outcome. */
export type Outcome = { state: 'idle' } | { state: 'error'; detail: string; action?: StatusAction };

/**
 * Status bookkeeping for FIM requests. Counts requests that showed `loading`; the last one to finish
 * shows the latest real outcome, so the status never stays at `loading` and a cancelled older request
 * never overwrites a newer one that is still running.
 */
export class RequestStatus {
  private active = 0;
  private latest: Outcome = { state: 'idle' };

  constructor(private readonly sink: StatusSink) {}

  begin(): void {
    this.active++;
    this.sink.set('loading');
  }

  end(outcome: Outcome | undefined): void {
    if (outcome) this.latest = outcome;
    this.active = Math.max(0, this.active - 1);
    this.show();
  }

  /** An outcome reached without sending a request (e.g. the model was not detected): shown now unless a request is running. */
  report(outcome: Outcome): void {
    this.latest = outcome;
    this.show();
  }

  private show(): void {
    if (this.active > 0) return;
    if (this.latest.state === 'error') this.sink.set('error', this.latest.detail, this.latest.action);
    else this.sink.set('idle');
  }
}

const SYSTEM_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Fixed-text description of a failed request for the status bar and the log. Never includes an error
 * message: those can quote server output (e.g. JSON.parse on a bad SSE line quotes the line).
 */
export function describeFailure(err: unknown, cls: ErrorClass, timeoutMs: number): string {
  if (cls.kind === 'http') return `HTTP ${cls.status}`;
  if ((err as { name?: unknown } | null)?.name === 'TimeoutError') return `timed out after ${timeoutMs / 1000} s`;
  if (err instanceof SyntaxError) return 'malformed response from server';
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  const sysCode = typeof code === 'string' && SYSTEM_CODE.test(code) ? code : undefined;
  if (err instanceof TypeError || sysCode) return sysCode ? `cannot reach backend (${sysCode})` : 'cannot reach backend';
  return 'request failed';
}

/** "retrying in N s" while the backend backs off; undefined when it may be tried now or is stopped for good. */
export function retryHint(state: BackoffState, now: number): string | undefined {
  return state.kind === 'backoff' ? `retrying in ${Math.ceil((state.until - now) / 1000)} s` : undefined;
}

/**
 * Records a failure in the backend's backoff. Returns the status detail, plus a warn line only when the
 * backoff state changed (one log line per transition, not one per keystroke). The server's error body is
 * added only when `logBody` (debug.logPrompts) is on: some servers echo the request, i.e. the prompt.
 */
export function recordBackendFailure(
  backoff: ErrorBackoff,
  backendId: string,
  err: unknown,
  cls: ErrorClass,
  logBody: boolean,
  timeoutMs: number,
  now = Date.now(),
): { detail: string; warn?: string } {
  const before = backoff.state().kind;
  backoff.recordFailure(cls);
  const after = backoff.state();
  const detail = `${backendId}: ${describeFailure(err, cls, timeoutMs)}`;
  if (after.kind === before) return { detail };
  const next = after.kind === 'fatal' ? 'requests stopped until the API key or settings change, or "Retry now"' : (retryHint(after, now) ?? 'retrying');
  const body = logBody && err instanceof HttpError && err.bodyText ? ` ${JSON.stringify(err.bodyText.slice(0, 200))}` : '';
  return { detail, warn: `${detail}${body}; ${next}` };
}
