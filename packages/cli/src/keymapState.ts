/**
 * Keeps the layered `BindingTable` up to date across the CLI's startup
 * phases (Req 4.1-4.3; design.md §6.2; CodeRabbit's Phase 2 plan): the
 * sync phase builds one with whatever is known synchronously (`defaults` —
 * see below — and an empty `fallback`), `ConfigService`'s
 * `onKeybindingsChange` hook rebuilds it with the `user` layer once the
 * user's `keybindings.json` has loaded (and again on every live reload),
 * and the deferred phase rebuilds it again once `loadExtensions`'s
 * `extensionKeybindings` are known.
 *
 * **`defaults` — core commands' own default bindings** (Task 3.1): fixed
 * at construction via {@link createKeymapState}'s second parameter, never
 * mutated afterward (unlike `user`/`extension`, which change over the
 * app's lifetime) — core commands' own bindings are static data known at
 * startup, not something that reloads. `main.ts`'s composition root passes
 * `@tecode/core`'s `MODAL_DEFAULT_KEYBINDINGS` (`modal.selectNext`/
 * `selectPrevious`/`accept`/`close`, Req 10.1) as this task's first real
 * occupant of a layer `bindingTable.ts` has reserved since Task 1.5.
 * Defaults to `[]` for a caller with nothing to seed it with (every test
 * that predates Task 3.1) — `KeymapLayers` (`@tecode/core`'s
 * `bindingTable.ts`) requires all four layers regardless of which are
 * populated.
 *
 * **`fallback` — the terminal-capability fallback overlay** (Req 4.7,
 * design.md §6.5, Task 4.2): starts `[]`, exactly like `user`/`extension`
 * (below), and is rebuilt via {@link setFallbackEntries} exactly once per
 * run — `main.ts`'s `runTecode` calls it from `renderShell.tsx`'s
 * `onCapabilitiesResolved` callback, with either `@tecode/core`'s
 * `loadFallbackKeybindings` result (terminal is NOT Kitty-capable) or `[]`
 * (terminal IS Kitty-capable, or the answer is still unknown — see that
 * module's TSDoc for why "unknown" degrades the same way as "no"). Unlike
 * `user`/`extension`, this is expected to be called at most once in a real
 * run (a terminal's capabilities do not change mid-session) — `setFallbackEntries`
 * itself has no such restriction, though; it is a plain replace, callable
 * any number of times, exactly like its two siblings, which is what lets
 * tests call it directly without needing a fake terminal.
 *
 * **A fifth layer, `preset` (Req 4.8, design.md §6.6, Issue #81 Phase 2),
 * lived here until Issue #115 removed it**: a bundled keybinding preset
 * overlay, selected by name via a `keybindings.preset` setting, sitting
 * above `extension` and below `user`. It shipped ~950 lines of machinery
 * (this module's own `setPresetEntries` setter, `@tecode/core`'s
 * `presetKeybindings.ts`, `cli`'s `keybindingPresetConfigSync.ts`, a
 * dedicated `bindingTable.ts` layer) for 19 lines of JSON that the `user`
 * layer above already expresses just as well — a hand-authored
 * `~/.config/tecode/keybindings.json` entry sits at the HIGHEST
 * precedence of all, so it inherits the exact same "can override, or
 * `-command`-remove, an extension's own default binding" power a preset
 * needed a dedicated layer for. `samples/keybindings.emacs.json`/
 * `samples/keybindings.windows.json` (in this repository) are the same
 * content as plain, copyable starting points now.
 */

import { createBindingTable, type BindingTable, type HostLog } from "@tecode/core";
import type { KeybindingContribution } from "@tecode/api";

/** The mutable keymap-table holder {@link createKeymapState} returns. */
export interface KeymapState {
  /** The current binding table — always up to date as of the last
   * {@link setUserEntries}/{@link setExtensionEntries} call. */
  getTable(): BindingTable;
  /**
   * Rebuild with a new `user` layer — wired as `ConfigService`'s
   * `onKeybindingsChange` hook (`config/service.ts`). Entries are raw,
   * unvalidated JSON (`ConfigService` "does not interpret keybinding
   * entries" — its own TSDoc): `createBindingTable`'s `compileEntry`
   * already guards every field defensively (a non-string `key`/`command`
   * is skipped and logged, not trusted blindly), so casting here is safe.
   */
  setUserEntries(entries: readonly unknown[]): void;
  /** Rebuild with a new `extension` layer — called once from the deferred
   * phase with `LoadExtensionsResult.extensionKeybindings` once discovery
   * and registration have run. */
  setExtensionEntries(entries: readonly KeybindingContribution[]): void;
  /** Rebuild with a new `fallback` layer (Req 4.7, design.md §6.5, Task
   * 4.2) — called from `main.ts`'s `runTecode` once the terminal's Kitty
   * Keyboard Protocol capability is known, with either the loaded
   * `keybindings.fallback.json` entries (not Kitty-capable) or `[]`
   * (Kitty-capable). Sits BELOW `extension`/`user` in precedence
   * (`bindingTable.ts`'s `LAYER_ORDER`) — an extension's own binding, and
   * certainly the user's own `keybindings.json`, always wins over this
   * overlay on the same key. */
  setFallbackEntries(entries: readonly KeybindingContribution[]): void;
}

/** Build a {@link KeymapState} (Req 4.1-4.3). `defaults` seeds the
 * `defaults` layer once and for all (this module's TSDoc) — omit it (or
 * pass `[]`) for the pre-Task-3.1 behavior of an empty defaults layer.
 * `user`/`extension` start empty regardless; `getTable()` is always safe to
 * call, even before either setter has ever run. */
export function createKeymapState(
  log: HostLog,
  defaults: readonly KeybindingContribution[] = [],
): KeymapState {
  const defaultEntries = defaults.slice();
  let userEntries: KeybindingContribution[] = [];
  let extensionEntries: KeybindingContribution[] = [];
  let fallbackEntries: KeybindingContribution[] = [];
  let table = build();

  function build(): BindingTable {
    return createBindingTable(
      {
        defaults: defaultEntries,
        fallback: fallbackEntries,
        extension: extensionEntries,
        user: userEntries,
      },
      { log },
    );
  }

  return {
    getTable: () => table,
    setUserEntries(entries) {
      userEntries = entries as KeybindingContribution[];
      table = build();
    },
    setExtensionEntries(entries) {
      extensionEntries = entries.slice();
      table = build();
    },
    setFallbackEntries(entries) {
      fallbackEntries = entries.slice();
      table = build();
    },
  };
}
