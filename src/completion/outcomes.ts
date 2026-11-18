/** What happened at one completion trigger. Only fixed reason text is kept: never code, prompts or completions. */
export type OutcomeKind = 'skipped' | 'cache' | 'joined' | 'shown' | 'empty' | 'filtered' | 'error' | 'blocked' | 'cancelled';

export interface CompletionOutcome {
  at: number;
  uri: string;
  kind: OutcomeKind;
  /** A fixed key or fixed text (the gate reason, the blocked reason, the status text of a failure). */
  detail?: string;
  ms?: number;
  chars?: number;
}

export interface SessionStats {
  requests: number;
  shown: number;
  accepted: number;
  /** Median latency of the last answered requests; undefined when there are none. */
  medianMs?: number;
}

export const RING_SIZE = 20;

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** In-memory only: the last outcomes of this window and the session counts. Nothing is persisted or sent. */
export class OutcomeLog {
  private ring: CompletionOutcome[] = [];
  private latencies: number[] = [];
  private requests = 0;
  private shown = 0;
  private acceptedCount = 0;

  record(o: CompletionOutcome): void {
    this.ring.push(o);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    if (o.kind === 'shown') this.shown++;
    if (o.ms !== undefined && (o.kind === 'shown' || o.kind === 'empty' || o.kind === 'filtered')) {
      this.latencies.push(o.ms);
      if (this.latencies.length > RING_SIZE) this.latencies.shift();
    }
  }

  /** A request left for the backend. */
  requestSent(): void {
    this.requests++;
  }

  accepted(): void {
    this.acceptedCount++;
  }

  /** The outcomes for one document, newest first. */
  forUri(uri: string): CompletionOutcome[] {
    return this.ring.filter((o) => o.uri === uri).reverse();
  }

  stats(): SessionStats {
    const medianMs = median(this.latencies);
    return { requests: this.requests, shown: this.shown, accepted: this.acceptedCount, ...(medianMs !== undefined ? { medianMs } : {}) };
  }
}

const SKIPPED: Record<string, string> = {
  disabled: 'completions are turned off',
  snoozed: 'AI Autocomplete is snoozed',
  scheme: 'this kind of document is not supported',
  language: 'completions are disabled for this language (fim.disableInLanguages)',
  'excluded file': 'this file is excluded (fim.disableInFiles)',
  'multi-cursor': 'there are several cursors',
  'suggest widget': 'the suggest widget is open',
  'mid-word': 'the cursor is inside a word (fim.skipMidWord)',
};

const BLOCKED: Record<string, string> = {
  'local-only': 'the backend is not local and Local Only is on (privacy.localOnly)',
  'no-backend': 'no backend is used for completions',
  'no-model': 'the backend needs a model; choose one in Manage Backends',
  'no-route': 'the backend has no usable prompt route or template for this model',
  thinking: 'the model keeps thinking; choose another thinking switch or model',
  backoff: 'the backend failed recently and is paused before the next try',
};

/** The outcome in plain language, e.g. "Skipped: the cursor is inside a word (fim.skipMidWord)". */
export function describeOutcome(o: CompletionOutcome): string {
  const d = o.detail ?? '';
  switch (o.kind) {
    case 'skipped': return `Skipped: ${SKIPPED[d] ?? d}`;
    case 'blocked': return `Blocked: ${BLOCKED[d] ?? d}`;
    case 'cache': return `Reused an earlier answer${o.chars === 0 ? ' (it was empty)' : ''}`;
    case 'joined': return 'Joined a request that was already running';
    case 'shown': return `Suggestion shown (${o.chars ?? 0} characters${o.ms !== undefined ? `, ${o.ms} ms` : ''})`;
    case 'empty': return `The model answered with nothing${o.ms !== undefined ? ` (${o.ms} ms)` : ''}`;
    case 'filtered': return `Nothing left after cleanup${o.ms !== undefined ? ` (${o.ms} ms)` : ''}`;
    case 'error': return `Error: ${d}`;
    case 'cancelled': return 'Cancelled: a newer request replaced it';
  }
}

/** "12 s ago", "3 min ago", "2 h ago". */
export function relativeTime(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

/** The tooltip line, e.g. "This session: 42 requests · 17 shown · 9 accepted · median 380 ms". */
export function sessionLine(s: SessionStats): string {
  const parts = [`${s.requests} ${s.requests === 1 ? 'request' : 'requests'}`, `${s.shown} shown`, `${s.accepted} accepted`];
  if (s.medianMs !== undefined) parts.push(`median ${s.medianMs} ms`);
  return `This session: ${parts.join(' · ')}`;
}
