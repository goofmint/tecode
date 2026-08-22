import { describe, expect, test } from "bun:test";
import { normalizeKey } from "./normalize";

describe("normalizeKey — modifier order independence", () => {
  test("shift+ctrl+p and ctrl+shift+p normalize identically", () => {
    expect(normalizeKey("shift+ctrl+p")).toBe(normalizeKey("ctrl+shift+p"));
    expect(normalizeKey("ctrl+shift+p")).toBe("ctrl+shift+p");
  });

  test("all four modifiers sort to ctrl, shift, alt, meta regardless of input order", () => {
    expect(normalizeKey("meta+alt+shift+ctrl+k")).toBe("ctrl+shift+alt+meta+k");
    expect(normalizeKey("alt+meta+ctrl+shift+k")).toBe("ctrl+shift+alt+meta+k");
  });
});

describe("normalizeKey — case independence", () => {
  test("Ctrl+Shift+P lowercases to ctrl+shift+p", () => {
    expect(normalizeKey("Ctrl+Shift+P")).toBe("ctrl+shift+p");
  });

  test("mixed-case aliases and key both lowercase", () => {
    expect(normalizeKey("CMD+A")).toBe("meta+a");
  });
});

describe("normalizeKey — alias mapping and dedupe", () => {
  test("control maps to ctrl", () => {
    expect(normalizeKey("control+a")).toBe("ctrl+a");
  });

  test("cmd and command both map to meta", () => {
    expect(normalizeKey("cmd+a")).toBe("meta+a");
    expect(normalizeKey("command+a")).toBe("meta+a");
  });

  test("option maps to alt", () => {
    expect(normalizeKey("option+a")).toBe("alt+a");
  });

  test("control+cmd+a dedupes and maps aliases, sorted ctrl before meta", () => {
    expect(normalizeKey("control+cmd+a")).toBe("ctrl+meta+a");
  });

  test("repeated equivalent modifiers dedupe to one (ctrl+control+a)", () => {
    expect(normalizeKey("ctrl+control+a")).toBe("ctrl+a");
  });

  test("repeated identical modifiers dedupe (ctrl+ctrl+a)", () => {
    expect(normalizeKey("ctrl+ctrl+a")).toBe("ctrl+a");
  });
});

describe("normalizeKey — '+' as the key itself", () => {
  test('"+" alone normalizes to "+"', () => {
    expect(normalizeKey("+")).toBe("+");
  });

  test('"++" (no modifier text) also normalizes to "+"', () => {
    expect(normalizeKey("++")).toBe("+");
  });

  test('"ctrl++" is ctrl plus the "+" key', () => {
    expect(normalizeKey("ctrl++")).toBe("ctrl++");
  });

  test('"ctrl+" (trailing +, no modifier after) is read as ctrl plus the "+" key', () => {
    expect(normalizeKey("ctrl+")).toBe("ctrl++");
  });

  test('"ctrl+shift++" is ctrl+shift plus the "+" key', () => {
    expect(normalizeKey("ctrl+shift++")).toBe("ctrl+shift++");
  });

  test("normalizing an already-canonical '+' binding is idempotent", () => {
    const once = normalizeKey("ctrl++");
    expect(normalizeKey(once)).toBe(once);
  });
});

describe("normalizeKey — other defensive/odd input", () => {
  test("a bare key with no modifiers passes through lowercased", () => {
    expect(normalizeKey("F5")).toBe("f5");
    expect(normalizeKey("Escape")).toBe("escape");
  });

  test("empty string does not throw and returns an empty canonical form", () => {
    expect(() => normalizeKey("")).not.toThrow();
    expect(normalizeKey("")).toBe("");
  });

  test("an unrecognized modifier token is preserved, not dropped", () => {
    expect(normalizeKey("hyper+a")).toBe("hyper+a");
  });

  test("known and unrecognized modifiers: known ones sort first, unknown after", () => {
    expect(normalizeKey("hyper+ctrl+a")).toBe("ctrl+hyper+a");
  });

  test("normalization is idempotent for a typical binding", () => {
    const once = normalizeKey("Shift+Ctrl+P");
    expect(normalizeKey(once)).toBe(once);
  });
});

test("whitespace around separators and ends is tolerated", () => {
  expect(normalizeKey("ctrl + p")).toBe(normalizeKey("ctrl+p"));
  expect(normalizeKey(" Ctrl+ Shift+P ")).toBe(normalizeKey("ctrl+shift+p"));
  expect(normalizeKey("ctrl + +")).toBe(normalizeKey("ctrl++"));
});
