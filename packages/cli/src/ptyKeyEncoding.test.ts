import { describe, expect, test } from "bun:test";
import type { KeyEventLike } from "@tecode/core";
import { encodeKeyEventForPty } from "./ptyKeyEncoding";
import type { RoutableKeyEvent } from "./keyRouting";

function keyOf(partial: Partial<KeyEventLike> & { name: string } & Partial<RoutableKeyEvent>): RoutableKeyEvent {
  return {
    ctrl: false,
    shift: false,
    option: false,
    meta: false,
    sequence: partial.sequence ?? partial.name,
    ...partial,
  };
}

describe("encodeKeyEventForPty (Issue #145)", () => {
  test("Ctrl+G decoded from Kitty CSI-u (raw = ESC[103;5u) becomes the legacy control byte 0x07", () => {
    const event = keyOf({ name: "g", ctrl: true, raw: "\x1b[103;5u" });
    expect(encodeKeyEventForPty(event)).toBe("\x07");
  });

  test("Ctrl+C decoded from a legacy raw control byte (sequence = \\x03) still becomes 0x03 — no regression", () => {
    const event = keyOf({ name: "c", ctrl: true, sequence: "\x03" });
    expect(encodeKeyEventForPty(event)).toBe("\x03");
  });

  test("Ctrl+<uppercase letter> (shift also decoded) still masks to the same control byte", () => {
    // `code & 0x1f` is the same for 'g' (0x67) and 'G' (0x47) — proves the
    // regex/mask handles either case a terminal might report.
    const event = keyOf({ name: "G", ctrl: true, shift: true, raw: "\x1b[71;6u" });
    expect(encodeKeyEventForPty(event)).toBe("\x07");
  });

  test("Alt+Ctrl+G (option held) prefixes ESC onto the recomputed control byte", () => {
    const event = keyOf({ name: "g", ctrl: true, option: true, raw: "\x1b[103;7u" });
    expect(encodeKeyEventForPty(event)).toBe("\x1b\x07");
  });

  test("Ctrl+Meta+<letter> is NOT reshaped — falls back to raw bytes unchanged", () => {
    const event = keyOf({ name: "g", ctrl: true, meta: true, raw: "\x1b[103;9u" });
    expect(encodeKeyEventForPty(event)).toBe("\x1b[103;9u");
  });

  test("an arrow key (no ctrl) is forwarded unmodified via raw", () => {
    const event = keyOf({ name: "down", raw: "\x1b[B", sequence: "\x1b[B" });
    expect(encodeKeyEventForPty(event)).toBe("\x1b[B");
  });

  test("a multi-character IME-committed string (no ctrl) is forwarded unmodified", () => {
    const event = keyOf({ name: "日本語", raw: "日本語", sequence: "日本語" });
    expect(encodeKeyEventForPty(event)).toBe("日本語");
  });

  test("an unmodified plain letter is forwarded unmodified", () => {
    const event = keyOf({ name: "a", sequence: "a" });
    expect(encodeKeyEventForPty(event)).toBe("a");
  });

  test("ctrl held with a multi-character name (not a single letter) is NOT reshaped", () => {
    const event = keyOf({ name: "f1", ctrl: true, raw: "\x1b[1;5P" });
    expect(encodeKeyEventForPty(event)).toBe("\x1b[1;5P");
  });

  test("with neither raw nor sequence present, falls back to an empty string", () => {
    const event: RoutableKeyEvent = { name: "shift", ctrl: false, shift: true, option: false, meta: false, sequence: "" };
    expect(encodeKeyEventForPty(event)).toBe("");
  });
});
