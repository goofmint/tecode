/**
 * Tests for `createVtEmulator` (Issue #98) — purely functional: feed known
 * ANSI byte sequences through `write()` and assert the resulting grid
 * (characters, wide-character widths, and default/palette/RGB colors)
 * back through `getCell`, plus resize/onDidChange/dispose behavior. No
 * pty involved — `ptyService.test.ts` covers the real pty half
 * separately.
 */

import { expect, test } from "bun:test";
import { createVtEmulator } from "./vtEmulator";
import { ANSI_16_PALETTE } from "./ansiPalette";
import { buildXterm256Palette } from "../ui/colorQuantize";

test("plain text: default colors, width 1, exact characters", async () => {
  const emulator = createVtEmulator({ cols: 20, rows: 3 });
  await emulator.write("Hi!");

  const h = emulator.getCell(0, 0)!;
  expect(h.chars).toBe("H");
  expect(h.width).toBe(1);
  expect(h.foreground).toEqual({ kind: "default" });
  expect(h.background).toEqual({ kind: "default" });

  expect(emulator.getCell(1, 0)!.chars).toBe("i");
  expect(emulator.getCell(2, 0)!.chars).toBe("!");

  emulator.dispose();
});

test("SGR palette color (CSI 31m): foreground resolves to ANSI-16 index 1 (red)", async () => {
  const emulator = createVtEmulator({ cols: 20, rows: 3 });
  await emulator.write("\x1b[31mR\x1b[0m");

  const cell = emulator.getCell(0, 0)!;
  expect(cell.chars).toBe("R");
  expect(cell.foreground).toEqual({ kind: "palette", index: 1, rgb: ANSI_16_PALETTE[1] });

  emulator.dispose();
});

test("256-color background (CSI 48;5;174m) resolves via the xterm-256 cube, matching buildXterm256Palette", async () => {
  const emulator = createVtEmulator({ cols: 20, rows: 3 });
  await emulator.write("\x1b[48;5;174mX\x1b[0m");

  const cell = emulator.getCell(0, 0)!;
  expect(cell.background.kind).toBe("palette");
  if (cell.background.kind !== "palette") throw new Error("unreachable");
  expect(cell.background.index).toBe(174);
  expect(cell.background.rgb).toEqual(buildXterm256Palette()[174 - 16]!);

  emulator.dispose();
});

test("truecolor RGB (CSI 38;2;10;20;30m) round-trips exactly", async () => {
  const emulator = createVtEmulator({ cols: 20, rows: 3 });
  await emulator.write("\x1b[38;2;10;20;30mX\x1b[0m");

  const cell = emulator.getCell(0, 0)!;
  expect(cell.foreground).toEqual({ kind: "rgb", rgb: { r: 10, g: 20, b: 30 } });

  emulator.dispose();
});

test("wide characters: width 2 on the leading cell, width 0 continuation cell right after", async () => {
  const emulator = createVtEmulator({ cols: 20, rows: 3 });
  await emulator.write("中x");

  const wide = emulator.getCell(0, 0)!;
  expect(wide.chars).toBe("中");
  expect(wide.width).toBe(2);

  const continuation = emulator.getCell(1, 0)!;
  expect(continuation.chars).toBe("");
  expect(continuation.width).toBe(0);

  expect(emulator.getCell(2, 0)!.chars).toBe("x");

  emulator.dispose();
});

test("getCell out of bounds returns undefined rather than throwing", async () => {
  const emulator = createVtEmulator({ cols: 5, rows: 2 });
  await emulator.write("hi");
  expect(emulator.getCell(999, 0)).toBeUndefined();
  expect(emulator.getCell(0, 999)).toBeUndefined();
  emulator.dispose();
});

test("write() resolves (never rejects) and fires onDidChange exactly once per call", async () => {
  const emulator = createVtEmulator({ cols: 20, rows: 3 });
  let changes = 0;
  emulator.onDidChange(() => {
    changes += 1;
  });

  await emulator.write("a");
  expect(changes).toBe(1);
  await emulator.write("b");
  expect(changes).toBe(2);

  emulator.dispose();
});

test("resize() updates cols/rows and fires onDidChange", () => {
  const emulator = createVtEmulator({ cols: 10, rows: 5 });
  expect(emulator.cols).toBe(10);
  expect(emulator.rows).toBe(5);

  let changed = false;
  emulator.onDidChange(() => {
    changed = true;
  });
  emulator.resize(20, 8);

  expect(emulator.cols).toBe(20);
  expect(emulator.rows).toBe(8);
  expect(changed).toBe(true);

  emulator.dispose();
});

test("onDidChange: register/dispose symmetry — a disposed listener does not fire again", async () => {
  const emulator = createVtEmulator({ cols: 10, rows: 3 });
  let calls = 0;
  const sub = emulator.onDidChange(() => {
    calls += 1;
  });

  await emulator.write("a");
  expect(calls).toBe(1);

  sub.dispose();
  await emulator.write("b");
  expect(calls).toBe(1); // unchanged

  expect(() => sub.dispose()).not.toThrow(); // idempotent

  emulator.dispose();
});

test("dispose() is idempotent, and write()/getCell() after dispose are inert rather than throwing", async () => {
  const emulator = createVtEmulator({ cols: 10, rows: 3 });
  emulator.dispose();
  expect(() => emulator.dispose()).not.toThrow();

  await expect(emulator.write("x")).resolves.toBeUndefined();
  expect(emulator.getCell(0, 0)).toBeUndefined();
});
