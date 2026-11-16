import { describe, expect, it } from "vitest";
import {
  classify,
  isTrivialEdit,
  regionEdit,
  toItemText,
} from "../../../src/nextEdit/diff";

const doc = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);

describe("regionEdit", () => {
  it("trims common lines", () => {
    expect(regionEdit(["a", "b", "c"], ["a", "B", "c"], 10)).toEqual({
      startLine: 11,
      endLine: 12,
      newLines: ["B"],
    });
  });

  it("of an echo is undefined", () => {
    expect(regionEdit(["a", "b"], ["a", "b"], 3)).toBeUndefined();
    expect(regionEdit([], [], 0)).toBeUndefined();
  });

  it("of a longer answer is an insertion", () => {
    expect(regionEdit(["a", "c"], ["a", "b", "c"], 0)).toEqual({
      startLine: 1,
      endLine: 1,
      newLines: ["b"],
    });
  });

  it("of a deletion has no new lines", () => {
    expect(regionEdit(["a", "b", "c"], ["a", "c"], 5)).toEqual({
      startLine: 6,
      endLine: 7,
      newLines: [],
    });
  });

  it("never lets the leading and trailing trims overlap", () => {
    expect(regionEdit(["a", "a"], ["a"], 0)).toEqual({
      startLine: 1,
      endLine: 2,
      newLines: [],
    });
    expect(regionEdit(["a"], ["a", "a"], 0)).toEqual({
      startLine: 1,
      endLine: 1,
      newLines: ["a"],
    });
  });
});

describe("isTrivialEdit", () => {
  it("treats whitespace-only and blank-line-only edits as trivial", () => {
    const lines = ["a", "  b", "c"];
    expect(
      isTrivialEdit({ startLine: 1, endLine: 2, newLines: ["b   "] }, lines),
    ).toBe(true);
    expect(
      isTrivialEdit({ startLine: 1, endLine: 1, newLines: ["", "  "] }, lines),
    ).toBe(true);
    expect(
      isTrivialEdit({ startLine: 1, endLine: 2, newLines: [] }, ["a", "", "c"]),
    ).toBe(true);
    expect(
      isTrivialEdit({ startLine: 1, endLine: 2, newLines: ["B"] }, lines),
    ).toBe(false);
    expect(
      isTrivialEdit({ startLine: 1, endLine: 2, newLines: [] }, lines),
    ).toBe(false);
  });
});

describe("classify ghost text", () => {
  it("an insertion at the cursor is ghost text", () => {
    const lines = ["a", "  return a", "b"];
    const e = { startLine: 1, endLine: 2, newLines: ["  return a + b"] };
    expect(classify(e, lines, { line: 1, character: 10 })).toEqual({
      kind: "ghost",
      insertText: " + b",
    });
  });

  it("lines inserted after the cursor line at its end are ghost text", () => {
    const lines = doc(6);
    const e = { startLine: 4, endLine: 4, newLines: ["  x()"] };
    expect(classify(e, lines, { line: 3, character: lines[3].length })).toEqual(
      {
        kind: "ghost",
        insertText: "\n  x()",
      },
    );
  });

  it("works with the cursor on line 0", () => {
    const lines = ["foo", "bar"];
    const e = { startLine: 0, endLine: 1, newLines: ["foo()"] };
    expect(classify(e, lines, { line: 0, character: 3 })).toEqual({
      kind: "ghost",
      insertText: "()",
    });
  });

  it("works with the cursor on the last line and lines inserted after it", () => {
    const lines = ["a", "b"];
    const e = { startLine: 2, endLine: 2, newLines: ["c"] };
    expect(classify(e, lines, { line: 1, character: 1 })).toEqual({
      kind: "ghost",
      insertText: "\nc",
    });
  });

  it("is an inline edit when lines are inserted after the cursor line but the cursor is mid-line", () => {
    const lines = doc(6);
    const e = { startLine: 4, endLine: 4, newLines: ["  x()"] };
    expect(classify(e, lines, { line: 3, character: 2 }).kind).toBe("edit");
  });

  it("a change before the cursor on the cursor line is an inline edit, not ghost text", () => {
    const lines = ["let a = 1"];
    const e = { startLine: 0, endLine: 1, newLines: ["const a = 1"] };
    expect(classify(e, lines, { line: 0, character: 9 })).toEqual({
      kind: "edit",
      start: { line: 0, character: 0 },
      end: { line: 0, character: 9 },
      text: "const a = 1",
    });
  });
});

describe("classify inline edit", () => {
  it("an edit on another line has its exact range", () => {
    const lines = doc(10);
    lines[7] = "def g(r):";
    const e = { startLine: 7, endLine: 8, newLines: ["def g(radius):"] };
    expect(classify(e, lines, { line: 4, character: 0 })).toEqual({
      kind: "edit",
      start: { line: 7, character: 0 },
      end: { line: 7, character: 9 },
      text: "def g(radius):",
    });
  });

  it("a multi-line replacement ends at the end of its last line", () => {
    const lines = doc(10);
    const e = { startLine: 6, endLine: 8, newLines: ["x", "y", "z"] };
    expect(classify(e, lines, { line: 1, character: 0 })).toEqual({
      kind: "edit",
      start: { line: 6, character: 0 },
      end: { line: 7, character: 6 },
      text: "x\ny\nz",
    });
  });

  it("a pure line insertion away from the cursor is an inline edit at the line start", () => {
    const lines = doc(10);
    const e = { startLine: 6, endLine: 6, newLines: ["x", "y"] };
    expect(classify(e, lines, { line: 1, character: 0 })).toEqual({
      kind: "edit",
      start: { line: 6, character: 0 },
      end: { line: 6, character: 0 },
      text: "x\ny\n",
    });
  });

  it("a pure deletion covers whole lines", () => {
    const lines = doc(10);
    const e = { startLine: 5, endLine: 7, newLines: [] };
    expect(classify(e, lines, { line: 1, character: 0 })).toEqual({
      kind: "edit",
      start: { line: 5, character: 0 },
      end: { line: 7, character: 0 },
      text: "",
    });
  });

  it("deleting the last lines of the file does not leave an empty line", () => {
    const lines = doc(10);
    const e = { startLine: 8, endLine: 10, newLines: [] };
    expect(classify(e, lines, { line: 1, character: 0 })).toEqual({
      kind: "edit",
      start: { line: 7, character: 6 },
      end: { line: 9, character: 6 },
      text: "",
    });
  });

  it("deleting the whole document covers it all", () => {
    const lines = ["ab", "cde"];
    const e = { startLine: 0, endLine: 2, newLines: [] };
    expect(classify(e, lines, { line: 0, character: 0 })).toEqual({
      kind: "edit",
      start: { line: 0, character: 0 },
      end: { line: 1, character: 3 },
      text: "",
    });
  });

  it("an insertion after the last line goes to the end of the last line", () => {
    const lines = doc(5);
    const e = { startLine: 5, endLine: 5, newLines: ["x", "y"] };
    expect(classify(e, lines, { line: 0, character: 0 })).toEqual({
      kind: "edit",
      start: { line: 4, character: 6 },
      end: { line: 4, character: 6 },
      text: "\nx\ny",
    });
  });
});

describe("toItemText", () => {
  it("converts line breaks to CRLF", () => {
    expect(toItemText("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(toItemText("a\r\nb", "\r\n")).toBe("a\r\nb");
    expect(toItemText("a\nb", "\n")).toBe("a\nb");
  });

  it("carries a CRLF document edit through classify", () => {
    const lines = "a\r\nb\r\nc".split(/\r?\n/);
    const show = classify(
      { startLine: 1, endLine: 1, newLines: ["x"] },
      lines,
      { line: 2, character: 0 },
    );
    if (show.kind !== "edit") throw new Error("expected edit");
    expect(toItemText(show.text, "\r\n")).toBe("x\r\n");
  });
});
