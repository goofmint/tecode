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

test("later setUserEntries calls fully replace the previous user layer", () => {
  const log = createHostLog();
  const state = createKeymapState(log);
  state.setUserEntries([{ key: "ctrl+s", command: "workspace.save" }]);
  state.setUserEntries([{ key: "ctrl+w", command: "workspace.close" }]);

  expect(state.getTable().lookup("ctrl+s", () => undefined)).toBeUndefined();
  expect(state.getTable().lookup("ctrl+w", () => undefined)?.command).toBe("workspace.close");
});
