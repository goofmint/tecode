/**
 * Tests for {@link applyPanelHeightSetting}/
 * {@link createPanelHeightSettingsWriter} (Issue #146).
 */

import { describe, expect, test } from "bun:test";
import { parseJsonc } from "../config/jsonc";
import {
  applyPanelHeightSetting,
  createPanelHeightSettingsWriter,
  type PanelHeightSettingsWriterFs,
  type PanelHeightSettingsWriterTimer,
} from "./panelHeightSettingsWriter";

describe("applyPanelHeightSetting (Issue #146, text-replace)", () => {
  test("replaces an existing key's value in place, byte-for-byte elsewhere", () => {
    const before = `{\n  // a comment\n  "editor.tabSize": 2,\n  "workbench.panelHeight": 12,\n  "editor.wordWrap": true\n}\n`;
    const after = applyPanelHeightSetting(before, 18);
    expect(after).toBe(
      `{\n  // a comment\n  "editor.tabSize": 2,\n  "workbench.panelHeight": 18,\n  "editor.wordWrap": true\n}\n`,
    );
  });

  test("appends the key when absent, into an object with existing keys", () => {
    const before = `{\n  "editor.tabSize": 2\n}\n`;
    const after = applyPanelHeightSetting(before, 15);
    expect(after).toBe(`{\n  "workbench.panelHeight": 15,\n  "editor.tabSize": 2\n}\n`);
    const parsed = parseJsonc<Record<string, unknown>>(after!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.panelHeight"]).toBe(15);
  });

  test("appends the key into an otherwise-empty object", () => {
    const after = applyPanelHeightSetting("{}\n", 11);
    const parsed = parseJsonc<Record<string, unknown>>(after!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value["workbench.panelHeight"]).toBe(11);
      expect(Object.keys(parsed.value)).toEqual(["workbench.panelHeight"]);
    }
  });

  test("falls back to a fresh minimal file when there is no object to insert into (a genuinely empty file — nothing existed to lose)", () => {
    const after = applyPanelHeightSetting("", 11);
    expect(after).not.toBeNull();
    const parsed = parseJsonc<Record<string, unknown>>(after!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.panelHeight"]).toBe(11);
  });

  test("returns null (refuses to apply) for an existing NON-EMPTY file with no discoverable top-level object — a comment-only or incomplete file must not be silently replaced (CodeRabbit PR #156)", () => {
    expect(applyPanelHeightSetting("// TODO: fill in real settings later\n", 20)).toBeNull();
    // A bare fragment mid-edit — no braces at all.
    expect(applyPanelHeightSetting('"workbench.panelHeight"', 20)).toBeNull();
    // Whitespace-only content still counts as "something existed" here —
    // only the literal empty string bootstraps (this module's own TSDoc).
    expect(applyPanelHeightSetting("   \n", 20)).toBeNull();
  });

  test("replaces an existing non-numeric value in place rather than appending a duplicate key (regression)", () => {
    const before = `{\n  "editor.tabSize": 2,\n  "workbench.panelHeight": null,\n  "editor.wordWrap": true\n}\n`;
    const after = applyPanelHeightSetting(before, 13);
    expect(after).toBe(
      `{\n  "editor.tabSize": 2,\n  "workbench.panelHeight": 13,\n  "editor.wordWrap": true\n}\n`,
    );
    expect(after!.match(/"workbench\.panelHeight"/g)).toHaveLength(1);
  });

  test("does not disturb a different key sharing a suffix with the real key", () => {
    const before = `{\n  "notWorkbench.panelHeight": "untouched"\n}\n`;
    const after = applyPanelHeightSetting(before, 13);
    expect(after).toContain('"notWorkbench.panelHeight": "untouched"');
    expect(after).toContain('"workbench.panelHeight": 13');
  });

  test("a key that appears ONLY inside a comment is left untouched, and a real key is appended instead (mirrors Issue #105 Finding 5)", () => {
    // Regression: a naive implementation searching the RAW text (only the
    // no-open-brace fallback path using `stripComments`) would match a
    // commented-out occurrence of the key as if it were live and splice
    // into it — corrupting the comment and leaving no real, parseable
    // `"workbench.panelHeight"` entry at all.
    const before = `{\n  // "workbench.panelHeight": 10,\n  "editor.tabSize": 2\n}\n`;
    const after = applyPanelHeightSetting(before, 18);

    // The comment survives byte-for-byte...
    expect(after).toContain('// "workbench.panelHeight": 10,');
    // ...and a REAL key was appended rather than spliced into the comment.
    const parsed = parseJsonc<Record<string, unknown>>(after!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value["workbench.panelHeight"]).toBe(18);
      expect(parsed.value["editor.tabSize"]).toBe(2);
    }
  });
});

function createFakeFs(initial: Record<string, string>): {
  fs: PanelHeightSettingsWriterFs;
  files: Record<string, string>;
  /** How many times `writeFile` actually ran — unlike counting
   * `Object.keys(files)`, which only ever reports how many DISTINCT paths
   * were ever written (always 1 for these single-path tests, regardless of
   * how many times `writeFile` ran), this increments on every call, so a
   * mutation that fires a disk write per `write()` call instead of once
   * per debounce window is actually caught (mirrors Issue #105 Finding 4). */
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

/** A manually-driven {@link PanelHeightSettingsWriterTimer} — matches
 * `sidebarWidthSettingsWriter.test.ts`'s `createManualTimer` exactly
 * (deterministic, no real waiting): `schedule` records the callback instead
 * of running it on a real clock, and the test fires it later via
 * `runScheduled()`. */
function createManualTimer(): {
  timer: PanelHeightSettingsWriterTimer;
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

describe("createPanelHeightSettingsWriter (Issue #146)", () => {
  test("writes a fresh file when settings.json does not exist yet, once the debounce fires", async () => {
    const { fs, files } = createFakeFs({});
    const { timer, runScheduled } = createManualTimer();
    const writer = createPanelHeightSettingsWriter({ path: "/settings.json", fs, timer });

    writer.write(16);
    // Nothing written yet — still debouncing.
    expect(files["/settings.json"]).toBeUndefined();

    runScheduled();
    await writer.flush();
    const parsed = parseJsonc<Record<string, unknown>>(files["/settings.json"]!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.panelHeight"]).toBe(16);
  });

  test("preserves the rest of an existing settings.json", async () => {
    const before = `{\n  "editor.tabSize": 8,\n  "workbench.panelHeight": 10\n}\n`;
    const { fs, files } = createFakeFs({ "/settings.json": before });
    const { timer } = createManualTimer();
    const writer = createPanelHeightSettingsWriter({ path: "/settings.json", fs, timer });

    writer.write(22);
    await writer.flush();
    expect(files["/settings.json"]).toBe(`{\n  "editor.tabSize": 8,\n  "workbench.panelHeight": 22\n}\n`);
  });

  test("a burst of write() calls before the debounce fires produces exactly ONE disk write, with the latest value (the load-bearing debounce contract)", async () => {
    // This is the shape of a real user mashing the increase/decrease
    // keybinding: several commits land within one debounce window. Only
    // one actual write to settings.json must result — the whole reason
    // this module debounces rather than writing immediately like
    // `themeSettingsWriter.ts` does.
    const { fs, files, writeCount } = createFakeFs({ "/settings.json": "{}\n" });
    const { timer, scheduledCount, runScheduled } = createManualTimer();
    const writer = createPanelHeightSettingsWriter({ path: "/settings.json", fs, timer });

    writer.write(10);
    writer.write(13);
    writer.write(16);
    // Every write() call cancels the previous timer and schedules a fresh
    // one — `scheduledCount` (a monotonic counter, never decremented by
    // cancellation) proves 3 schedule() calls happened, but only the LAST
    // one is ever allowed to actually run to completion.
    expect(scheduledCount()).toBe(3);

    runScheduled();
    await writer.flush();

    // Only one actual `writeFile` call happened — asserted via a counter
    // incremented INSIDE the fake `writeFile` (mirrors Issue #105 Finding
    // 4: counting `Object.keys(files)` instead cannot fail here, since that
    // map is keyed by PATH — one key regardless of how many times
    // `writeFile` ran against it), so a mutation that fires a write per
    // update() call (rather than once per debounce window) would be
    // caught even if the final value still happened to look right.
    expect(writeCount()).toBe(1);
    const parsed = parseJsonc<Record<string, unknown>>(files["/settings.json"]!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value["workbench.panelHeight"]).toBe(16);
  });

  test("flush() with nothing pending resolves without writing", async () => {
    const { fs, files } = createFakeFs({});
    const { timer } = createManualTimer();
    const writer = createPanelHeightSettingsWriter({ path: "/settings.json", fs, timer });

    await writer.flush();
    expect(files["/settings.json"]).toBeUndefined();
  });

  test("a read failure (not ENOENT) reports through log/sink and never throws", async () => {
    const fs: PanelHeightSettingsWriterFs = {
      readFile: () => Promise.reject(new Error("disk on fire")),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.resolve(),
    };
    const { timer } = createManualTimer();
    const messages: string[] = [];
    const writer = createPanelHeightSettingsWriter({
      path: "/settings.json",
      fs,
      timer,
      sink: { error: (e) => messages.push(e.message) },
    });

    writer.write(16);
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
  });

  test("a write failure reports through log/sink and never throws", async () => {
    const fs: PanelHeightSettingsWriterFs = {
      readFile: () => Promise.resolve("{}\n"),
      mkdir: () => Promise.resolve(),
      writeFile: () => Promise.reject(new Error("disk full")),
    };
    const { timer } = createManualTimer();
    const messages: string[] = [];
    const writer = createPanelHeightSettingsWriter({
      path: "/settings.json",
      fs,
      timer,
      sink: { error: (e) => messages.push(e.message) },
    });

    writer.write(16);
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
  });

  test("an existing settings.json with no parseable top-level object is left untouched, reported through log/sink instead of overwritten (CodeRabbit PR #156)", async () => {
    const before = "// mid-edit, not valid JSON yet\n";
    const { fs, files, writeCount } = createFakeFs({ "/settings.json": before });
    const { timer } = createManualTimer();
    const messages: string[] = [];
    const writer = createPanelHeightSettingsWriter({
      path: "/settings.json",
      fs,
      timer,
      sink: { error: (e) => messages.push(e.message) },
    });

    writer.write(20);
    await writer.flush();

    // Untouched — NOT overwritten with a fresh minimal file.
    expect(files["/settings.json"]).toBe(before);
    expect(writeCount()).toBe(0);
    expect(messages).toHaveLength(1);
  });
});

test("appending into an EMPTY object emits no trailing comma — a fresh install's first resize must not write invalid JSON", () => {
  // Mirrors `sidebarWidthSettingsWriter.test.ts`'s identical regression: a
  // mutation run wrote into an empty `~/.config/tecode/settings.json` and
  // produced `{"workbench.panelHeight": 13,}`. `parseJsonc` tolerates a
  // trailing comma, so every round trip through this codebase's own reader
  // looked fine — but `JSON.parse`, an editor, or any stricter tool does
  // not, and this is exactly the path a first-ever resize takes on a fresh
  // install.
  for (const input of ["{}\n", "{}", "{\n}\n", "{\n  // only a comment\n}\n"]) {
    const out = applyPanelHeightSetting(input, 13);
    expect(out).not.toBeNull();
    expect(out).not.toContain(",}");
    expect(out).not.toContain(",\n}");
    // Strict JSON, once comments are stripped the way a reader would.
    expect(() => JSON.parse(out!.replace(/^\s*\/\/.*$/gm, ""))).not.toThrow();
    expect(JSON.parse(out!.replace(/^\s*\/\/.*$/gm, ""))).toEqual({ "workbench.panelHeight": 13 });
  }

  // A non-empty object still gets its separating comma.
  const withSibling = applyPanelHeightSetting('{\n  "editor.tabSize": 2\n}\n', 13);
  expect(JSON.parse(withSibling!)).toEqual({ "workbench.panelHeight": 13, "editor.tabSize": 2 });
});
