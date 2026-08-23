/**
 * Tests for {@link utf16OffsetToUtf8Byte}/{@link utf8ByteOffsetToUtf16}
 * (this module's TSDoc) — the pure UTF-16 <-> UTF-8 byte-offset conversion
 * `createWebTreeSitterParserBackend` needs, independently testable without
 * any WASM runtime (per this task's "no real WASM in tests" constraint;
 * these two functions are the only part of `parserBackend.ts` that has no
 * `web-tree-sitter` dependency at all).
 */

import { describe, expect, test } from "bun:test";
import { buildTextIndex, resolveByteOffset, utf16OffsetToUtf8Byte, utf8ByteOffsetToUtf16 } from "./parserBackend";

describe("utf16OffsetToUtf8Byte", () => {
  test("ASCII text: byte offset equals the UTF-16 offset", () => {
    const text = "const x = 1;";
    expect(utf16OffsetToUtf8Byte(text, 0)).toBe(0);
    expect(utf16OffsetToUtf8Byte(text, 5)).toBe(5);
    expect(utf16OffsetToUtf8Byte(text, text.length)).toBe(text.length);
  });

  test("a 2-byte UTF-8 character (e.g. 'é') widens the byte offset", () => {
    const text = "café";
    // "café" = c,a,f,é — é is U+00E9, 2 bytes in UTF-8, 1 UTF-16 code unit.
    expect(utf16OffsetToUtf8Byte(text, 3)).toBe(3); // before "é"
    expect(utf16OffsetToUtf8Byte(text, 4)).toBe(5); // after "é" (3 ascii bytes + 2)
  });

  test("an astral character (surrogate pair) widens the byte offset by 4", () => {
    const text = "a\u{1F600}b"; // a, 😀 (2 UTF-16 units, 4 UTF-8 bytes), b
    expect(utf16OffsetToUtf8Byte(text, 1)).toBe(1); // before the emoji
    expect(utf16OffsetToUtf8Byte(text, 3)).toBe(5); // after the emoji (1 + 4)
    expect(utf16OffsetToUtf8Byte(text, 4)).toBe(6); // after "b"
  });

  test("out-of-range input clamps to the text's bounds", () => {
    const text = "abc";
    expect(utf16OffsetToUtf8Byte(text, -5)).toBe(0);
    expect(utf16OffsetToUtf8Byte(text, 999)).toBe(3);
  });
});

describe("utf8ByteOffsetToUtf16", () => {
  test("ASCII text: UTF-16 offset equals the byte offset", () => {
    const text = "const x = 1;";
    expect(utf8ByteOffsetToUtf16(text, 0)).toBe(0);
    expect(utf8ByteOffsetToUtf16(text, 5)).toBe(5);
    expect(utf8ByteOffsetToUtf16(text, text.length)).toBe(text.length);
  });

  test("a 2-byte UTF-8 character narrows the UTF-16 offset", () => {
    const text = "café";
    expect(utf8ByteOffsetToUtf16(text, 3)).toBe(3); // before "é"
    expect(utf8ByteOffsetToUtf16(text, 5)).toBe(4); // after "é" (5 bytes -> 4 UTF-16 units)
  });

  test("an astral character (surrogate pair) narrows the UTF-16 offset", () => {
    const text = "a\u{1F600}b";
    expect(utf8ByteOffsetToUtf16(text, 1)).toBe(1); // before the emoji
    expect(utf8ByteOffsetToUtf16(text, 5)).toBe(3); // after the emoji (5 bytes -> 3 UTF-16 units)
    expect(utf8ByteOffsetToUtf16(text, 6)).toBe(4); // after "b"
  });

  test("is the exact inverse of utf16OffsetToUtf8Byte at every code-point boundary", () => {
    // Only code-point boundaries are checked — a UTF-16 offset that splits
    // an astral character's surrogate pair is not a valid tree-sitter
    // offset in the first place (real tree-sitter, like both functions
    // here, only ever reports offsets on code-point boundaries).
    const text = "héllo \u{1F600} wörld";
    let i = 0;
    for (const ch of text) {
      const byteOffset = utf16OffsetToUtf8Byte(text, i);
      expect(utf8ByteOffsetToUtf16(text, byteOffset)).toBe(i);
      i += ch.length;
    }
    // The final boundary (end of string).
    const finalByteOffset = utf16OffsetToUtf8Byte(text, text.length);
    expect(utf8ByteOffsetToUtf16(text, finalByteOffset)).toBe(text.length);
  });

  test("out-of-range input clamps to the text's bounds", () => {
    const text = "abc";
    expect(utf8ByteOffsetToUtf16(text, -5)).toBe(0);
    expect(utf8ByteOffsetToUtf16(text, 999)).toBe(3);
  });
});

/** A naive, test-local (i.e. not sharing any code with `parserBackend.ts`)
 * `{ row, column }` computation for a UTF-16 offset — split the text up to
 * `utf16Offset` on line breaks and count. Used as the independent oracle
 * {@link resolveByteOffset}'s point is checked against below. */
function naivePointAt(text: string, utf16Offset: number): { row: number; column: number } {
  const before = text.slice(0, utf16Offset);
  const lines = before.split(/\r\n|\n/);
  return { row: lines.length - 1, column: lines[lines.length - 1]!.length };
}

describe("buildTextIndex / resolveByteOffset (the indexed capture-resolution path, Finding: perf)", () => {
  test("multi-byte, multi-line content (Japanese + emoji): the indexed path agrees with the naive helpers at every code-point boundary", () => {
    // Mixes 3-byte (Japanese), 4-byte (emoji/surrogate-pair), 2-byte
    // (accented Latin), and ASCII text across three lines — exactly the
    // "multi-byte content" this task's finding calls for.
    const text = "こんにちは\u{1F600} wörld\nsecond \u{1F602} liné\nthird line";
    const index = buildTextIndex(text);

    let utf16Offset = 0;
    for (const ch of text) {
      const byteOffset = utf16OffsetToUtf8Byte(text, utf16Offset);
      const resolved = resolveByteOffset(index, byteOffset);
      // Agrees with the naive UTF-8<->UTF-16 offset helpers...
      expect(resolved.utf16Offset).toBe(utf16Offset);
      expect(resolved.utf16Offset).toBe(utf8ByteOffsetToUtf16(text, byteOffset));
      // ...and with an independently-computed row/column split.
      expect(resolved.point).toEqual(naivePointAt(text, utf16Offset));
      utf16Offset += ch.length;
    }

    // The final boundary (end of string) too.
    const finalByteOffset = utf16OffsetToUtf8Byte(text, text.length);
    const finalResolved = resolveByteOffset(index, finalByteOffset);
    expect(finalResolved.utf16Offset).toBe(text.length);
    expect(finalResolved.utf16Offset).toBe(utf8ByteOffsetToUtf16(text, finalByteOffset));
    expect(finalResolved.point).toEqual(naivePointAt(text, text.length));
  });

  test("single-line ASCII text: row is always 0, column equals the offset", () => {
    const text = "const x = 1;";
    const index = buildTextIndex(text);
    for (let i = 0; i <= text.length; i++) {
      const resolved = resolveByteOffset(index, i);
      expect(resolved).toEqual({ utf16Offset: i, point: { row: 0, column: i } });
    }
  });
});
