/**
 * Completeness/correctness tests for `@tecode/core`'s bundled keybinding
 * presets (Req 4.8; design.md §6.6; Issue #81 Phase 2:
 * `keymap/presets/emacs.json`/`windows.json`). Lives in `packages/cli`
 * rather than beside the presets in `packages/core/src/keymap/` (matching
 * `sampleConfig.test.ts`/`fallbackKeybindingsCompleteness.test.ts`'s own
 * precedent) because it needs `@tecode/builtin`'s real manifests to derive
 * the valid command-id set and to build a REALISTIC layered table — `core`
 * may not import `builtin` (`config/coreDefaults.ts`'s TSDoc explains the
 * same one-directional layering constraint), but `cli` is the one place
 * that legitimately depends on both.
 *
 * Five things are proven here, against REAL production code, not
 * hand-rolled assertions about the files' text:
 *
 * 1. Each preset's on-disk JSON parses via the repo's real `parseJsonc`
 *    into an array.
 * 2. Each preset's entries compile through a REAL `createBindingTable`
 *    (layered under the same `defaults`/`fallback`/`extension` layers
 *    `main.ts` builds in a real run) with ZERO warnings.
 * 3. Every `command` any preset references — including a `-command`
 *    removal's target — actually exists as a real command id somewhere in
 *    the app (`MODAL_DEFAULT_KEYBINDINGS`/`TAB_DEFAULT_KEYBINDINGS`'s own
 *    commands, or some built-in manifest's `contributes.commands`). A
 *    typo'd id here would otherwise be a silently-dead binding.
 * 4. THE critical regression this phase exists to prevent: pressing plain
 *    `ctrl+k` under the Emacs preset resolves DIRECTLY to
 *    `editor.action.deleteLine` — it does not enter chord-pending state
 *    waiting for a second stroke. `keybindings-editor`'s manifest binds
 *    `ctrl+k ctrl+s` -> `keybindings.open` with no `when` clause, and
 *    `chords.ts`'s `handleIdleStroke` checks `hasSequencePrefix`
 *    UNCONDITIONALLY before ever trying an exact match ("prefix wins",
 *    design.md §6.3) — so without `presets/emacs.json`'s own `-command`
 *    removal of that chord, `ctrl+k` would silently never fire Emacs's
 *    kill-line binding. This test presses the REAL `ChordStateMachine`,
 *    not just the table, so a regression here would actually manifest as
 *    a stuck keystroke, not merely a missing table entry.
 * 5. No `"vim"` preset exists anywhere — Issue #81's author explicitly
 *    dropped it (this codebase's `when` contexts are purely focus-based,
 *    with no mode concept a non-modal "vim" preset could honestly claim).
 *
 * `buildRealTable`'s `defaults` layer additionally includes Issue #105's
 * `SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS` (`ui/sidebarWidthCommands.ts`,
 * `ctrl+k [`/`ctrl+k ]`) alongside `MODAL_DEFAULT_KEYBINDINGS`/
 * `TAB_DEFAULT_KEYBINDINGS` — a SECOND, independent reason `ctrl+k` could
 * wrongly stay a live chord prefix under `editorTextFocus`, on top of
 * `keybindings-editor`'s own `ctrl+k ctrl+s`. Point 4's chord-machine test
 * therefore now also guards `SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS`'s own
 * `SIDEBAR_WIDTH_FOCUS_WHEN` clause, not just Emacs's `-keybindings.open`
 * removal — see "the ctrl+k chord-shadowing hazard" describe block below
 * for both halves (the `when` clause failing under `editorTextFocus`, and
 * succeeding under `sidebarFocus`/`explorerFocus`).
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { builtinManifests } from "@tecode/builtin";
import {
  BUNDLED_FALLBACK_KEYBINDINGS,
  createBindingTable,
  createChordStateMachine,
  createContextService,
  createHostLog,
  DEFAULT_KEYBINDING_PRESET,
  DEFAULT_KEYBINDING_PRESET_NAME,
  EMACS_KEYBINDING_PRESET,
  KEYBINDING_PRESET_NAMES,
  MODAL_DEFAULT_KEYBINDINGS,
  parseJsonc,
  resolveKeybindingPreset,
  SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS,
  TAB_DEFAULT_KEYBINDINGS,
  WINDOWS_KEYBINDING_PRESET,
  type BindingLayer,
  type HostLog,
  type KeymapLayers,
} from "@tecode/core";
import type { KeybindingContribution } from "@tecode/api";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const EMACS_PRESET_PATH = resolve(REPO_ROOT, "packages/core/src/keymap/presets/emacs.json");
const WINDOWS_PRESET_PATH = resolve(REPO_ROOT, "packages/core/src/keymap/presets/windows.json");

/** Every real command id known to a full startup (`main.ts`'s own
 * composition — same two core-defaults arrays plus every built-in
 * manifest's `contributes.commands`, mirroring
 * `fallbackKeybindingsCompleteness.test.ts`'s identical "derive from the
 * real sources, don't hand-copy a list" approach). */
const ALL_COMMAND_IDS = new Set<string>([
  ...MODAL_DEFAULT_KEYBINDINGS.map((e) => e.command),
  ...TAB_DEFAULT_KEYBINDINGS.map((e) => e.command),
  ...builtinManifests.flatMap((m) => (m.contributes.commands ?? []).map((c) => c.id)),
]);

/** The target command of a `KeybindingContribution.command`, stripping a
 * leading `"-"` removal marker if present (`bindingTable.ts`'s
 * `compileEntry` does the same before validating). */
function targetCommand(raw: string): string {
  return raw.startsWith("-") ? raw.slice(1) : raw;
}

/** Build a REALISTIC full layered table (mirrors `main.ts`'s own
 * composition, and `sampleConfig.test.ts`'s identical pattern) with
 * exactly one preset active in the `preset` layer, exactly like a real
 * run only ever has one `keybindings.preset` value active at a time. */
function buildRealTable(preset: KeybindingContribution[], log: HostLog) {
  const layers: KeymapLayers = {
    // `SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS` (Issue #105, `ui/
    // sidebarWidthCommands.ts`) joins `main.ts`'s real `defaults` layer
    // alongside `MODAL_DEFAULT_KEYBINDINGS`/`TAB_DEFAULT_KEYBINDINGS` — this
    // table must match `main.ts`'s real composition exactly, since the
    // whole point of this file is pressing the REAL layered table, not a
    // hand-picked subset of it (this module's own TSDoc).
    defaults: [...MODAL_DEFAULT_KEYBINDINGS, ...TAB_DEFAULT_KEYBINDINGS, ...SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS],
    fallback: BUNDLED_FALLBACK_KEYBINDINGS,
    extension: builtinManifests.flatMap((m) => m.contributes.keybindings ?? []),
    preset,
    user: [],
  };
  return createBindingTable(layers, { log });
}

describe("presets/emacs.json, presets/windows.json — parse as JSONC arrays", () => {
  test("emacs.json parses as a JSONC array via the repo's real parser", async () => {
    const raw = await readFile(EMACS_PRESET_PATH, "utf8");
    const parsed = parseJsonc<unknown>(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Array.isArray(parsed.value)).toBe(true);
  });

  test("windows.json parses as a JSONC array via the repo's real parser", async () => {
    const raw = await readFile(WINDOWS_PRESET_PATH, "utf8");
    const parsed = parseJsonc<unknown>(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Array.isArray(parsed.value)).toBe(true);
  });
});

describe("every preset compiles through a real BindingTable with zero warnings", () => {
  test("emacs preset, layered under real defaults/fallback/extension bindings", () => {
    const log = createHostLog();
    buildRealTable(EMACS_KEYBINDING_PRESET, log);
    expect(log.entries()).toEqual([]);
  });

  test("windows preset, layered under real defaults/fallback/extension bindings", () => {
    const log = createHostLog();
    buildRealTable(WINDOWS_KEYBINDING_PRESET, log);
    expect(log.entries()).toEqual([]);
  });
});

describe("every command a preset references actually exists (Req 4.8)", () => {
  test("sanity: the derived command-id set actually contains something (the test below isn't vacuous)", () => {
    expect(ALL_COMMAND_IDS.size).toBeGreaterThan(10);
    expect(ALL_COMMAND_IDS.has("editor.action.deleteLine")).toBe(true);
  });

  test("every emacs.json entry's command (or -removal target) is a real command id", () => {
    for (const entry of EMACS_KEYBINDING_PRESET) {
      const command = targetCommand(entry.command);
      expect(ALL_COMMAND_IDS.has(command)).toBe(true);
    }
  });

  test("every windows.json entry's command is a real command id", () => {
    for (const entry of WINDOWS_KEYBINDING_PRESET) {
      const command = targetCommand(entry.command);
      expect(ALL_COMMAND_IDS.has(command)).toBe(true);
    }
  });
});

describe("layer precedence: preset beats defaults, loses to user (Req 4.8)", () => {
  test("a preset entry beats a defaults-layer binding on the same key", () => {
    const log = createHostLog();
    const table = createBindingTable(
      {
        defaults: [{ key: "ctrl+z", command: "defaults.command" }],
        fallback: [],
        extension: [],
        preset: [{ key: "ctrl+z", command: "preset.command" }],
        user: [],
      },
      { log },
    );
    const resolved = table.lookup("ctrl+z", () => undefined);
    expect(resolved?.command).toBe("preset.command");
    expect(resolved?.layer).toBe("preset");
  });

  test("a user entry beats a preset entry on the same key", () => {
    const log = createHostLog();
    const table = createBindingTable(
      {
        defaults: [],
        fallback: [],
        extension: [],
        preset: [{ key: "ctrl+z", command: "preset.command" }],
        user: [{ key: "ctrl+z", command: "user.command" }],
      },
      { log },
    );
    const resolved = table.lookup("ctrl+z", () => undefined);
    expect(resolved?.command).toBe("user.command");
    expect(resolved?.layer).toBe("user" as BindingLayer);
  });
});

describe("the ctrl+k chord-shadowing hazard (THE reason preset must outrank extension)", () => {
  function contextOf(values: Record<string, unknown>) {
    return (key: string) => values[key];
  }

  test("sanity: WITHOUT the emacs preset, ctrl+k IS a live chord prefix (keybindings-editor's ctrl+k ctrl+s)", () => {
    const log = createHostLog();
    const table = buildRealTable([], log);
    expect(table.hasSequencePrefix("ctrl+k", contextOf({}))).toBe(true);
  });

  test("WITH the emacs preset active, ctrl+k is no longer a live chord prefix under editorTextFocus — this also proves Issue #105's own SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS `when` clause, not just Emacs's -keybindings.open removal", () => {
    // `buildRealTable`'s `defaults` layer now includes
    // `SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS` (`ctrl+k [`/`ctrl+k ]`,
    // `sidebarWidthCommands.ts`) alongside `keybindings-editor`'s
    // `ctrl+k ctrl+s` — TWO independent reasons `ctrl+k` could wrongly stay
    // a live chord prefix under `editorTextFocus` here. Emacs's own
    // `-keybindings.open` removal (`presets/emacs.json`) handles the first;
    // `SIDEBAR_WIDTH_FOCUS_WHEN` ("sidebarFocus || explorerFocus") failing
    // against this context (neither is set) handles the second. Dropping
    // EITHER `when` clause — Emacs's removal, or `sidebarWidthCommands.ts`'s
    // own `SIDEBAR_WIDTH_FOCUS_WHEN` — would flip this assertion to `true`.
    const log = createHostLog();
    const table = buildRealTable(EMACS_KEYBINDING_PRESET, log);
    expect(table.hasSequencePrefix("ctrl+k", contextOf({ editorTextFocus: true }))).toBe(false);
  });

  test("ctrl+k IS a live chord prefix while the sidebar/explorer is focused, even with no preset active — the positive half of SIDEBAR_WIDTH_FOCUS_WHEN", () => {
    const log = createHostLog();
    const table = buildRealTable([], log);
    expect(table.hasSequencePrefix("ctrl+k", contextOf({ sidebarFocus: true }))).toBe(true);
    expect(table.hasSequencePrefix("ctrl+k", contextOf({ explorerFocus: true }))).toBe(true);
  });

  test("pressing plain ctrl+k under the Emacs preset resolves DIRECTLY to editor.action.deleteLine — not a pending chord (Req 4.8)", () => {
    const log = createHostLog();
    const table = buildRealTable(EMACS_KEYBINDING_PRESET, log);
    const context = createContextService();
    context.set("editorTextFocus", true);

    const executed: string[] = [];
    const pendingStates: Array<string | undefined> = [];
    const machine = createChordStateMachine({
      table,
      execute: (id) => {
        executed.push(id);
      },
      getContext: (key) => context.get(key),
      log,
    });
    machine.onDidChangePending((prefix) => pendingStates.push(prefix));

    const result = machine.handleStroke("ctrl+k");

    expect(result).toBe("consumed");
    expect(executed).toEqual(["editor.action.deleteLine"]);
    // Never entered pending state at all — a regression here would show up
    // as a `"ctrl+k"` entry in this array (chord-pending, waiting for a
    // second stroke) instead of a direct execution.
    expect(pendingStates).toEqual([]);
  });

  test("keybindings.open itself is still reachable via the chord when the Emacs preset is NOT active", () => {
    const log = createHostLog();
    const table = buildRealTable([], log);
    const context = createContextService();
    const executed: string[] = [];
    const machine = createChordStateMachine({
      table,
      execute: (id) => {
        executed.push(id);
      },
      getContext: (key) => context.get(key),
      log,
    });

    expect(machine.handleStroke("ctrl+k")).toBe("consumed");
    expect(machine.handleStroke("ctrl+s")).toBe("consumed");
    expect(executed).toEqual(["keybindings.open"]);
  });
});

describe("no vim preset exists anywhere (Issue #81's scope was explicitly narrowed to Emacs + Windows)", () => {
  test("KEYBINDING_PRESET_NAMES has exactly 3 entries, none of them vim", () => {
    const names: string[] = [...KEYBINDING_PRESET_NAMES];
    expect(names).toHaveLength(3);
    expect(names).not.toContain("vim");
  });

  test('resolveKeybindingPreset("vim") is treated as an unknown name, not a real preset', () => {
    const log = createHostLog();
    expect(resolveKeybindingPreset("vim", { log })).toEqual([]);
    expect(log.entries().some((e) => e.level === "warning")).toBe(true);
  });
});

test("config/coreDefaults.ts's DEFAULT_KEYBINDING_PRESET literal stays in sync with keymap/presetKeybindings.ts's DEFAULT_KEYBINDING_PRESET_NAME", () => {
  // These two constants are intentionally duplicated (no `config -> keymap`
  // import edge exists for one literal string, `coreDefaults.ts`'s own
  // TSDoc) — this is the drift guard that duplication's TSDoc promises.
  expect(DEFAULT_KEYBINDING_PRESET).toBe(DEFAULT_KEYBINDING_PRESET_NAME);
});
