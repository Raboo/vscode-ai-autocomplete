/** What happened at one completion trigger. Only fixed reason text is kept: never code, prompts or completions. */
export type OutcomeKind = 'skipped' | 'cache' | 'joined' | 'shown' | 'empty' | 'noChange' | 'filtered' | 'error' | 'blocked' | 'cancelled';

/** Which feature asked: completions at the cursor, or Next Edit. */
export type Feature = 'completions' | 'nextEdit';

export interface CompletionOutcome {
  at: number;
  uri: string;
  feature: Feature;
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
  /** The same counts for Next Edit requests. */
  nextEdit: { requests: number; shown: number; accepted: number };
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
  private readonly counts: Record<Feature, { requests: number; shown: number; accepted: number }> = {
    completions: { requests: 0, shown: 0, accepted: 0 },
    nextEdit: { requests: 0, shown: 0, accepted: 0 },
  };

  record(o: CompletionOutcome): void {
    this.ring.push(o);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    if (o.kind === 'shown') this.counts[o.feature].shown++;
    if (o.ms !== undefined && (o.kind === 'shown' || o.kind === 'empty' || o.kind === 'noChange' || o.kind === 'filtered')) {
      this.latencies.push(o.ms);
      if (this.latencies.length > RING_SIZE) this.latencies.shift();
    }
  }

  /** A request left for the backend. */
  requestSent(feature: Feature = 'completions'): void {
    this.counts[feature].requests++;
  }

  accepted(feature: Feature = 'completions'): void {
    this.counts[feature].accepted++;
  }

  /** The outcomes for one document, newest first. */
  forUri(uri: string): CompletionOutcome[] {
    return this.ring.filter((o) => o.uri === uri).reverse();
  }

  stats(): SessionStats {
    const medianMs = median(this.latencies);
    const { completions: c, nextEdit } = this.counts;
    return { ...c, ...(medianMs !== undefined ? { medianMs } : {}), nextEdit: { ...nextEdit } };
  }
}

const SKIPPED: Record<string, string> = {
  disabled: 'completions are turned off',
  snoozed: 'AI Autocomplete is snoozed',
  scheme: 'this kind of document is not supported',
  language: 'completions are disabled for this language (completions.disableInLanguages)',
  'excluded file': 'this file is excluded (completions.disableInFiles)',
  'multi-cursor': 'there are several cursors',
  'suggest widget': 'the suggest widget is open',
  'mid-word': 'the cursor is inside a word (completions.skipMidWord)',
};

const BLOCKED: Record<string, string> = {
  'local-only': 'the backend is not local and Local Only is on (privacy.localOnly)',
  'no-backend': 'no backend is used for completions',
  'no-model': 'the backend needs a model; choose one in Manage Backends',
  'no-route': 'the backend has no usable prompt route or template for this model',
  thinking: 'the model keeps thinking; choose another thinking switch or model',
  backoff: 'the backend failed recently and is paused before the next try',
};

const NEXT_EDIT_BLOCKED: Record<string, string> = { ...BLOCKED, 'no-backend': 'no backend is used for Next Edit' };

/** Reasons Next Edit did not ask. */
const NEXT_EDIT_SKIPPED: Record<string, string> = {
  disabled: 'Next Edit is turned off',
  snoozed: 'AI Autocomplete is snoozed',
  excluded: 'this file is excluded (completions.disableInFiles or completions.disableInLanguages)',
  reserved: "the code holds a string the model's format reserves",
  tooLong: 'the lines around the cursor are too long to send',
};

/** Why Next Edit dropped an answer. */
const NEXT_EDIT_FILTERED: Record<string, string> = {
  invalid: 'the answer could not be used',
  truncated: 'the answer was cut off at the token limit',
  trivial: 'the change was empty or trivial',
  'editor-changed': 'the editor changed while the model answered',
  snoozed: 'AI Autocomplete was snoozed while the model answered',
  'document-changed': 'the document changed while the model answered',
  'cursor-moved': 'the cursor moved while the model answered',
  'needs-inline-edit-ui': "the suggestion needs VS Code's inline-edit view",
};

/** The outcome in plain language, e.g. "Skipped: the cursor is inside a word (completions.skipMidWord)". */
export function describeOutcome(o: CompletionOutcome): string {
  const d = o.detail ?? '';
  const ms = o.ms !== undefined ? ` (${o.ms} ms)` : '';
  switch (o.kind) {
    case 'skipped': return `Skipped: ${(o.feature === 'nextEdit' ? NEXT_EDIT_SKIPPED : SKIPPED)[d] ?? d}`;
    case 'noChange': return `The model proposed no change${ms}`;
    case 'blocked': return `Blocked: ${(o.feature === 'nextEdit' ? NEXT_EDIT_BLOCKED : BLOCKED)[d] ?? d}`;
    case 'cache': return `Reused an earlier answer${o.chars === 0 ? ' (it was empty)' : ''}`;
    case 'joined': return 'Joined a request that was already running';
    case 'shown': return `Suggestion shown (${o.chars ?? 0} characters${o.ms !== undefined ? `, ${o.ms} ms` : ''})`;
    case 'empty': return `The model answered with nothing${o.ms !== undefined ? ` (${o.ms} ms)` : ''}`;
    case 'filtered': return o.feature === 'nextEdit' ? `Dropped: ${NEXT_EDIT_FILTERED[d] ?? d}${ms}` : `Nothing left after cleanup${ms}`;
    case 'error': return `Error: ${d}`;
    case 'cancelled': return o.feature === 'nextEdit' ? 'Cancelled: the document changed' : 'Cancelled: a newer request replaced it';
  }
}

/** The quick pick label: the feature, then the outcome. */
export function outcomeLabel(o: CompletionOutcome): string {
  return `${o.feature === 'nextEdit' ? 'Next Edit' : 'Completions'}: ${describeOutcome(o)}`;
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

/** The tooltip line for Next Edit, e.g. "Next Edit this session: 4 requests · 2 shown · 1 accepted"; undefined before any activity. */
export function nextEditLine(s: SessionStats['nextEdit']): string | undefined {
  if (s.requests === 0 && s.shown === 0 && s.accepted === 0) return undefined;
  return `Next Edit this session: ${s.requests} ${s.requests === 1 ? 'request' : 'requests'} · ${s.shown} shown · ${s.accepted} accepted`;
}
