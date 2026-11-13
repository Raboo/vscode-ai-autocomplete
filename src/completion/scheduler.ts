const LATENCY_WINDOW = 10;

export interface DebouncerOptions {
  initialMs: number;
  minMs: number;
  maxMs: number;
  fixedMs: number | null;
  now?: () => number;
}

/** Adaptive debounce with a leading edge: wait() resolves true when the caller should request. */
export class Debouncer {
  private latencies: number[] = [];
  private lastCall = -Infinity;
  private pending:
    | {
        resolve: (v: boolean) => void;
        timer: ReturnType<typeof setTimeout>;
        cleanup: () => void;
      }
    | undefined;
  private readonly now: () => number;

  constructor(private readonly o: DebouncerOptions) {
    this.now = o.now ?? Date.now;
  }

  recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }

  delayMs(): number {
    let ms: number;
    if (this.o.fixedMs !== null) ms = this.o.fixedMs;
    else if (this.latencies.length === 0) ms = this.o.initialMs;
    else ms = this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
    return Math.min(this.o.maxMs, Math.max(this.o.minMs, ms));
  }

  wait(signal: AbortSignal): Promise<boolean> {
    const t = this.now();
    const elapsed = t - this.lastCall;
    this.lastCall = t;
    this.settlePending(false);

    if (signal.aborted) return Promise.resolve(false);
    const delay = this.delayMs();
    if (elapsed > delay) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => this.settlePending(false);
      const timer = setTimeout(() => this.settlePending(true), delay);
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending = { resolve, timer, cleanup };
    });
  }

  private settlePending(value: boolean): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    clearTimeout(p.timer);
    p.cleanup();
    p.resolve(value);
  }
}

interface Flight {
  uri: string;
  prefix: string;
  suffix: string;
  result: Promise<string | undefined>;
  ctl: AbortController;
}

/** Tracks running requests so a later keystroke can join one instead of starting another. */
export class InFlight {
  private flights: Flight[] = [];

  find(
    uri: string,
    prefix: string,
    suffix: string,
  ): { prefix: string; result: Promise<string | undefined> } | undefined {
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      if (f.uri === uri && f.suffix === suffix && prefix.startsWith(f.prefix)) {
        return { prefix: f.prefix, result: f.result };
      }
    }
    return undefined;
  }

  add(
    uri: string,
    prefix: string,
    suffix: string,
    result: Promise<string | undefined>,
    ctl: AbortController,
  ): void {
    const flight: Flight = { uri, prefix, suffix, result, ctl };
    this.flights.push(flight);
    const remove = (): void => {
      this.flights = this.flights.filter((f) => f !== flight);
    };
    result.then(remove, remove);
  }

  abortAll(uri: string): void {
    const mine = this.flights.filter((f) => f.uri === uri);
    this.flights = this.flights.filter((f) => f.uri !== uri);
    for (const f of mine) f.ctl.abort();
  }
}
