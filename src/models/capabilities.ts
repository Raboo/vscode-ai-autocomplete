// What servers rejected or lack, learned per session. Nothing is persisted.
import { HttpError } from '../backends/http';
import type { RouteCaps } from '../backends/types';
import type { FimRoute } from '../completion/route';

export interface Learned { rejected: ReadonlySet<string>; failedRoutes: ReadonlySet<FimRoute>; thinkingMs?: number }

interface Entry { rejected: Set<string>; failedRoutes: Set<FimRoute>; thinkingMs?: number }

const EMPTY: Learned = { rejected: new Set(), failedRoutes: new Set() };

export class Capabilities {
  private readonly entries = new Map<string, Entry>();

  private key(backendId: string, model: string | undefined): string {
    return JSON.stringify([backendId, model ?? null]);
  }

  private entry(backendId: string, model: string | undefined): Entry {
    const k = this.key(backendId, model);
    let e = this.entries.get(k);
    if (!e) {
      e = { rejected: new Set(), failedRoutes: new Set() };
      this.entries.set(k, e);
    }
    return e;
  }

  get(backendId: string, model: string | undefined): Learned {
    return this.entries.get(this.key(backendId, model)) ?? EMPTY;
  }

  /** Returns the fields that were not known yet. */
  reject(backendId: string, model: string | undefined, fields: readonly string[]): string[] {
    const e = this.entry(backendId, model);
    const added: string[] = [];
    for (const f of fields) {
      if (!e.rejected.has(f)) {
        e.rejected.add(f);
        added.push(f);
      }
    }
    return added;
  }

  failRoute(backendId: string, model: string | undefined, route: FimRoute): boolean {
    const e = this.entry(backendId, model);
    if (e.failedRoutes.has(route)) return false;
    e.failedRoutes.add(route);
    return true;
  }

  /** True the first time; the latest latency is kept. */
  sawThinking(backendId: string, model: string | undefined, ms: number): boolean {
    const e = this.entry(backendId, model);
    const first = e.thinkingMs === undefined;
    e.thinkingMs = ms;
    return first;
  }

  /** Forgets the routes learned as missing for one backend (rejected fields and thinking latency stay). */
  forgetRoutes(backendId: string): void {
    for (const [k, e] of this.entries) if ((JSON.parse(k) as [string, string | null])[0] === backendId) e.failedRoutes.clear();
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The routes minus those learned as missing. */
export function usableRoutes(caps: RouteCaps, failed: ReadonlySet<FimRoute>): RouteCaps {
  return {
    ...caps,
    native: caps.native && !failed.has('native'),
    template: caps.template && !failed.has('template'),
    chat: caps.chat && !failed.has('chat'),
  };
}

/** 404, 405, 501, or a 400 whose body contains "does not support insert" (Ollama). A 404 whose body mentions "model" is a missing model, not a missing route. The body is matched only, never logged. */
export function isRouteMissing(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 404) return !/model/i.test(err.bodyText);
  if (err.status === 405 || err.status === 501) return true;
  return err.status === 400 && err.bodyText.includes('does not support insert');
}
