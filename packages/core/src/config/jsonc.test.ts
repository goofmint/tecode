import { describe, expect, test } from "bun:test";
import { parseJsonc } from "./jsonc";

describe("parseJsonc — happy paths", () => {
  test("parses plain JSON with no comments or trailing commas", () => {
    const result = parseJsonc('{"a": 1, "b": [1, 2, 3]}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1, b: [1, 2, 3] });
  });

  test("empty input is a parse failure (not valid JSON), never throws", () => {
    const result = parseJsonc("");
    expect(result.ok).toBe(false);
  });

  test("whitespace-only input is a parse failure, never throws", () => {
    const result = parseJsonc("   \n\t  ");
    expect(result.ok).toBe(false);
  });

  test("strips a line comment", () => {
    const result = parseJsonc(`{
      // this is a comment
      "a": 1
    }`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });

  test("strips a trailing line comment after a value", () => {
    const result = parseJsonc('{"a": 1 // trailing\n}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });

  test("strips a block comment", () => {
    const result = parseJsonc('{ /* comment */ "a": 1 }');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });

  test("strips a multi-line block comment", () => {
    const result = parseJsonc(`{
      /*
       * multi
       * line
       */
      "a": 1
    }`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });

  test("strips a trailing comma in an object", () => {
    const result = parseJsonc('{"a": 1, "b": 2,}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1, b: 2 });
  });

  test("strips a trailing comma in an array", () => {
    const result = parseJsonc("[1, 2, 3,]");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([1, 2, 3]);
  });

  test("strips a trailing comma across whitespace and a newline", () => {
    const result = parseJsonc('{\n  "a": 1,\n}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });

  test("strips nested trailing commas in objects and arrays together", () => {
    const result = parseJsonc('{"a": [1, 2,], "b": {"c": 3,},}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  test("combines comments and trailing commas", () => {
    const result = parseJsonc(`{
      // editor settings
      "editor.tabSize": 2, // spaces
      /* block */ "editor.insertSpaces": true,
    }`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        "editor.tabSize": 2,
        "editor.insertSpaces": true,
      });
    }
  });
});

describe("parseJsonc — strings survive comment/comma-like content", () => {
  test("a string containing // is not treated as a comment", () => {
    const result = parseJsonc('{"url": "https://example.com"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ url: "https://example.com" });
  });

  test("a string containing /* is not treated as a comment start", () => {
    const result = parseJsonc('{"note": "look: /* not a comment */ ok"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ note: "look: /* not a comment */ ok" });
  });

  test("a string containing a comma before a closing brace is preserved", () => {
    const result = parseJsonc('{"note": "a, b,"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ note: "a, b," });
  });

  test("an escaped quote inside a string does not end the string early", () => {
    const result = parseJsonc('{"note": "she said \\"hi\\", // not a comment"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ note: 'she said "hi", // not a comment' });
    }
  });

  test("a backslash-escaped backslash before a quote does not confuse string end", () => {
    const result = parseJsonc('{"path": "C:\\\\", "ok": 1}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ path: "C:\\", ok: 1 });
  });
});

describe("parseJsonc — failure reporting", () => {
  test("broken input reports ok:false with a message and a 1-based line/column", () => {
    const result = parseJsonc("{ this is not json }");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.line).toBeGreaterThanOrEqual(1);
      expect(result.column).toBeGreaterThanOrEqual(1);
    }
  });

  test("an unterminated object reports a failure, not a throw", () => {
    expect(() => parseJsonc('{"a": 1')).not.toThrow();
    const result = parseJsonc('{"a": 1');
    expect(result.ok).toBe(false);
  });

  test("a stray trailing comma-comment combo that leaves invalid JSON still fails cleanly", () => {
    const result = parseJsonc('{"a": 1,, "b": 2}');
    expect(result.ok).toBe(false);
  });

  test("never throws across a wide variety of garbage input", () => {
    const garbageInputs = [
      "{{{{{",
      "]]]]",
      '"unterminated string',
      "/* unterminated block comment",
      "// just a comment",
      "null null",
      "\u0000\u0001",
    ];
    for (const input of garbageInputs) {
      expect(() => parseJsonc(input)).not.toThrow();
    }
  });
});
