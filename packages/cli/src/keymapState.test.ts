import { expect, test } from "bun:test";
import { createHostLog } from "@tecode/core";
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
