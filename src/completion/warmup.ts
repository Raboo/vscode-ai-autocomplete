import type { FormatId } from '../nextEdit/formats/format';
import type { BackendKind } from '../types';
import { gate } from './gate';

/** A document is warmed at most once in this time. */
export const WARM_INTERVAL_MS = 30_000;

/**
 * Whether the URL's host is this machine: localhost, *.localhost, 127.0.0.0/8 or ::1.
 * Narrower than isObviouslyLocal (no private-network hosts): speculative requests only go to a server that costs nothing but local compute.
 */
export function isLoopback(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** What a warm-up or prefetch decision needs; none of it is code text. */
export interface SpeculateInput {
  /** The completion backend's kind and URL; undefined without a completion backend. */
  kind: BackendKind | undefined;
  baseUrl: string | undefined;
  /** Completions on (`enabled` and `completions.enabled`). */
  enabled: boolean;
  snoozedUntil: number;
  now: number;
  scheme: string;
  languageId: string;
  disabledLanguages: string[];
  fileExcluded: boolean;
  /** The backend failed recently and waits before the next try. */
  inBackoff: boolean;
  /** A request for this document (or another speculative one) is running. */
  busy: boolean;
}

export type Decision = { ok: true } | { ok: false; reason: string };

function canSpeculate(i: SpeculateInput): Decision {
  const no = (reason: string): Decision => ({ ok: false, reason });
  if (i.kind !== 'llamacpp' || i.baseUrl === undefined) return no('not llama.cpp');
  if (!isLoopback(i.baseUrl)) return no('not loopback');
  // The cursor rules (mid-word, several cursors, suggest widget) do not apply: nothing is shown.
  const g = gate({ ...i, selections: 1, hasSelectedCompletionInfo: false, lineSuffix: '', skipMidWord: false, invoked: false });
  if (!g.ok) return g;
  if (i.inBackoff) return no('backoff');
  if (i.busy) return no('busy');
  return { ok: true };
}

/** Whether to fill llama.cpp's prompt cache for a document that became active; `lastWarmAt` is when it was last warmed. */
export function shouldWarm(i: SpeculateInput, lastWarmAt: number | undefined): Decision {
  const d = canSpeculate(i);
  if (!d.ok) return d;
  if (lastWarmAt !== undefined && i.now - lastWarmAt < WARM_INTERVAL_MS) return { ok: false, reason: 'recent' };
  return d;
}

/** A Next Edit warm-up's input: `kind`, `baseUrl` and `enabled` describe the Next Edit backend and feature. */
export interface NextEditWarmInput extends SpeculateInput {
  /** Completions on (`enabled` and `completions.enabled`, with a completion backend): then they warm the cache and Next Edit does not. */
  completionsOn: boolean;
  format: FormatId;
}

/** Whether to fill the Next Edit slot's prompt cache: only when Next Edit runs alone, as a raw format on loopback llama.cpp. */
export function shouldWarmNextEdit(i: NextEditWarmInput, lastWarmAt: number | undefined): Decision {
  if (i.completionsOn) return { ok: false, reason: 'completions on' };
  if (i.format === 'chatXtab') return { ok: false, reason: 'not a raw format' };
  return shouldWarm(i, lastWarmAt);
}

/** Whether to ask for the completion at the cursor after an accepted one, to cache it without showing it. */
export function shouldPrefetch(i: SpeculateInput): Decision {
  return canSpeculate(i);
}

/** When each document was last warmed; entries older than the interval are dropped. */
export class WarmLimiter {
  private readonly at = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  last(uri: string): number | undefined {
    return this.at.get(uri);
  }

  /** A closed document's prompt cache is gone from the server's point of view; a document reopened under the same URI is warmed again. */
  forget(uri: string): void {
    this.at.delete(uri);
  }

  /** New settings may mean another backend or model, whose cache holds none of these documents. */
  clear(): void {
    this.at.clear();
  }

  mark(uri: string): void {
    const t = this.now();
    for (const [k, v] of this.at) if (t - v > WARM_INTERVAL_MS) this.at.delete(k);
    this.at.set(uri, t);
  }
}
