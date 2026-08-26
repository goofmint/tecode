import { expect, test } from "bun:test";
import { createHostLog, TAB_CLOSE_COMMAND, TAB_DEFAULT_KEYBINDINGS } from "@tecode/core";
import { createKeymapState } from "./keymapState";

test("starts with an empty table (no defaults/fallback/extension/user layers yet)", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  expect(state.getTable().entries().size).toBe(0);
  expect(state.getTable().lookup("ctrl+s", () => undefined)).toBeUndefined();
});

test("setUserEntries rebuilds the table with the user layer", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setUserEntries([{ key: "ctrl+s", command: "workspace.save" }]);

  const resolved = state.getTable().lookup("ctrl+s", () => undefined);
  expect(resolved?.command).toBe("workspace.save");
  expect(resolved?.layer).toBe("user");
});

test("setExtensionEntries rebuilds the table with the extension layer", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setExtensionEntries([{ key: "ctrl+alt+t", command: "fixture.hello" }]);

  const resolved = state.getTable().lookup("ctrl+alt+t", () => undefined);
  expect(resolved?.command).toBe("fixture.hello");
  expect(resolved?.layer).toBe("extension");
});

test("user entries outrank extension entries on the same key (design.md §6.2 precedence)", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setExtensionEntries([{ key: "ctrl+s", command: "extension.save" }]);
  state.setUserEntries([{ key: "ctrl+s", command: "user.save" }]);

  const resolved = state.getTable().lookup("ctrl+s", () => undefined);
  expect(resolved?.command).toBe("user.save");
  expect(resolved?.layer).toBe("user");
});

test("a malformed raw user entry is skipped rather than thrown", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  expect(() => state.setUserEntries([{ key: 42, command: "bad" }, "not even an object"])).not.toThrow();
  expect(state.getTable().entries().size).toBe(0);
  expect(log.entries().some((e) => e.level === "warning")).toBe(true);
});

test("a defaults layer, when given, is present from the very first getTable() call and outranks nothing (lowest precedence)", () => {
  const log = createHostLog();
  const state = createKeymapState(log, [{ key: "escape", command: "modal.close", when: "quickPickFocus" }]);

  const resolved = state.getTable().lookup("escape", (key) => key === "quickPickFocus");
  expect(resolved?.command).toBe("modal.close");
  expect(resolved?.layer).toBe("defaults");
});

test("user entries outrank a defaults-layer binding on the same key", () => {
  const log = createHostLog();
  const state = createKeymapState(log, [{ key: "ctrl+s", command: "modal.accept" }]);
  state.setUserEntries([{ key: "ctrl+s", command: "user.save" }]);

  const resolved = state.getTable().lookup("ctrl+s", () => undefined);
  expect(resolved?.command).toBe("user.save");
  expect(resolved?.layer).toBe("user");
});

test("later setUserEntries calls fully replace the previous user layer", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setUserEntries([{ key: "ctrl+s", command: "workspace.save" }]);
  state.setUserEntries([{ key: "ctrl+w", command: "workspace.close" }]);

  expect(state.getTable().lookup("ctrl+s", () => undefined)).toBeUndefined();
  expect(state.getTable().lookup("ctrl+w", () => undefined)?.command).toBe("workspace.close");
});

test("setFallbackEntries rebuilds the table with the fallback layer (Req 4.7)", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setFallbackEntries([{ key: "ctrl+g", command: "workbench.action.showCommands" }]);

  const resolved = state.getTable().lookup("ctrl+g", () => undefined);
  expect(resolved?.command).toBe("workbench.action.showCommands");
  expect(resolved?.layer).toBe("fallback");
});

test("fallback entries outrank a defaults-layer binding on the same key", () => {
  const log = createHostLog();
  const state = createKeymapState(log, [{ key: "ctrl+e", command: "defaults.command" }]);
  state.setFallbackEntries([{ key: "ctrl+e", command: "explorer.focus" }]);

  const resolved = state.getTable().lookup("ctrl+e", () => undefined);
  expect(resolved?.command).toBe("explorer.focus");
  expect(resolved?.layer).toBe("fallback");
});

test("an extension entry outranks a fallback entry on the same key (design.md §6.2 precedence)", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setFallbackEntries([{ key: "ctrl+g", command: "fallback.command" }]);
  state.setExtensionEntries([{ key: "ctrl+g", command: "extension.command" }]);

  const resolved = state.getTable().lookup("ctrl+g", () => undefined);
  expect(resolved?.command).toBe("extension.command");
  expect(resolved?.layer).toBe("extension");
});

test("a user entry outranks a fallback entry on the same key — user bindings always win (Req 4.7)", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setFallbackEntries([{ key: "ctrl+g", command: "fallback.command" }]);
  state.setUserEntries([{ key: "ctrl+g", command: "user.command" }]);

  const resolved = state.getTable().lookup("ctrl+g", () => undefined);
  expect(resolved?.command).toBe("user.command");
  expect(resolved?.layer).toBe("user");
});

test("later setFallbackEntries calls fully replace the previous fallback layer", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setFallbackEntries([{ key: "ctrl+g", command: "one" }]);
  state.setFallbackEntries([{ key: "ctrl+l", command: "two" }]);

  expect(state.getTable().lookup("ctrl+g", () => undefined)).toBeUndefined();
  expect(state.getTable().lookup("ctrl+l", () => undefined)?.command).toBe("two");
});

// --- Issue #72: reserving a command id against extension override is a
// `CommandRegistry` (`commands/registry.ts`) concept, entirely separate
// from the keymap/`BindingTable` layer here — a user must still be able to
// rebind a core-reserved command (like tab.close) to a different key.
// `BindingTable`/`KeymapState` never consult `CommandRegistry` at all
// (`command` is just an opaque string to them, `bindingTable.ts`'s own
// TSDoc), so no change was needed here for Issue #72 — this test proves
// that directly with the real reserved id and its real default binding,
// rather than leaving it an unverified assumption.
test("a user keybindings.json entry still rebinds tab.close (a core-reserved command, Issue #72) to a different key", () => {
  const log = createHostLog();
  const state = createKeymapState(log, TAB_DEFAULT_KEYBINDINGS);

  // tab.close's real shipped default (ui/tabCommands.ts's TAB_DEFAULT_KEYBINDINGS).
  expect(state.getTable().lookup("ctrl+w", () => undefined)?.command).toBe(TAB_CLOSE_COMMAND);

  // The user layer removes the default binding and rebinds the SAME
  // command id to a brand-new key — exactly the "-command" + new-entry
  // pattern keybindingsCommands.ts's KEYBINDINGS_TEMPLATE documents for
  // users.
  state.setUserEntries([
    { key: "ctrl+w", command: `-${TAB_CLOSE_COMMAND}` },
    { key: "ctrl+alt+w", command: TAB_CLOSE_COMMAND },
  ]);

  // Old key no longer resolves tab.close at all.
  expect(state.getTable().lookup("ctrl+w", () => undefined)).toBeUndefined();
  // New key resolves tab.close, from the user layer — the reservation on
  // `CommandRegistry` (which only governs who may call `register`/
  // `registerLazy` for the id) has no bearing on this at all.
  const resolved = state.getTable().lookup("ctrl+alt+w", () => undefined);
  expect(resolved?.command).toBe(TAB_CLOSE_COMMAND);
  expect(resolved?.layer).toBe("user");
});

// --- Issue #81 Phase 2: the `preset` layer (Req 12.2, design.md §6.6).
// `preset` sits ABOVE `extension`, deliberately (`@tecode/core`'s
// `bindingTable.ts`'s `KeymapLayers` TSDoc spells out why) — the tests
// below prove that ordering directly, not just that the layer exists.

test("setPresetEntries rebuilds the table with the preset layer (Req 12.2)", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setPresetEntries([{ key: "ctrl+e", command: "editor.action.cursorEnd" }]);

  const resolved = state.getTable().lookup("ctrl+e", () => undefined);
  expect(resolved?.command).toBe("editor.action.cursorEnd");
  expect(resolved?.layer).toBe("preset");
});

test("a preset entry outranks a defaults-layer binding on the same key", () => {
  const log = createHostLog();
  const state = createKeymapState(log, [{ key: "ctrl+k", command: "defaults.command" }]);
  state.setPresetEntries([{ key: "ctrl+k", command: "editor.action.deleteLine" }]);

  const resolved = state.getTable().lookup("ctrl+k", () => undefined);
  expect(resolved?.command).toBe("editor.action.deleteLine");
  expect(resolved?.layer).toBe("preset");
});

test("a preset entry outranks an EXTENSION entry on the same key — the whole point of a bundled preset (Req 12.2)", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setExtensionEntries([{ key: "ctrl+f", command: "editor.action.find" }]);
  state.setPresetEntries([{ key: "ctrl+f", command: "editor.action.cursorRight" }]);

  const resolved = state.getTable().lookup("ctrl+f", () => undefined);
  expect(resolved?.command).toBe("editor.action.cursorRight");
  expect(resolved?.layer).toBe("preset");
});

test("a user entry outranks a preset entry on the same key — user bindings always win (Req 12.2)", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setPresetEntries([{ key: "ctrl+f", command: "editor.action.cursorRight" }]);
  state.setUserEntries([{ key: "ctrl+f", command: "user.command" }]);

  const resolved = state.getTable().lookup("ctrl+f", () => undefined);
  expect(resolved?.command).toBe("user.command");
  expect(resolved?.layer).toBe("user");
});

test("later setPresetEntries calls fully replace the previous preset layer", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setPresetEntries([{ key: "ctrl+e", command: "emacs.one" }]);
  state.setPresetEntries([{ key: "ctrl+a", command: "emacs.two" }]);

  expect(state.getTable().lookup("ctrl+e", () => undefined)).toBeUndefined();
  expect(state.getTable().lookup("ctrl+a", () => undefined)?.command).toBe("emacs.two");
});
