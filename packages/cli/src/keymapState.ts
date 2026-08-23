/**
 * Keeps the layered `BindingTable` up to date across the CLI's startup
 * phases (Req 4.1-4.3; design.md §6.2; CodeRabbit's Phase 2 plan): the
 * sync phase builds one with whatever is known synchronously (nothing —
 * `defaults`/`fallback` have no source yet, see below), `ConfigService`'s
 * `onKeybindingsChange` hook rebuilds it with the `user` layer once the
 * user's `keybindings.json` has loaded (and again on every live reload),
 * and the deferred phase rebuilds it again once `loadExtensions`'s
 * `extensionKeybindings` are known.
 *
 * **`defaults`/`fallback` are `[]` today, deliberately.** `KeymapLayers`
 * (`@tecode/core`'s `bindingTable.ts`) requires all four layers regardless
 * of which are populated yet:
 * - `defaults` — core commands' own default bindings. No core command
 *   contributes one yet (editor-core's movement/editing commands are
 *   Phase 2 tasks, command-palette's `ctrl+shift+p`/`ctrl+p` are Phase 3) —
 *   there is nothing to seed this layer with until those land.
 * - `fallback` — the terminal-capability fallback overlay (Req 4.7).
 *   `terminalCapabilities.ts`'s stub result feeds this once Task 4.2 wires
 *   real detection; until then it stays empty, exactly like
 *   `bindingTable.ts`'s own TSDoc says it may.
 *
 * `@tecode/core` has no OpenTUI key-event pipeline consuming this table
 * yet (routing key input into editing is tasks.md's Task 2.2) — this
 * module's job for Task 1.15 is only to keep the table itself correctly
 * assembled and rebuildable end to end, the same way `ui/slotRegistry.ts`
 * is kept live before any view consumes it.
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
}

/** Build a {@link KeymapState} (Req 4.1-4.3). Starts with every layer
 * empty; `getTable()` is always safe to call, even before either setter
 * has ever run. */
export function createKeymapState(log: HostLog): KeymapState {
  let userEntries: KeybindingContribution[] = [];
  let extensionEntries: KeybindingContribution[] = [];
  let table = build();

  function build(): BindingTable {
    return createBindingTable(
      { defaults: [], fallback: [], extension: extensionEntries, user: userEntries },
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
  };
}
