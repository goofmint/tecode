/**
 * Proves `explorer`'s two Issue #121 indent-width keybindings (`]`/`[`,
 * `when: "explorerFocus"`) resolve correctly against the REAL, fully
 * layered {@link BindingTable} `main.ts` actually builds — not just the
 * two entries in isolation — and specifically that they do NOT collide
 * with `@tecode/core`'s `sidebarWidthCommands.ts`'s `ctrl+k [`/`ctrl+k ]`
 * (the key `explorer/manifest.ts`'s own TSDoc explains why this package
 * deliberately avoided) or with `editor-core/manifest.ts`'s own plain `[`/
 * `]` bindings (same two characters, a different `when` scope). Mirrors
 * `commandPaletteKeybindings.test.ts`'s "prove it against the real,
 * layered table" shape, but composes ALL FOUR layers `main.ts` actually
 * feeds `createBindingTable` (`defaults`/`fallback`/`extension`/`user`),
 * matching `fallbackKeybindingsCompleteness.test.ts`'s own `ALL_NON_
 * FALLBACK_KEYBINDINGS` composition, since a same-key, different-`when`
 * collision like this one can only be judged correctly against the WHOLE
 * layered set, not `explorer`'s manifest in isolation.
 */

import { describe, expect, test } from "bun:test";
import {
  BUNDLED_FALLBACK_KEYBINDINGS,
  createBindingTable,
  createContextService,
  createHostLog,
  MODAL_DEFAULT_KEYBINDINGS,
  PANEL_HEIGHT_DEFAULT_KEYBINDINGS,
  SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS,
  TAB_DEFAULT_KEYBINDINGS,
  type KeymapLayers,
} from "@tecode/core";
import { builtinManifests } from "@tecode/builtin";
import {
  EXPLORER_DECREASE_INDENT_WIDTH_COMMAND_ID,
  EXPLORER_INCREASE_INDENT_WIDTH_COMMAND_ID,
} from "@tecode/builtin/explorer/manifest";

/** The real four-layer composition `main.ts` feeds `createBindingTable`
 * (this module's TSDoc) — `defaults` mirrors `main.ts`'s own
 * `...MODAL_DEFAULT_KEYBINDINGS, ...TAB_DEFAULT_KEYBINDINGS, ...
 * SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS, ...PANEL_HEIGHT_DEFAULT_KEYBINDINGS`
 * exactly (the `SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS` inclusion is what makes
 * this test meaningful: it is the layer `explorer/manifest.ts`'s own TSDoc
 * says these two new bindings must not collide with), `extension` mirrors
 * every built-in manifest's `contributes.keybindings` flattened together
 * (so `editor-core`'s own plain `[`/`]` bindings are present too), and
 * `fallback` is the real bundled fallback keymap — `user` stays empty (no
 * test in this suite needs a user override layer). */
function buildRealTable() {
  const layers: KeymapLayers = {
    defaults: [
      ...MODAL_DEFAULT_KEYBINDINGS,
      ...TAB_DEFAULT_KEYBINDINGS,
      ...SIDEBAR_WIDTH_DEFAULT_KEYBINDINGS,
      ...PANEL_HEIGHT_DEFAULT_KEYBINDINGS,
    ],
    fallback: BUNDLED_FALLBACK_KEYBINDINGS,
    extension: builtinManifests.flatMap((manifest) => manifest.contributes.keybindings ?? []),
    user: [],
  };
  const log = createHostLog();
  const table = createBindingTable(layers, { log });
  return { table, log };
}

describe("explorer's ]/[ indent-width keybindings (Issue #121)", () => {
  test("] resolves to explorer.increaseIndentWidth and [ to explorer.decreaseIndentWidth while explorerFocus is true", () => {
    const { table } = buildRealTable();
    const context = createContextService();
    context.set("explorerFocus", true);
    const get = (key: string) => context.get(key);

    expect(table.lookup("]", get)?.command).toBe(EXPLORER_INCREASE_INDENT_WIDTH_COMMAND_ID);
    expect(table.lookup("[", get)?.command).toBe(EXPLORER_DECREASE_INDENT_WIDTH_COMMAND_ID);
  });

  test("] and [ resolve to NOTHING when explorerFocus is false (correctly when-scoped, not global)", () => {
    const { table } = buildRealTable();
    const context = createContextService();
    const get = (key: string) => context.get(key);

    expect(table.lookup("]", get)).toBeUndefined();
    expect(table.lookup("[", get)).toBeUndefined();
  });

  test("does NOT collide with editor-core's own plain [/] bindings (editor.action.typeOpenBracket/typeCloseBracket) — same key, mutually exclusive when scopes", () => {
    const { table } = buildRealTable();
    const context = createContextService();
    context.set("editorTextFocus", true);
    const get = (key: string) => context.get(key);

    expect(table.lookup("]", get)?.command).toBe("editor.action.typeCloseBracket");
    expect(table.lookup("[", get)?.command).toBe("editor.action.typeOpenBracket");
    // Never explorer's commands under this context — the two `when`
    // scopes never overlap, but this pins it directly rather than only by
    // implication.
    expect(table.lookup("]", get)?.command).not.toBe(EXPLORER_INCREASE_INDENT_WIDTH_COMMAND_ID);
    expect(table.lookup("[", get)?.command).not.toBe(EXPLORER_DECREASE_INDENT_WIDTH_COMMAND_ID);
  });

  test("does NOT collide with @tecode/core's sidebarWidthCommands.ts's ctrl+k [ / ctrl+k ] — a different key entirely, both still resolve to sidebar width under explorerFocus", () => {
    const { table } = buildRealTable();
    const context = createContextService();
    context.set("explorerFocus", true);
    const get = (key: string) => context.get(key);

    // `ctrl+k` is still a live chord prefix under explorerFocus (the
    // sidebar-width chord is untouched by this issue)...
    expect(table.hasSequencePrefix("ctrl+k", get)).toBe(true);
    // ...and completing it still reaches the sidebar-width commands, not
    // explorer's indent-width ones — the two features never fight over the
    // same key string.
    expect(table.lookup("ctrl+k [", get)?.command).toBe("workbench.action.decreaseSidebarWidth");
    expect(table.lookup("ctrl+k ]", get)?.command).toBe("workbench.action.increaseSidebarWidth");
  });

  test("building the real, fully-layered table produces no log warnings (both new bindings are well-formed and non-colliding at the table level)", () => {
    const { log } = buildRealTable();
    expect(log.entries()).toEqual([]);
  });
});
