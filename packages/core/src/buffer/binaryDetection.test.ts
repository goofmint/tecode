/**
 * `isBinaryContent` tests (Issue #137): the NUL-byte heuristic itself,
 * independent of `documentManager.ts`'s open/abort wiring (covered
 * separately in `documentManager.test.ts`). Boundary tests around
 * `BINARY_DETECTION_SAMPLE_BYTES` match this package's convention for a
 * bounded-prefix heuristic (`cellWidth.test.ts`'s/`documentManager.test.
 * ts`'s own boundary-test style, referencing the constant by its imported
 * name rather than a hard-coded number).
 */

import { describe, expect, test } from "bun:test";
import { BINARY_DETECTION_SAMPLE_BYTES, isBinaryContent } from "./binaryDetection";

describe("isBinaryContent (Issue #137)", () => {
  test("an empty byte array is not binary", () => {
    expect(isBinaryContent(new Uint8Array())).toBe(false);
  });

  test("plain ASCII text is not binary", () => {
    expect(isBinaryContent(new TextEncoder().encode("hello, world\n"))).toBe(false);
  });

  test("valid multi-byte UTF-8 text is not binary", () => {
    expect(isBinaryContent(new TextEncoder().encode("日本語のテキスト"))).toBe(false);
  });

  test("a NUL byte anywhere in the sample is binary", () => {
    expect(isBinaryContent(new Uint8Array([0x68, 0x69, 0x00, 0x21]))).toBe(true);
  });

  test("a NUL byte as the very first byte is binary", () => {
    expect(isBinaryContent(new Uint8Array([0x00, 0x61, 0x62]))).toBe(true);
  });

  test("a NUL byte as the very last byte is binary", () => {
    expect(isBinaryContent(new Uint8Array([0x61, 0x62, 0x00]))).toBe(true);
  });

  test("other C0 control bytes (e.g. ESC, BEL) alone do not count as binary", () => {
    // Only NUL is the signal (this module's own TSDoc on why) — a file full
    // of other control bytes but no NUL must not be misclassified.
    expect(isBinaryContent(new Uint8Array([0x1b, 0x07, 0x01, 0x02]))).toBe(false);
  });

  test("a NUL byte at index BINARY_DETECTION_SAMPLE_BYTES - 1 (last sampled byte) is binary", () => {
    const bytes = new Uint8Array(BINARY_DETECTION_SAMPLE_BYTES).fill(0x78); // 'x'
    bytes[BINARY_DETECTION_SAMPLE_BYTES - 1] = 0x00;
    expect(isBinaryContent(bytes)).toBe(true);
  });

  test("a NUL byte at index BINARY_DETECTION_SAMPLE_BYTES (just past the sample) is not detected", () => {
    const bytes = new Uint8Array(BINARY_DETECTION_SAMPLE_BYTES + 1).fill(0x78); // 'x'
    bytes[BINARY_DETECTION_SAMPLE_BYTES] = 0x00;
    expect(isBinaryContent(bytes)).toBe(false);
  });

  test("a byte array shorter than the sample size is scanned in full", () => {
    const bytes = new Uint8Array(10).fill(0x78);
    bytes[9] = 0x00;
    expect(isBinaryContent(bytes)).toBe(true);
  });
});
