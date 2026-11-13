import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Debouncer, InFlight } from "../../src/completion/scheduler";

const opts = { initialMs: 300, minMs: 50, maxMs: 600, fixedMs: null };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Debouncer", () => {
  test("first call fires immediately (leading edge)", async () => {
    const d = new Debouncer(opts);
    await expect(d.wait(new AbortController().signal)).resolves.toBe(true);
  });

  test("burst: only the last waiter resolves true after delay", async () => {
    const d = new Debouncer(opts);
    await d.wait(new AbortController().signal);
    const results: boolean[] = [];
    const w1 = d
      .wait(new AbortController().signal)
      .then((v) => results.push(v));
    const w2 = d
      .wait(new AbortController().signal)
      .then((v) => results.push(v));
    await w1;
    expect(results).toEqual([false]);
    await vi.advanceTimersByTimeAsync(299);
    expect(results).toEqual([false]);
    await vi.advanceTimersByTimeAsync(1);
    await w2;
    expect(results).toEqual([false, true]);
  });

  test("abort resolves false and clears the timer", async () => {
    const d = new Debouncer(opts);
    await d.wait(new AbortController().signal);
    const ctl = new AbortController();
    const p = d.wait(ctl.signal);
    ctl.abort();
    await expect(p).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("already aborted signal resolves false", async () => {
    const d = new Debouncer(opts);
    const ctl = new AbortController();
    ctl.abort();
    await expect(d.wait(ctl.signal)).resolves.toBe(false);
  });

  test("adaptive delay = clamp(avg of last 10 latencies, min, max)", () => {
    const d = new Debouncer(opts);
    expect(d.delayMs()).toBe(300);
    d.recordLatency(100);
    d.recordLatency(200);
    expect(d.delayMs()).toBe(150);
    d.recordLatency(10);
    for (let i = 0; i < 9; i++) d.recordLatency(10);
    expect(d.delayMs()).toBe(50); // only last 10 (all 10) -> 10, clamped up
    for (let i = 0; i < 10; i++) d.recordLatency(5000);
    expect(d.delayMs()).toBe(600);
  });

  test("fixedMs overrides adaptive", () => {
    const d = new Debouncer({ ...opts, fixedMs: 123 });
    d.recordLatency(500);
    expect(d.delayMs()).toBe(123);
  });

  test("fixedMs is clamped", () => {
    expect(new Debouncer({ ...opts, fixedMs: 5 }).delayMs()).toBe(50);
  });

  test("uses injected now for leading edge", async () => {
    let t = 1000;
    const d = new Debouncer({ ...opts, now: () => t });
    await d.wait(new AbortController().signal);
    t += 301;
    await expect(d.wait(new AbortController().signal)).resolves.toBe(true);
  });
});

describe("InFlight", () => {
  const U = "file:///a.ts";
  const S = "\n}";

  test("find returns a request whose prefix is a prefix of the new one with same suffix", async () => {
    const f = new InFlight();
    const result = new Promise<string | undefined>(() => {});
    f.add(U, "ab", S, result, new AbortController());
    expect(f.find(U, "abc", S)?.prefix).toBe("ab");
    expect(f.find(U, "abc", S)?.result).toBe(result);
    expect(f.find(U, "a", S)).toBeUndefined();
    expect(f.find(U, "abc", "other")).toBeUndefined();
    expect(f.find("file:///b.ts", "abc", S)).toBeUndefined();
  });

  test("entry removed when result settles (resolve or reject)", async () => {
    const f = new InFlight();
    f.add(U, "a", S, Promise.resolve("x"), new AbortController());
    f.add(U, "b", S, Promise.reject(new Error("boom")), new AbortController());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.find(U, "a", S)).toBeUndefined();
    expect(f.find(U, "b", S)).toBeUndefined();
  });

  test("abortEverything aborts every flight, without a reason, and forgets them", () => {
    const f = new InFlight();
    const a = new AbortController();
    const b = new AbortController();
    const spy = vi.spyOn(a, "abort");
    f.add(U, "a", S, new Promise(() => {}), a);
    f.add("file:///b.ts", "a", S, new Promise(() => {}), b);
    f.abortEverything();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(spy).toHaveBeenCalledWith();
    expect(f.find(U, "a", S)).toBeUndefined();
    expect(f.find("file:///b.ts", "a", S)).toBeUndefined();
  });

  test("abortAll aborts controllers for that uri only, without a reason", () => {
    const f = new InFlight();
    const a = new AbortController();
    const b = new AbortController();
    const spy = vi.spyOn(a, "abort");
    f.add(U, "a", S, new Promise(() => {}), a);
    f.add("file:///b.ts", "a", S, new Promise(() => {}), b);
    f.abortAll(U);
    expect(a.signal.aborted).toBe(true);
    expect(spy).toHaveBeenCalledWith();
    expect(b.signal.aborted).toBe(false);
    expect(f.find(U, "a", S)).toBeUndefined();
    expect(f.find("file:///b.ts", "a", S)).toBeDefined();
  });
});
