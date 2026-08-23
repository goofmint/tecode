import { describe, expect, test } from "bun:test";
import { keyEventToStroke, type KeyEventLike } from "./keyEvent";

/** Build a {@link KeyEventLike} with every modifier defaulting to `false`. */
function keyOf(partial: Partial<KeyEventLike> & { name: string }): KeyEventLike {
  return {
    ctrl: false,
    shift: false,
    option: false,
    meta: false,
    sequence: partial.sequence ?? partial.name,
    ...partial,
  };
}

describe("keyEventToStroke (Req 4.1-4.4, design.md §6.1)", () => {
  test("a bare letter with no modifiers normalizes to just the key", () => {
    expect(keyEventToStroke(keyOf({ name: "a" }))).toBe("a");
  });

  test("ctrl+shift+p, regardless of which order the flags are read", () => {
    const event = keyOf({ name: "p", ctrl: true, shift: true });
    expect(keyEventToStroke(event)).toBe("ctrl+shift+p");
  });

  test("OpenTUI's `option` flag maps onto the canonical `alt` modifier", () => {
    const event = keyOf({ name: "e", option: true });
    expect(keyEventToStroke(event)).toBe("alt+e");
  });

  test("meta (cmd) combines with other modifiers in canonical order", () => {
    const event = keyOf({ name: "k", ctrl: true, meta: true, option: true, shift: true });
    expect(keyEventToStroke(event)).toBe("ctrl+shift+alt+meta+k");
  });

  test("named keys (escape, backspace, delete) pass through unchanged", () => {
    expect(keyEventToStroke(keyOf({ name: "escape" }))).toBe("escape");
    expect(keyEventToStroke(keyOf({ name: "backspace" }))).toBe("backspace");
    expect(keyEventToStroke(keyOf({ name: "delete" }))).toBe("delete");
  });

  test("uppercase letters from a shifted key normalize the same as lowercase + shift", () => {
    // OpenTUI reports shifted letters as { name: "p", shift: true }, not
    // { name: "P" } (parse.keypress.ts lowercases and sets shift) — this
    // just proves normalizeKey's own lowercasing composes correctly through
    // this adapter regardless.
    expect(keyEventToStroke(keyOf({ name: "P", shift: true }))).toBe("shift+p");
  });
});
