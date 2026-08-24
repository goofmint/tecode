/**
 * End-to-end proof of Task 4.3/Req 11.7's config-watch completion
 * requirement — "editing and saving `keybindings.json` is reflected in
 * `showResolved` without restart" — through the REAL production wiring
 * this package assembles, not just `@tecode/core`'s own unit-level getter
 * test (`ui/keybindingsCommands.test.ts`'s "reflects the CURRENT table on
 * every call").
 *
 * `main.ts`'s `buildAssemblyRoot` wires `ConfigService`'s
 * `onKeybindingsChange: (entries) => keymap.setUserEntries(entries)`
 * (Req 9.4's `fs.watch`-driven live reload) and registers
 * `keybindings.internal.resolveTable` against `getTable: () =>
 * keymap.getTable()` (this same file's `keybindingsCommands` wiring).
 * This test reproduces exactly that composition — a real `KeymapState`
 * (`keymapState.ts`) and a real `registerKeybindingsCommands`
 * (`@tecode/core`) — and proves that calling `keymap.setUserEntries(...)`
 * (the literal effect `onKeybindingsChange` has, without needing a real
 * `fs.watch`/temp file/timing-sensitive filesystem event to exercise
 * that one-line callback itself) makes the VERY NEXT
 * `keybindings.internal.resolveTable` call — reached exactly the way
 * `keybindings-editor`'s `showResolved` reaches it, through
 * `commands.execute` — return the updated row, with no restart of
 * anything in between.
 */

import { expect, test } from "bun:test";
import {
  createCommandRegistry,
  createHostLog,
  createNoopStatusSink,
  registerKeybindingsCommands,
  type ResolvedBindingRow,
} from "@tecode/core";
import { createKeymapState } from "./keymapState";

const RESOLVE_TABLE_COMMAND_ID = "keybindings.internal.resolveTable";

test("keybindings.internal.resolveTable reflects a live keymap.setUserEntries reload with no restart", async () => {
  const log = createHostLog();
  const sink = createNoopStatusSink();
  const commands = createCommandRegistry({ log, sink });
  const keymap = createKeymapState(log, [{ key: "ctrl+s", command: "editor.action.save" }]);

  registerKeybindingsCommands(commands, { getTable: () => keymap.getTable(), log });

  const before = (await commands.execute(RESOLVE_TABLE_COMMAND_ID)) as ResolvedBindingRow[];
  expect(before).toEqual([{ key: "ctrl+s", command: "editor.action.save", layer: "defaults" }]);

  // The exact call `main.ts`'s `onKeybindingsChange` hook makes on every
  // `keybindings.json` reload (`ConfigService`'s real `fs.watch`, Req 9.4)
  // — reproduced directly here rather than through a real filesystem
  // watch, which this test has no need to be sensitive to the timing of.
  keymap.setUserEntries([{ key: "ctrl+k ctrl+s", command: "keybindings.open" }]);

  const after = (await commands.execute(RESOLVE_TABLE_COMMAND_ID)) as ResolvedBindingRow[];
  expect(after).toEqual([
    { key: "ctrl+k ctrl+s", command: "keybindings.open", layer: "user" },
    { key: "ctrl+s", command: "editor.action.save", layer: "defaults" },
  ]);
});
