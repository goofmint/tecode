/**
 * Tests for {@link computeInsertedEndPoint} (this module's TSDoc) — the one
 * pure helper `createWebTreeSitterParserBackend` still needs now that the
 * backend passes UTF-16 offsets/points straight through to
 * `web-tree-sitter` (whose JS-facing API is UTF-16-code-unit based despite
 * its `.d.ts`'s "byte offset" wording — `parserBackend.ts`'s module TSDoc
 * records the evidence). Independently testable without any WASM runtime
 * (per this task's "no real WASM in tests" constraint for `@tecode/core`);
 * the coordinate-space pass-through itself is covered against the REAL
 * grammar + backend by `packages/cli`'s `highlightIncremental.e2e.test.ts`
 * (including multi-byte content), where the WASM constraint doesn't apply.
 */

import { describe, expect, test } from "bun:test";
import { computeInsertedEndPoint } from "./parserBackend";

describe("computeInsertedEndPoint", () => {
  test("a single-line insertion advances the column by the text's UTF-16 length", () => {
    expect(computeInsertedEndPoint({ row: 3, column: 7 }, "abc")).toEqual({ row: 3, column: 10 });
    expect(computeInsertedEndPoint({ row: 0, column: 0 }, "")).toEqual({ row: 0, column: 0 });
  });

  test("astral characters count as 2 UTF-16 code units (the module's coordinate space)", () => {
    // 😀 is one code point but two UTF-16 code units — and two of
    // web-tree-sitter's own units too (its UTF-16LE parsing, the module
    // TSDoc), so `.length` arithmetic is exactly right here.
    expect(computeInsertedEndPoint({ row: 1, column: 4 }, "a\u{1F600}b")).toEqual({ row: 1, column: 8 });
  });

  test("a multi-line insertion lands at the last inserted line's own length", () => {
    expect(computeInsertedEndPoint({ row: 3, column: 7 }, "ab\ncdef")).toEqual({ row: 4, column: 4 });
    expect(computeInsertedEndPoint({ row: 3, column: 7 }, "\n")).toEqual({ row: 4, column: 0 });
    expect(computeInsertedEndPoint({ row: 0, column: 2 }, "x\ny\nz!")).toEqual({ row: 2, column: 2 });
  });

  test("CRLF breaks split lines exactly like lineBuffer.ts's own splitter", () => {
    expect(computeInsertedEndPoint({ row: 5, column: 1 }, "ab\r\ncd")).toEqual({ row: 6, column: 2 });
    expect(computeInsertedEndPoint({ row: 5, column: 1 }, "ab\r\n")).toEqual({ row: 6, column: 0 });
  });
});
