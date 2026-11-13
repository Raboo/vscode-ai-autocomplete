import { describe, expect, test } from "vitest";
import { SuggestionCache } from "../../src/completion/cache";

const U = "file:///a.ts";
const P = "function x() {\n  return ";
const S = "\n}";

describe("SuggestionCache", () => {
  test("exact match", () => {
    const c = new SuggestionCache();
    c.add(U, P, S, "foo()");
    expect(c.find(U, P, S)).toBe("foo()");
  });

  test("typed-through", () => {
    const c = new SuggestionCache();
    c.add(U, P, S, "foo()");
    expect(c.find(U, P + "fo", S)).toBe("o()");
  });

  test("typed-through fully consumed -> undefined", () => {
    const c = new SuggestionCache();
    c.add(U, P, S, "foo()");
    expect(c.find(U, P + "foo()", S)).toBeUndefined();
  });

  test("typed text diverging -> undefined", () => {
    const c = new SuggestionCache();
    c.add(U, P, S, "foo()");
    expect(c.find(U, P + "fx", S)).toBeUndefined();
  });

  test("backspace", () => {
    const c = new SuggestionCache();
    c.add(U, P + "ab", S, "c");
    expect(c.find(U, P + "a", S)).toBe("bc");
  });

  test("backspace across a newline does not match", () => {
    const c = new SuggestionCache();
    c.add(U, P + "\n", S, "c");
    expect(c.find(U, P, S)).toBeUndefined();
  });

  test("suffix must match", () => {
    const c = new SuggestionCache();
    c.add(U, P, S, "foo()");
    expect(c.find(U, P, "\n}}")).toBeUndefined();
    expect(c.find(U, P + "f", "\n}}")).toBeUndefined();
  });

  test("empty result is cached as ''", () => {
    const c = new SuggestionCache();
    c.add(U, P, S, "");
    expect(c.find(U, P, S)).toBe("");
  });

  test("per-uri isolation", () => {
    const c = new SuggestionCache();
    c.add(U, P, S, "foo()");
    expect(c.find("file:///b.ts", P, S)).toBeUndefined();
  });

  test("evicts oldest beyond max", () => {
    const c = new SuggestionCache(2);
    c.add(U, "a", S, "1");
    c.add(U, "b", S, "2");
    c.add(U, "c", S, "3");
    expect(c.find(U, "a", S)).toBeUndefined();
    expect(c.find(U, "b", S)).toBe("2");
    expect(c.find(U, "c", S)).toBe("3");
  });

  test("add replaces existing entry and makes it newest", () => {
    const c = new SuggestionCache(2);
    c.add(U, "a", S, "1");
    c.add(U, "b", S, "2");
    c.add(U, "a", S, "new");
    c.add(U, "c", S, "3");
    expect(c.find(U, "a", S)).toBe("new");
    expect(c.find(U, "b", S)).toBeUndefined();
  });

  test("newest entry wins when several match", () => {
    const c = new SuggestionCache();
    c.add(U, "x", S, "old1");
    c.add(U, "xy", S, "zold");
    expect(c.find(U, "xyz", S)).toBe("old");
  });
});
