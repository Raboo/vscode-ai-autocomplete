import { describe, expect, it } from "vitest";
import { rebaseEdit } from "../../../src/nextEdit/rebase";

const text = (lines: string[]) => lines.join("\n");

describe("rebaseEdit", () => {
  // The model suggests inserting a line after line 1.
  const before = ["def greet(name):", '    message = "Hi " + name', "print(greet('a'))"];
  const insertion = { startLine: 2, endLine: 2, newLines: ["    return message"] };

  it("keeps the rest of an insertion whose first letters were typed", () => {
    // Enter at the end of line 1, then the start of the line.
    const typed = ["def greet(name):", '    message = "Hi " + name', "    ret", "print(greet('a'))"];
    expect(rebaseEdit(insertion, text(before), text(typed))).toEqual({
      startLine: 2,
      endLine: 3,
      newLines: ["    return message"],
    });
  });

  // The model renames `r` to `radius` on lines 1 and 2.
  const circle = ["def area(radius):", "def circumference(r):", "    return 2 * r", "x = 1"];
  const rename = { startLine: 1, endLine: 3, newLines: ["def circumference(radius):", "    return 2 * radius"] };

  it("keeps the rest of a rename whose first letters were typed", () => {
    const typed = circle.map((l, i) => (i === 1 ? "def circumference(rad):" : l));
    expect(rebaseEdit(rename, text(circle), text(typed))).toEqual(rename);
  });

  it("keeps the rest when the replaced word was selected and retyped", () => {
    const old = ["const foo = foo + 1"];
    const edit = { startLine: 0, endLine: 1, newLines: ["const bar = bar + 1"] };
    // `foo` (the first one) selected and replaced by `ba`.
    expect(rebaseEdit(edit, text(old), text(["const ba = foo + 1"]))).toEqual(edit);
    expect(rebaseEdit(edit, text(old), text(["const bar = foo + 1"]))).toEqual(edit);
  });

  it("keeps it after deleting text the suggestion deletes too", () => {
    const old = ["const foo = 1"];
    const edit = { startLine: 0, endLine: 1, newLines: ["const bar = 1"] };
    expect(rebaseEdit(edit, text(old), text(["const oo = 1"]))).toEqual(edit);
  });

  it("drops it when a typed character differs from the suggestion", () => {
    const typed = circle.map((l, i) => (i === 1 ? "def circumference(rx):" : l));
    expect(rebaseEdit(rename, text(circle), text(typed))).toBeUndefined();
    const other = ["def greet(name):", '    message = "Hi " + name', "    x", "print(greet('a'))"];
    expect(rebaseEdit(insertion, text(before), text(other))).toBeUndefined();
  });

  it("drops it when a deletion is not one the suggestion makes", () => {
    // Backspace at the end of `foo`: the suggestion keeps nothing of `foo` at the end.
    const old = ["const foo = 1"];
    const edit = { startLine: 0, endLine: 1, newLines: ["const bar = 1"] };
    expect(rebaseEdit(edit, text(old), text(["const fo = 1"]))).toBeUndefined();
  });

  it("drops it when the edit is outside the suggestion's range", () => {
    const outside = circle.map((l, i) => (i === 3 ? "x = 12" : l));
    expect(rebaseEdit(rename, text(circle), text(outside))).toBeUndefined();
    const above = circle.map((l, i) => (i === 0 ? "def area(radius): " : l));
    expect(rebaseEdit(rename, text(circle), text(above))).toBeUndefined();
  });

  it("is done when the whole suggestion was typed", () => {
    const typed = ["def greet(name):", '    message = "Hi " + name', "    return message", "print(greet('a'))"];
    expect(rebaseEdit(insertion, text(before), text(typed))).toBe("done");
  });

  it("is done for a rename typed in full, and keeps the second line until it is typed", () => {
    const first = circle.map((l, i) => (i === 1 ? "def circumference(radius):" : l));
    expect(rebaseEdit(rename, text(circle), text(first))).toEqual({
      startLine: 2,
      endLine: 3,
      newLines: ["    return 2 * radius"],
    });
    const both = circle.map((l, i) => (i === 1 ? "def circumference(radius):" : i === 2 ? "    return 2 * radius" : l));
    expect(rebaseEdit(rename, text(circle), text(both))).toBe("done");
  });

  it("keeps an unchanged text's edit as it is", () => {
    expect(rebaseEdit(rename, text(circle), text(circle))).toEqual(rename);
  });

  it("works on CRLF text", () => {
    const crlf = (lines: string[]) => lines.join("\r\n");
    const typed = circle.map((l, i) => (i === 1 ? "def circumference(ra):" : l));
    expect(rebaseEdit(rename, crlf(circle), crlf(typed))).toEqual(rename);
    // A typed line break is CRLF in such a document.
    const multi = { startLine: 1, endLine: 1, newLines: ["a = 1", "b = 2"] };
    const broken = ["def area(radius):", "a = 1", "b", "def circumference(r):", "    return 2 * r", "x = 1"];
    expect(rebaseEdit(multi, crlf(circle), crlf(broken))).toEqual({ startLine: 2, endLine: 3, newLines: ["b = 2"] });
  });

  it("drops an edit that does not fit the old text", () => {
    expect(rebaseEdit({ startLine: 9, endLine: 10, newLines: ["x"] }, text(circle), text(circle))).toBeUndefined();
  });
});
