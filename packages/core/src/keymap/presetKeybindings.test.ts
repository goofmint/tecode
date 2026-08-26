/**
 * Tests for {@link resolveKeybindingPreset} and its exported constants (Req
 * 12.1, 12.2, design.md §6.6, Issue #81 Phase 2). Cross-package
 * completeness checks — every referenced command actually exists, the
 * `ctrl+k` chord-shadowing fix, layer-precedence proofs — live in
 * `packages/cli/src/keybindingPresets.test.ts` instead, since they need
 * `@tecode/builtin`'s real manifests and `core` may not import `builtin`
 * (`config/coreDefaults.ts`'s own TSDoc explains the same one-directional
 * layering constraint).
 */

import { expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import {
  DEFAULT_KEYBINDING_PRESET_NAME,
  EMACS_KEYBINDING_PRESET,
  KEYBINDING_PRESET_NAMES,
  resolveKeybindingPreset,
  WINDOWS_KEYBINDING_PRESET,
} from "./presetKeybindings";

test("KEYBINDING_PRESET_NAMES is exactly default/emacs/windows — no vim, deliberately (Issue #81's scope)", () => {
  const names: string[] = [...KEYBINDING_PRESET_NAMES];
  expect(names.sort()).toEqual(["default", "emacs", "windows"].sort());
});

test("DEFAULT_KEYBINDING_PRESET_NAME is 'default'", () => {
  expect(DEFAULT_KEYBINDING_PRESET_NAME).toBe("default");
});

test('resolveKeybindingPreset("default") resolves to [] and logs nothing (the expected no-op)', () => {
  const log = createHostLog();
  expect(resolveKeybindingPreset("default", { log })).toEqual([]);
  expect(log.entries()).toEqual([]);
});

test('resolveKeybindingPreset("emacs") resolves to the real bundled EMACS_KEYBINDING_PRESET, not a copy that happens to look equal', () => {
  const log = createHostLog();
  const resolved = resolveKeybindingPreset("emacs", { log });
  expect(resolved).toEqual(EMACS_KEYBINDING_PRESET);
  expect(resolved.length).toBeGreaterThan(0);
  expect(log.entries()).toEqual([]);
});

test('resolveKeybindingPreset("windows") resolves to the real bundled WINDOWS_KEYBINDING_PRESET', () => {
  const log = createHostLog();
  const resolved = resolveKeybindingPreset("windows", { log });
  expect(resolved).toEqual(WINDOWS_KEYBINDING_PRESET);
  expect(resolved.length).toBeGreaterThan(0);
  expect(log.entries()).toEqual([]);
});

test("resolveKeybindingPreset returns a fresh array each call — callers may safely mutate the result", () => {
  const log = createHostLog();
  const a = resolveKeybindingPreset("emacs", { log });
  const b = resolveKeybindingPreset("emacs", { log });
  expect(a).not.toBe(b);
  expect(a).not.toBe(EMACS_KEYBINDING_PRESET);
});

test('an unknown preset name resolves to [] and logs a warning naming the value and the valid set (not "default"\'s silent no-op)', () => {
  const log = createHostLog();
  const resolved = resolveKeybindingPreset("vim", { log });
  expect(resolved).toEqual([]);
  const warnings = log.entries().filter((e) => e.level === "warning");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.error.message).toContain("vim");
  expect(warnings[0]?.error.message).toContain("emacs");
  expect(warnings[0]?.error.message).toContain("windows");
});

test("an empty-string preset name is treated as unknown, not as default", () => {
  const log = createHostLog();
  expect(resolveKeybindingPreset("", { log })).toEqual([]);
  expect(log.entries().some((e) => e.level === "warning")).toBe(true);
});

test("resolveKeybindingPreset never throws even when the injected log itself throws", () => {
  const throwingLog = {
    append: () => {
      throw new Error("log is broken");
    },
    entries: () => [],
  };
  expect(() => resolveKeybindingPreset("not-a-real-preset", { log: throwingLog as never })).not.toThrow();
});

test("EMACS_KEYBINDING_PRESET removes keybindings-editor's ctrl+k ctrl+s chord via -command syntax", () => {
  const removal = EMACS_KEYBINDING_PRESET.find(
    (entry) => entry.key === "ctrl+k ctrl+s",
  );
  expect(removal?.command).toBe("-keybindings.open");
});

test("EMACS_KEYBINDING_PRESET binds ctrl+k to deleteLine (Emacs kill-line)", () => {
  const killLine = EMACS_KEYBINDING_PRESET.find((entry) => entry.key === "ctrl+k");
  expect(killLine?.command).toBe("editor.action.deleteLine");
  expect(killLine?.when).toBe("editorTextFocus");
});

test("every EMACS_KEYBINDING_PRESET/WINDOWS_KEYBINDING_PRESET entry has a non-empty string key and command", () => {
  for (const entry of [...EMACS_KEYBINDING_PRESET, ...WINDOWS_KEYBINDING_PRESET]) {
    expect(typeof entry.key).toBe("string");
    expect(entry.key.length).toBeGreaterThan(0);
    expect(typeof entry.command).toBe("string");
    expect(entry.command.length).toBeGreaterThan(0);
  }
});
