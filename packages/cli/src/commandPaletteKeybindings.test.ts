/**
 * Proves `command-palette`'s two default keybindings resolve to two
 * DISTINCT commands in the real, layered {@link BindingTable} (Task 3.2,
 * Req 11.3) — `ctrl+shift+p` -> `workbench.action.showCommands` and
 * `ctrl+p` -> `workbench.action.quickOpen`, never confused for one another
 * AT THE TABLE LEVEL.
 *
 * This is deliberately narrower than "these two physical keystrokes always
 * produce different commands on every terminal" — `command-palette/
 * manifest.ts`'s own TSDoc documents at length why a non-Kitty-capable
 * terminal cannot always tell a physical Ctrl+Shift+P from a physical
 * Ctrl+P apart (the same `ctrl+shift+<letter>` hazard `editor-core/
 * manifest.ts`'s TSDoc covers for `ctrl+shift+d`/`ctrl+shift+k`/
 * `ctrl+shift+z`) — that ambiguity lives in `@opentui/core`'s raw key
 * PARSING, one layer below `BindingTable.lookup`, and is out of scope for
 * a table-level test to fix or hide. What this test DOES prove: once a
 * stroke has been correctly identified as `"ctrl+shift+p"` (e.g. on a
 * Kitty-capable terminal, or a directly-constructed `KeyEventLike` the way
 * `keyRouting.test.ts`'s own suite already exercises other manifests'
 * bindings), the table resolves it to the palette, never to quick-open —
 * i.e. the two keybindings are genuinely two separate table entries, not
 * accidentally normalized onto the same canonical key string.
 */

import { describe, expect, test } from "bun:test";
import {
  createBindingTable,
  createContextService,
  createHostLog,
  normalizeKey,
  type KeymapLayers,
} from "@tecode/core";
import commandPaletteManifest, {
  QUICK_OPEN_COMMAND_ID,
  SHOW_COMMANDS_COMMAND_ID,
} from "@tecode/builtin/command-palette/manifest";

describe("command-palette's default keybindings (Task 3.2, Req 11.3)", () => {
  test("ctrl+shift+p and ctrl+p normalize to two distinct canonical keys", () => {
    // The table-level precondition for the two bindings ever being
    // resolvable independently at all: they must not collapse onto the
    // same lookup key the way, say, "Ctrl+P" and "ctrl + p" would.
    expect(normalizeKey("ctrl+shift+p")).toBe("ctrl+shift+p");
    expect(normalizeKey("ctrl+p")).toBe("ctrl+p");
    expect(normalizeKey("ctrl+shift+p")).not.toBe(normalizeKey("ctrl+p"));
  });

  test("ctrl+shift+p resolves to workbench.action.showCommands, ctrl+p resolves to workbench.action.quickOpen", () => {
    const log = createHostLog();
    const context = createContextService();

    const layers: KeymapLayers = {
      defaults: [],
      fallback: [],
      extension: commandPaletteManifest.contributes.keybindings ?? [],
      preset: [],
      user: [],
    };
    const table = createBindingTable(layers, { log });

    const showCommands = table.lookup("ctrl+shift+p", (key) => context.get(key));
    const quickOpen = table.lookup("ctrl+p", (key) => context.get(key));

    expect(showCommands?.command).toBe(SHOW_COMMANDS_COMMAND_ID);
    expect(quickOpen?.command).toBe(QUICK_OPEN_COMMAND_ID);
    expect(showCommands?.command).not.toBe(quickOpen?.command);

    // Neither binding is gated by a `when` clause (manifest.ts's TSDoc:
    // "both are meant to work from anywhere") — both resolve with an
    // entirely empty context, not just a specially-set-up one.
    expect(showCommands).toBeDefined();
    expect(quickOpen).toBeDefined();
  });

  test("no log warnings are produced building the table from these two bindings (both keys/clauses are well-formed)", () => {
    const log = createHostLog();
    const layers: KeymapLayers = {
      defaults: [],
      fallback: [],
      extension: commandPaletteManifest.contributes.keybindings ?? [],
      preset: [],
      user: [],
    };
    createBindingTable(layers, { log });
    expect(log.entries()).toEqual([]);
  });
});
