import { describe, expect, test } from "bun:test";
import type { Position, TextEdit } from "@tecode/api";
import { createLineBuffer } from "./lineBuffer";

/** A tiny seeded PRNG (mulberry32) so property-based tests are
 * deterministic and reproducible on failure — never `Math.random()`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

const RANDOM_WORDS = ["foo", "bar", "baz", "quux", "hello", "world", "x", ""];

function randomLine(rng: () => number): string {
  const wordCount = randInt(rng, 4);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(RANDOM_WORDS[randInt(rng, RANDOM_WORDS.length)]!);
  }
  return words.join(" ");
}

function randomText(rng: () => number): string {
  const lineCount = 1 + randInt(rng, 6);
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) lines.push(randomLine(rng));
  return lines.join("\n");
}

/** Build a batch of non-overlapping, in-bounds random edits against a
 * buffer already at `lines`. */
function randomEditBatch(rng: () => number, lines: string[]): TextEdit[] {
  const editCount = 1 + randInt(rng, 3);
  // Pick distinct line indices to anchor each edit, so ranges collapsed
  // to single lines can't overlap.
  const available = Array.from({ length: lines.length }, (_, i) => i);
  const chosen: number[] = [];
  for (let i = 0; i < editCount && available.length > 0; i++) {
    const idx = randInt(rng, available.length);
    chosen.push(available.splice(idx, 1)[0]!);
  }
  chosen.sort((a, b) => a - b);

  const edits: TextEdit[] = [];
  for (const line of chosen) {
    const lineText = lines[line]!;
    const start = randInt(rng, lineText.length + 1);
    const end = start + randInt(rng, lineText.length + 1 - start);
    const newText = randomLine(rng);
    edits.push({
      range: {
        start: { line, character: start },
        end: { line, character: end },
      },
      newText,
    });
  }
  return edits;
}

describe("createLineBuffer — round-trip property (seeded, deterministic)", () => {
  test("applying inverse edits always restores the original text (200 iterations)", () => {
    const rng = mulberry32(0xc0ffee);
    for (let iteration = 0; iteration < 200; iteration++) {
      const original = randomText(rng);
      const buffer = createLineBuffer(original, "\n");
      const lines = original.split("\n");

      const edits = randomEditBatch(rng, lines);
      const applied = buffer.applyEdits(edits);

      const inverses = applied.map((a) => a.inverse);
      buffer.applyEdits(inverses);

      expect(buffer.getText()).toBe(original);
    }
  });
});

describe("createLineBuffer — multi-edit ordering and validation", () => {
  test("edits apply atomically regardless of input order (bottom-up internally)", () => {
    const buffer = createLineBuffer("aaaa\nbbbb\ncccc", "\n");
    // Given out of position order on purpose.
    const edits: TextEdit[] = [
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } },
        newText: "CCCC",
      },
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        newText: "AAAA",
      },
    ];
    buffer.applyEdits(edits);
    expect(buffer.getText()).toBe("AAAA\nbbbb\nCCCC");
  });

  test("overlapping edits throw and leave the buffer untouched", () => {
    const buffer = createLineBuffer("hello world", "\n");
    const edits: TextEdit[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "HI",
      },
      {
        range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } },
        newText: "XX",
      },
    ];
    expect(() => buffer.applyEdits(edits)).toThrow(RangeError);
    expect(buffer.getText()).toBe("hello world");
  });

  test("invalid ranges (start after end) throw and leave the buffer untouched", () => {
    const buffer = createLineBuffer("hello", "\n");
    const bad: TextEdit = {
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 1 } },
      newText: "x",
    };
    expect(() => buffer.applyEdits([bad])).toThrow(RangeError);
    expect(buffer.getText()).toBe("hello");
  });

  test("out-of-bounds ranges throw and leave the buffer untouched", () => {
    const buffer = createLineBuffer("hello", "\n");
    const outOfLineBounds: TextEdit = {
      range: { start: { line: 5, character: 0 }, end: { line: 5, character: 0 } },
      newText: "x",
    };
    expect(() => buffer.applyEdits([outOfLineBounds])).toThrow(RangeError);

    const outOfCharBounds: TextEdit = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 99 } },
      newText: "x",
    };
    expect(() => buffer.applyEdits([outOfCharBounds])).toThrow(RangeError);
    expect(buffer.getText()).toBe("hello");
  });

  test("a batch with one invalid edit rejects the whole batch atomically", () => {
    const buffer = createLineBuffer("abc\ndef", "\n");
    const good: TextEdit = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      newText: "X",
    };
    const bad: TextEdit = {
      range: { start: { line: 9, character: 0 }, end: { line: 9, character: 0 } },
      newText: "Y",
    };
    expect(() => buffer.applyEdits([good, bad])).toThrow(RangeError);
    // `good` must NOT have been applied even though it was valid on its own.
    expect(buffer.getText()).toBe("abc\ndef");
  });

  test("adjacent (touching) edits are allowed and both apply", () => {
    const buffer = createLineBuffer("abcdef", "\n");
    const edits: TextEdit[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: "XXX",
      },
      {
        range: { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } },
        newText: "YYY",
      },
    ];
    expect(() => buffer.applyEdits(edits)).not.toThrow();
    expect(buffer.getText()).toBe("XXXYYY");
  });

  test("a multi-line insertion shifts line count and subsequent line content", () => {
    const buffer = createLineBuffer("one\ntwo\nthree", "\n");
    buffer.applyEdits([
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
        newText: "inserted-a\ninserted-b\n",
      },
    ]);
    expect(buffer.getText()).toBe("one\ninserted-a\ninserted-b\ntwo\nthree");
    expect(buffer.lineCount).toBe(5);
  });

  test("returned inverse edits, applied back, undo a multi-edit batch", () => {
    const buffer = createLineBuffer("one\ntwo\nthree", "\n");
    const applied = buffer.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: "ONE-LONGER",
      },
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
        newText: "3",
      },
    ]);
    expect(buffer.getText()).toBe("ONE-LONGER\ntwo\n3");

    buffer.applyEdits(applied.map((a) => a.inverse));
    expect(buffer.getText()).toBe("one\ntwo\nthree");
  });
});

describe("createLineBuffer — getLine/lineCount", () => {
  test("getLine returns line text without terminators; lineCount matches", () => {
    const buffer = createLineBuffer("alpha\nbeta\ngamma", "\n");
    expect(buffer.lineCount).toBe(3);
    expect(buffer.getLine(0)).toBe("alpha");
    expect(buffer.getLine(2)).toBe("gamma");
  });

  test("getLine throws RangeError out of bounds", () => {
    const buffer = createLineBuffer("solo", "\n");
    expect(() => buffer.getLine(-1)).toThrow(RangeError);
    expect(() => buffer.getLine(1)).toThrow(RangeError);
  });

  test("an empty string is a single empty line", () => {
    const buffer = createLineBuffer("", "\n");
    expect(buffer.lineCount).toBe(1);
    expect(buffer.getLine(0)).toBe("");
    expect(buffer.getText()).toBe("");
  });
});

describe("createLineBuffer — offsetAt/positionAt", () => {
  test("round-trips across a plain ASCII multi-line buffer", () => {
    const text = "hello\nworld\nfoo";
    const buffer = createLineBuffer(text, "\n");
    for (let offset = 0; offset <= text.length; offset++) {
      const pos = buffer.positionAt(offset);
      expect(buffer.offsetAt(pos)).toBe(offset);
    }
  });

  test("round-trips every in-range position", () => {
    const text = "ab\ncde\nf";
    const buffer = createLineBuffer(text, "\n");
    const lines = text.split("\n");
    for (let line = 0; line < lines.length; line++) {
      for (let character = 0; character <= lines[line]!.length; character++) {
        const pos: Position = { line, character };
        expect(buffer.positionAt(buffer.offsetAt(pos))).toEqual(pos);
      }
    }
  });

  test("round-trips on CJK content (each character is one UTF-16 code unit)", () => {
    const text = "日本語のテキスト\nこんにちは世界";
    const buffer = createLineBuffer(text, "\n");
    for (let offset = 0; offset <= text.length; offset++) {
      const pos = buffer.positionAt(offset);
      expect(buffer.offsetAt(pos)).toBe(offset);
    }
    // Editing mid-line CJK content produces the expected result.
    const applied = buffer.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: "英語",
      },
    ]);
    expect(buffer.getLine(0)).toBe("英語のテキスト");
    expect(applied[0]!.inverse.newText).toBe("日本語");
  });

  test("round-trips on astral (surrogate-pair) content without splitting a pair", () => {
    // Each of these emoji is a surrogate pair: 2 UTF-16 code units.
    const text = "a😀b😁c";
    const buffer = createLineBuffer(text, "\n");
    expect(text.length).toBe(7); // sanity: code-unit length, not code-point count
    for (let offset = 0; offset <= text.length; offset++) {
      const pos = buffer.positionAt(offset);
      expect(buffer.offsetAt(pos)).toBe(offset);
      // The recovered position, converted back to an offset, must land on
      // the same code unit `offset` names — i.e. no pair got split into a
      // position that resolves to a different offset than requested.
      expect(pos.line).toBe(0);
      expect(pos.character).toBe(offset);
    }
  });

  test("offsetAt clamps a negative or overlong position to buffer bounds", () => {
    const buffer = createLineBuffer("hi\nthere", "\n");
    expect(buffer.offsetAt({ line: -1, character: -1 })).toBe(0);
    expect(buffer.offsetAt({ line: 99, character: 99 })).toBe(buffer.getText().length);
    expect(buffer.offsetAt({ line: 0, character: 99 })).toBe(2); // clamps to end of line 0
  });

  test("positionAt clamps a negative or overlong offset to buffer bounds", () => {
    const buffer = createLineBuffer("hi\nthere", "\n");
    expect(buffer.positionAt(-5)).toEqual({ line: 0, character: 0 });
    const text = buffer.getText();
    expect(buffer.positionAt(text.length + 100)).toEqual({
      line: 1,
      character: "there".length,
    });
  });
});

describe("createLineBuffer — eol handling", () => {
  test("getText rejoins lines using the buffer's eol, independent of source terminators", () => {
    const buffer = createLineBuffer("a\r\nb\nc", "\r\n");
    expect(buffer.lineCount).toBe(3);
    expect(buffer.getText()).toBe("a\r\nb\r\nc");
  });

  test("offset math accounts for a multi-character eol", () => {
    const buffer = createLineBuffer("ab\ncd", "\r\n");
    // Line 1 starts after "ab" + "\r\n" (4 code units).
    expect(buffer.offsetAt({ line: 1, character: 0 })).toBe(4);
    expect(buffer.positionAt(4)).toEqual({ line: 1, character: 0 });
  });
});

describe("createLineBuffer — CRLF edge cases (review regressions)", () => {
  test("positionAt never returns a negative character for an offset inside a CRLF pair", () => {
    const buffer = createLineBuffer("ab\ncd", "\r\n");
    // Offsets: a=0 b=1 \r=2 \n=3 c=4 d=5. Offset 3 sits inside the EOL
    // sequence and must round forward to the start of the next line.
    expect(buffer.positionAt(2)).toEqual({ line: 0, character: 2 });
    expect(buffer.positionAt(3)).toEqual({ line: 1, character: 0 });
    expect(buffer.positionAt(4)).toEqual({ line: 1, character: 0 });
    expect(buffer.positionAt(5)).toEqual({ line: 1, character: 1 });
  });

  test("inverse edits stay correct when newText's line breaks differ from the buffer eol", () => {
    // "\n" inside newText occupies TWO code units ("\r\n") once spliced
    // into a CRLF buffer — the inverse range must use the normalized
    // length, or undo corrupts the document.
    const buffer = createLineBuffer("ab\r\ncd", "\r\n");
    const original = buffer.getText();

    const applied = buffer.applyEdits([
      {
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
        newText: "x\ny",
      },
    ]);
    expect(buffer.getText()).toBe("ax\r\nyb\r\ncd");

    buffer.applyEdits(applied.map(({ inverse }) => inverse));
    expect(buffer.getText()).toBe(original);
  });

  test("a batch with mixed-newline inserts round-trips through its inverses on a CRLF buffer", () => {
    const buffer = createLineBuffer("one\r\ntwo\r\nthree", "\r\n");
    const original = buffer.getText();

    const applied = buffer.applyEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        newText: "1\n1",
      },
      {
        range: { start: { line: 2, character: 5 }, end: { line: 2, character: 5 } },
        newText: "\r\nfour\nfive",
      },
    ]);

    buffer.applyEdits(applied.map(({ inverse }) => inverse));
    expect(buffer.getText()).toBe(original);
  });
});
