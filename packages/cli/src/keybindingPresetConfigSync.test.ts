/**
 * Tests for {@link applyConfiguredKeybindingPreset}/
 * {@link wireKeybindingPresetConfigSync} (Req 4.8, design.md §6.6,
 * Issue #81 Phase 2) — mirrors `@tecode/core`'s `ui/themeConfigSync.test.ts`
 * almost exactly (fake `ConfigService`/`KeymapState`, no real filesystem),
 * since this module is the `keybindings.preset` analog of that one's
 * `workbench.colorTheme` wiring.
 */

import { describe, expect, test } from "bun:test";
import { createHostLog, type ConfigService } from "@tecode/core";
import type { KeymapState } from "./keymapState";
import {
  applyConfiguredKeybindingPreset,
  wireKeybindingPresetConfigSync,
} from "./keybindingPresetConfigSync";

/** A fake `ConfigService` slice: `get` reads from a plain mutable record,
 * `onDidChange` fires a fake `ConfigChangeEvent` on demand via `trigger` —
 * mirrors `themeConfigSync.test.ts`'s real-`ConfigService` harness, just
 * with an in-memory fake instead (this module has no `config/service.ts`
 * import to build a real one against without an unwanted `cli -> core`
 * roundabout). */
function createFakeConfig(initial: Record<string, unknown> = {}): {
  config: Pick<ConfigService, "get" | "onDidChange">;
  set(key: string, value: unknown): void;
  trigger(key: string): void;
} {
  const values = { ...initial };
  const listeners = new Set<(event: { affectsConfiguration(key: string): boolean }) => void>();
  return {
    set(key, value) {
      values[key] = value;
    },
    trigger(key) {
      for (const listener of listeners) {
        listener({ affectsConfiguration: (k) => k === key });
      }
    },
    config: {
      get: <T,>(key: string) => values[key] as T | undefined,
      onDidChange: (listener) => {
        listeners.add(listener as never);
        return {
          dispose() {
            listeners.delete(listener as never);
          },
        };
      },
    },
  };
}

/** A fake `KeymapState` slice: just records every `setPresetEntries` call. */
function createFakeKeymap(): { keymap: Pick<KeymapState, "setPresetEntries">; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    keymap: {
      setPresetEntries: (entries) => {
        calls.push([entries]);
      },
    },
  };
}

describe("applyConfiguredKeybindingPreset (Req 4.8)", () => {
  test('resolves "emacs" and feeds real Emacs entries into keymap.setPresetEntries', () => {
    const { config } = createFakeConfig({ "keybindings.preset": "emacs" });
    const { keymap, calls } = createFakeKeymap();
    applyConfiguredKeybindingPreset({ config, keymap, log: createHostLog() });

    expect(calls).toHaveLength(1);
    const entries = calls[0]?.[0] as Array<{ key: string; command: string }>;
    expect(entries.some((e) => e.key === "ctrl+k" && e.command === "editor.action.deleteLine")).toBe(
      true,
    );
  });

  test("a missing config value falls back to the default preset ([])", () => {
    const { config } = createFakeConfig({});
    const { keymap, calls } = createFakeKeymap();
    applyConfiguredKeybindingPreset({ config, keymap, log: createHostLog() });

    expect(calls).toEqual([[[]]]);
  });

  test("a non-string config value falls back to the default preset ([]) rather than throwing", () => {
    const { config } = createFakeConfig({ "keybindings.preset": 42 });
    const { keymap, calls } = createFakeKeymap();
    expect(() =>
      applyConfiguredKeybindingPreset({ config, keymap, log: createHostLog() }),
    ).not.toThrow();
    expect(calls).toEqual([[[]]]);
  });

  test("an unknown preset name resolves to [] and logs a warning, never throws", () => {
    const { config } = createFakeConfig({ "keybindings.preset": "vim" });
    const { keymap, calls } = createFakeKeymap();
    const log = createHostLog();
    applyConfiguredKeybindingPreset({ config, keymap, log });

    expect(calls).toEqual([[[]]]);
    expect(log.entries().some((e) => e.level === "warning")).toBe(true);
  });

  test("a throwing config.get is caught, logged, and still degrades to the default preset", () => {
    const keymapFake = createFakeKeymap();
    const log = createHostLog();
    const throwingConfig: Pick<ConfigService, "get" | "onDidChange"> = {
      get: () => {
        throw new Error("config is broken");
      },
      onDidChange: () => ({ dispose() {} }),
    };

    expect(() =>
      applyConfiguredKeybindingPreset({ config: throwingConfig, keymap: keymapFake.keymap, log }),
    ).not.toThrow();
    expect(keymapFake.calls).toEqual([[[]]]);
    expect(log.entries().some((e) => e.level === "error")).toBe(true);
  });
});

describe("wireKeybindingPresetConfigSync (Req 4.8, config-file-driven live switching)", () => {
  test("a keybindings.preset config change live-reapplies the preset without a restart", () => {
    const { config, set, trigger } = createFakeConfig({ "keybindings.preset": "default" });
    const { keymap, calls } = createFakeKeymap();
    const sub = wireKeybindingPresetConfigSync({ config, keymap, log: createHostLog() });

    set("keybindings.preset", "windows");
    trigger("keybindings.preset");

    expect(calls).toHaveLength(1);
    const entries = calls[0]?.[0] as Array<{ key: string; command: string }>;
    expect(entries.some((e) => e.command === "editor.action.moveLinesUp")).toBe(true);
    sub.dispose();
  });

  test("a config change to an unrelated key does not touch the preset layer", () => {
    const { config, set, trigger } = createFakeConfig({ "keybindings.preset": "default" });
    const { keymap, calls } = createFakeKeymap();
    const sub = wireKeybindingPresetConfigSync({ config, keymap, log: createHostLog() });

    set("editor.tabSize", 8);
    trigger("editor.tabSize");

    expect(calls).toHaveLength(0);
    sub.dispose();
  });

  test("dispose() stops future config changes from affecting the preset layer", () => {
    const { config, set, trigger } = createFakeConfig({ "keybindings.preset": "default" });
    const { keymap, calls } = createFakeKeymap();
    const sub = wireKeybindingPresetConfigSync({ config, keymap, log: createHostLog() });
    sub.dispose();

    set("keybindings.preset", "emacs");
    trigger("keybindings.preset");

    expect(calls).toHaveLength(0);
  });

  test("dispose() is idempotent", () => {
    const { config } = createFakeConfig({});
    const { keymap } = createFakeKeymap();
    const sub = wireKeybindingPresetConfigSync({ config, keymap, log: createHostLog() });
    expect(() => {
      sub.dispose();
      sub.dispose();
    }).not.toThrow();
  });
});
