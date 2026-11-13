import type { ErrorClass } from './http';

const BASE_MS = 2000;
const FACTOR = 2;
const CAP_MS = 120000;
const CIRCUIT_FAILURES = 5;
const CIRCUIT_MS = 300000;
const FATAL_STATUSES = new Set([401, 402, 403]);

export type BackoffState = { kind: 'ok' } | { kind: 'backoff'; until: number } | { kind: 'fatal'; status: number };

/** Tracks consecutive backend failures and decides whether a new request may be sent. */
export class ErrorBackoff {
  private failures = 0;
  private until = 0;
  private fatalStatus: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  canRequest(): boolean {
    return this.fatalStatus === undefined && this.now() >= this.until;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.until = 0;
  }

  recordFailure(e: ErrorClass): void {
    if (e.kind === 'abort') {
      return;
    }
    if (e.kind === 'http' && FATAL_STATUSES.has(e.status)) {
      this.fatalStatus = e.status;
      return;
    }
    this.failures++;
    const delay =
      this.failures >= CIRCUIT_FAILURES
        ? CIRCUIT_MS
        : Math.min(BASE_MS * FACTOR ** (this.failures - 1), CAP_MS);
    this.until = this.now() + delay;
  }

  state(): BackoffState {
    if (this.fatalStatus !== undefined) {
      return { kind: 'fatal', status: this.fatalStatus };
    }
    if (this.now() < this.until) {
      return { kind: 'backoff', until: this.until };
    }
    return { kind: 'ok' };
  }

  reset(): void {
    this.failures = 0;
    this.until = 0;
    this.fatalStatus = undefined;
  }
}
