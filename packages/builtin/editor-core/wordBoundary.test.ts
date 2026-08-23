import { describe, expect, test } from "bun:test";
import {
  nextGraphemeEnd,
  previousGraphemeStart,
  wordBoundaryLeft,
  wordBoundaryRight,
} from "./wordBoundary";

describe("wordBoundaryRight (Req 11.1)", () => {
  test("consumes a word AND any whitespace right after it, landing at the next word's start", () => {
    // Matches VS Code's default `cursorWordRight`: from the start of "foo
    // bar", Ctrl+Right lands right before "bar", not right after "foo".
    const line = "foo bar";
    expect(wordBoundaryRight(line, 0)).toBe(4); // start of "bar"
    expect(wordBoundaryRight(line, 4)).toBe(7); // end of "bar" == line end (no trailing space to skip)
  });

  test("underscore is a word character, not a separator", () => {
    expect(wordBoundaryRight("foo_bar baz", 0)).toBe(8); // "foo_bar" + the space -> start of "baz"
  });

  test("a run of punctuation groups into a single stop", () => {
    const line = "foo--bar";
    expect(wordBoundaryRight(line, 0)).toBe(3); // end of "foo"
    expect(wordBoundaryRight(line, 3)).toBe(5); // past "--"
    expect(wordBoundaryRight(line, 5)).toBe(8); // end of "bar"
  });

  test("a lone punctuation character between words is its own stop", () => {
    const line = "foo.bar";
    expect(wordBoundaryRight(line, 0)).toBe(3); // end of "foo", before "."
    expect(wordBoundaryRight(line, 3)).toBe(4); // past "."
    expect(wordBoundaryRight(line, 4)).toBe(7); // end of "bar"
  });

  test("CJK ideographs are each their own single-character stop", () => {
    const line = "你好世界";
    expect(wordBoundaryRight(line, 0)).toBe(1);
    expect(wordBoundaryRight(line, 1)).toBe(2);
    expect(wordBoundaryRight(line, 2)).toBe(3);
    expect(wordBoundaryRight(line, 3)).toBe(4);
  });

  test("mixed CJK and Latin: the boundary between them still stops", () => {
    const line = "你好 world";
    expect(wordBoundaryRight(line, 0)).toBe(1);
    expect(wordBoundaryRight(line, 1)).toBe(3); // skip the space -> start of "world"
    expect(wordBoundaryRight(line, 3)).toBe(8); // end of "world"
  });

  test("already at (or past) the line end returns the line length", () => {
    expect(wordBoundaryRight("abc", 3)).toBe(3);
    expect(wordBoundaryRight("", 0)).toBe(0);
  });

  test("starting inside trailing whitespace lands at the next word", () => {
    expect(wordBoundaryRight("abc   def", 4)).toBe(6);
  });
});

describe("wordBoundaryLeft (Req 11.1)", () => {
  test("moves to the start of the previous word, skipping whitespace", () => {
    const line = "foo bar";
    expect(wordBoundaryLeft(line, 7)).toBe(4); // start of "bar"
    expect(wordBoundaryLeft(line, 4)).toBe(0); // skip the space -> start of "foo"
  });

  test("underscore stays grouped as one word", () => {
    expect(wordBoundaryLeft("foo_bar baz", 11)).toBe(8); // start of "baz"
    expect(wordBoundaryLeft("foo_bar baz", 7)).toBe(0); // start of "foo_bar"
  });

  test("a run of punctuation groups into a single stop", () => {
    const line = "foo--bar";
    expect(wordBoundaryLeft(line, 8)).toBe(5); // start of "bar"
    expect(wordBoundaryLeft(line, 5)).toBe(3); // start of "--"
    expect(wordBoundaryLeft(line, 3)).toBe(0); // start of "foo"
  });

  test("CJK ideographs are each their own single-character stop", () => {
    const line = "你好世界";
    expect(wordBoundaryLeft(line, 4)).toBe(3);
    expect(wordBoundaryLeft(line, 3)).toBe(2);
    expect(wordBoundaryLeft(line, 2)).toBe(1);
    expect(wordBoundaryLeft(line, 1)).toBe(0);
  });

  test("already at (or before) the line start returns 0", () => {
    expect(wordBoundaryLeft("abc", 0)).toBe(0);
    expect(wordBoundaryLeft("", 0)).toBe(0);
  });
});

describe("previousGraphemeStart / nextGraphemeEnd (Req 11.1, grapheme-aware char movement)", () => {
  test("step by one grapheme, not one UTF-16 code unit, across a surrogate pair", () => {
    const line = "a😀b"; // "😀" is a surrogate pair (2 code units)
    expect(nextGraphemeEnd(line, 1)).toBe(3); // steps over the whole emoji
    expect(previousGraphemeStart(line, 3)).toBe(1);
  });

  test("clamp at the line boundaries", () => {
    expect(previousGraphemeStart("abc", 0)).toBe(0);
    expect(nextGraphemeEnd("abc", 3)).toBe(3);
  });
});
