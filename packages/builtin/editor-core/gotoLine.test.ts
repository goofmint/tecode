import { describe, expect, test } from "bun:test";
import { resolveGotoLinePosition, validateGotoLineInput } from "./gotoLine";

describe("validateGotoLineInput (Issue #162)", () => {
  const lineCount = 10;

  test("a valid in-range value is accepted", () => {
    expect(validateGotoLineInput("3", lineCount)).toBeUndefined();
  });

  test("the first and last lines are both accepted (inclusive bounds)", () => {
    expect(validateGotoLineInput("1", lineCount)).toBeUndefined();
    expect(validateGotoLineInput("10", lineCount)).toBeUndefined();
  });

  test("an empty value is rejected", () => {
    expect(validateGotoLineInput("", lineCount)).toBe("Enter a line number.");
  });

  test("a whitespace-only value is rejected", () => {
    expect(validateGotoLineInput("   ", lineCount)).toBe("Enter a line number.");
  });

  test("a non-numeric value is rejected", () => {
    expect(validateGotoLineInput("abc", lineCount)).toBe("Enter a valid line number.");
  });

  test("a fractional value is rejected", () => {
    expect(validateGotoLineInput("3.5", lineCount)).toBe("Enter a valid line number.");
  });

  test("a value below 1 is rejected", () => {
    expect(validateGotoLineInput("0", lineCount)).toBe(`Line number must be between 1 and ${lineCount}.`);
  });

  test("a negative value is rejected", () => {
    expect(validateGotoLineInput("-1", lineCount)).toBe("Enter a valid line number.");
  });

  test("a value beyond lineCount is rejected", () => {
    expect(validateGotoLineInput("11", lineCount)).toBe(`Line number must be between 1 and ${lineCount}.`);
  });

  test("surrounding whitespace is trimmed before validation", () => {
    expect(validateGotoLineInput("  3  ", lineCount)).toBeUndefined();
  });
});

describe("resolveGotoLinePosition (Issue #162)", () => {
  const lineCount = 10;

  test("converts a 1-based value to a 0-based line, character 0", () => {
    expect(resolveGotoLinePosition("3", lineCount)).toEqual({ line: 2, character: 0 });
  });

  test("the first line resolves to line 0", () => {
    expect(resolveGotoLinePosition("1", lineCount)).toEqual({ line: 0, character: 0 });
  });

  test("the last line resolves to lineCount - 1", () => {
    expect(resolveGotoLinePosition("10", lineCount)).toEqual({ line: 9, character: 0 });
  });

  test("a value beyond lineCount clamps to the last line", () => {
    expect(resolveGotoLinePosition("999", lineCount)).toEqual({ line: 9, character: 0 });
  });

  test("a value below 1 clamps to the first line", () => {
    expect(resolveGotoLinePosition("0", lineCount)).toEqual({ line: 0, character: 0 });
  });
});
