/**
 * Tests for {@link applySidebarWidthSetting}/
 * {@link createSidebarWidthSettingsWriter} (Issue #105).
 */

import { describe, expect, test } from "bun:test";
import { parseJsonc } from "../config/jsonc";
import {
  applySidebarWidthSetting,
  createSidebarWidthSettingsWriter,
  type SidebarWidthSettingsWriterFs,
  type SidebarWidthSettingsWriterTimer,
} from "./sidebarWidthSettingsWriter";

describe("applySidebarWidthSetting (Issue #105, text-replace)", () => {
  test("replaces an existing key's value in place, byte-for-byte elsewhere", () => {
    const before = `{\n  // a comment\n  "editor.tabSize": 2,\n  "workbench.sidebarWidth": 30,\n  "editor.wordWrap": true\n}\n`;
    const after = applySidebarWidthSetting(before, 45);
    expect(after).toBe(
      `{\n  // a comment\n  "editor.tabSize": 2,\n  "workbench.sidebarWidth": 45,\n  "editor.wordWrap": true\n}\n`,
    );
  });

  test("appends the key when absent, into an object with existing keys", () => {
    const before = `{\n  "editor.tabSize": 2\n}\n`;
    const after = applySidebarWidthSetting(before, 40);
    expect(after).toBe(`{\n  "workbench.sidebarWidth": 40,\n  "editor.tabSize": 2\n}\n`);
    const parsed = parseJsonc<Record<string, unknown>>(after);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.sidebarWidth"]).toBe(40);
  });

  test("appends the key into an otherwise-empty object", () => {
    const after = applySidebarWidthSetting("{}\n", 25);
    const parsed = parseJsonc<Record<string, unknown>>(after);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value["workbench.sidebarWidth"]).toBe(25);
      expect(Object.keys(parsed.value)).toEqual(["workbench.sidebarWidth"]);
    }
  });

  test("falls back to a fresh minimal file when there is no object to insert into", () => {
    const after = applySidebarWidthSetting("", 25);
    const parsed = parseJsonc<Record<string, unknown>>(after);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.sidebarWidth"]).toBe(25);
  });

  test("replaces an existing non-numeric value in place rather than appending a duplicate key (regression)", () => {
    const before = `{\n  "editor.tabSize": 2,\n  "workbench.sidebarWidth": null,\n  "editor.wordWrap": true\n}\n`;
    const after = applySidebarWidthSetting(before, 33);
    expect(after).toBe(
      `{\n  "editor.tabSize": 2,\n  "workbench.sidebarWidth": 33,\n  "editor.wordWrap": true\n}\n`,
    );
    expect(after.match(/"workbench\.sidebarWidth"/g)).toHaveLength(1);
  });

  test("does not disturb a different key sharing a suffix with the real key", () => {
    const before = `{\n  "notWorkbench.sidebarWidth": "untouched"\n}\n`;
    const after = applySidebarWidthSetting(before, 33);
    expect(after).toContain('"notWorkbench.sidebarWidth": "untouched"');
    expect(after).toContain('"workbench.sidebarWidth": 33');
  });

  test("a key that appears ONLY inside a comment is left untouched, and a real key is appended instead (Issue #105 Finding 5)", () => {
    // Regression: `applySidebarWidthSetting` used to search the RAW text
    // (only `findObjectOpenBrace`'s fallback path used `stripComments`), so
    // a commented-out occurrence of the key was matched as if it were live
    // and spliced into — corrupting the comment and leaving no real,
    // parseable `"workbench.sidebarWidth"` entry at all.
    const before = `{\n  // "workbench.sidebarWidth": 40,\n  "editor.tabSize": 2\n}\n`;
    const after = applySidebarWidthSetting(before, 45);

    // The comment survives byte-for-byte...
    expect(after).toContain('// "workbench.sidebarWidth": 40,');
    // ...and a REAL key was appended rather than spliced into the comment.
    const parsed = parseJsonc<Record<string, unknown>>(after);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value["workbench.sidebarWidth"]).toBe(45);
      expect(parsed.value["editor.tabSize"]).toBe(2);
    }
  });
});

function createFakeFs(initial: Record<string, string>): {
  fs: SidebarWidthSettingsWriterFs;
  files: Record<string, string>;
  /** How many times `writeFile` actually ran — unlike counting
   * `Object.keys(files)`, which only ever reports how many DISTINCT paths
   * were ever written (always 1 for these single-path tests, regardless of
   * how many times `writeFile` ran), this increments on every call, so a
   * mutation that fires a disk write per `write()` call instead of once
   * per debounce window is actually caught (Issue #105 Finding 4). */
  writeCount(): number;
} {
  const files = { ...initial };
  let writeCalls = 0;
  return {
    files,
    writeCount: () => writeCalls,
    fs: {
      readFile: (path) => {
        const text = files[path];
        if (text === undefined) {
          return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        }
        return Promise.resolve(text);
      },
      mkdir: () => Promise.resolve(),
      writeFile: (path, data) => {
        writeCalls += 1;
        files[path] = data;
        return Promise.resolve();
      },
    },
  };
}

/** A manually-driven {@link SidebarWidthSettingsWriterTimer} — matches
 * `layoutState.test.ts`'s `createManualTimer` exactly (deterministic, no
 * real waiting): `schedule` records the callback instead of running it on a
 * real clock, and the test fires it later via `runScheduled()`. */
function createManualTimer(): {
  timer: SidebarWidthSettingsWriterTimer;
  scheduledCount(): number;
  runScheduled(): void;
} {
  let nextHandle = 0;
  const pending = new Map<number, () => void>();
  return {
    timer: {
      schedule(fn) {
        const handle = nextHandle++;
        pending.set(handle, fn);
        return handle;
      },
      cancel(handle) {
        pending.delete(handle as number);
      },
    },
    scheduledCount: () => nextHandle,
    runScheduled() {
      const entries = Array.from(pending.entries());
      pending.clear();
      for (const [, fn] of entries) fn();
    },
  };
}

describe("createSidebarWidthSettingsWriter (Issue #105)", () => {
  test("writes a fresh file when settings.json does not exist yet, once the debounce fires", async () => {
    const { fs, files } = createFakeFs({});
    const { timer, runScheduled } = createManualTimer();
    const writer = createSidebarWidthSettingsWriter({ path: "/settings.json", fs, timer });

    writer.write(40);
    // Nothing written yet — still debouncing.
    expect(files["/settings.json"]).toBeUndefined();

    runScheduled();
    await writer.flush();
    const parsed = parseJsonc<Record<string, unknown>>(files["/settings.json"]!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.sidebarWidth"]).toBe(40);
  });

  test("preserves the rest of an existing settings.json", async () => {
    const before = `{\n  "editor.tabSize": 8,\n  "workbench.sidebarWidth": 20\n}\n`;
    const { fs, files } = createFakeFs({ "/settings.json": before });
    const { timer } = createManualTimer();
    const writer = createSidebarWidthSettingsWriter({ path: "/settings.json", fs, timer });

    writer.write(50);
    await writer.flush();
    expect(files["/settings.json"]).toBe(`{\n  "editor.tabSize": 8,\n  "workbench.sidebarWidth": 50\n}\n`);
  });

  test("a burst of write() calls before the debounce fires produces exactly ONE disk write, with the latest value (the load-bearing debounce contract)", async () => {
    // This is the shape of a real drag-end followed immediately by another
    // resize (or a user mashing the increase/decrease keybinding): several
    // commits land within one debounce window. Only one actual write to
    // settings.json must result — the whole reason this module debounces
    // rather than writing immediately like `themeSettingsWriter.ts` does
    // (this module's own TSDoc explains why the two differ).
    const { fs, files, writeCount } = createFakeFs({ "/settings.json": "{}\n" });
    const { timer, scheduledCount, runScheduled } = createManualTimer();
    const writer = createSidebarWidthSettingsWriter({ path: "/settings.json", fs, timer });

    writer.write(10);
    writer.write(20);
    writer.write(30);
    // Every write() call cancels the previous timer and schedules a fresh
    // one — `scheduledCount` (a monotonic counter, never decremented by
    // cancellation) proves 3 schedule() calls happened, but only the LAST
    // one is ever allowed to actually run to completion.
    expect(scheduledCount()).toBe(3);

    runScheduled();
    await writer.flush();

    // Only one actual `writeFile` call happened — asserted via a counter
    // incremented INSIDE the fake `writeFile` (Issue #105 Finding 4:
    // counting `Object.keys(files)` instead cannot fail here, since that
    // map is keyed by PATH — one key regardless of how many times
    // `writeFile` ran against it), so a mutation that fires a write per
    // update() call (rather than once per debounce window) would be
    // caught even if the final value still happened to look right.
    expect(writeCount()).toBe(1);
    const parsed = parseJsonc<Record<string, unknown>>(files["/settings.json"]!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.sidebarWidth"]).toBe(30);
  });

  test("flush() with nothing pending resolves without writing", async () => {
    const { fs, files } = createFakeFs({});
    const { timer } = createManualTimer();
    const writer = createSidebarWidthSettingsWriter({ path: "/settings.json", fs, timer });

    await writer.flush();
    expect(files["/settings.json"]).toBeUndefined();
  });

  test("a read failure (not ENOENT) reports through log/sink and never throws", async () => {
    const fs: SidebarWidthSettingsWriterFs = {
      readFile: () => Promise.reject(new Error("disk on fire")),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
    };
    const { timer } = createManualTimer();
    const messages: string[] = [];
    const writer = createSidebarWidthSettingsWriter({
      path: "/settings.json",
      fs,
      timer,
      sink: { error: (e) => messages.push(e.message) },
    });

    writer.write(40);
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
  });

  test("a write failure reports through log/sink and never throws", async () => {
    const fs: SidebarWidthSettingsWriterFs = {
      readFile: () => Promise.resolve("{}\n"),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.reject(new Error("disk full")),
    };
    const { timer } = createManualTimer();
    const messages: string[] = [];
    const writer = createSidebarWidthSettingsWriter({
      path: "/settings.json",
      fs,
      timer,
      sink: { error: (e) => messages.push(e.message) },
    });

    writer.write(40);
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
  });
});
