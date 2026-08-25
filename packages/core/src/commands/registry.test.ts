import { expect, test } from "bun:test";
import type { HostError } from "../host/errors";
import { createHostLog } from "../host/errors";
import { createCommandRegistry } from "./registry";
import { OPEN_FILE_COMMAND_ID } from "../ui/openFileCommand";
import {
  MODAL_ACCEPT_COMMAND,
  MODAL_CLOSE_COMMAND,
  MODAL_SELECT_NEXT_COMMAND,
  MODAL_SELECT_PREVIOUS_COMMAND,
} from "../ui/modalCommands";
import {
  KEYBINDINGS_ENSURE_FILE_COMMAND_ID,
  KEYBINDINGS_RESOLVE_TABLE_COMMAND_ID,
} from "../ui/keybindingsCommands";
import { EXTENSIONS_RELOAD_COMMAND_ID } from "../ui/extensionsReloadCommand";
import {
  TAB_CLOSE_COMMAND,
  TAB_CLOSE_OTHERS_COMMAND,
  TAB_NEXT_COMMAND,
  TAB_PREVIOUS_COMMAND,
} from "../ui/tabCommands";
import { THEME_SELECT_COMMAND_ID } from "../ui/themeSelectCommand";

/** A {@link StatusSink} stub that records every error it receives, for
 * assertions (design.md §5, §14). */
function createRecordingSink() {
  const errors: HostError[] = [];
  return {
    errors,
    sink: {
      error(err: HostError) {
        errors.push(err);
      },
    },
  };
}

test("execute on an unknown command ID resolves undefined, notifies the sink, and does not throw", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  const result = await registry.execute("no.such.command");

  expect(result).toBeUndefined();
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toBe("Command not found: no.such.command");
});

test("execute on a throwing handler resolves undefined, logs the error, and notifies the sink", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.register("editor.action.boom", () => {
    throw new Error("kaboom");
  });

  const result = await registry.execute("editor.action.boom");

  expect(result).toBeUndefined();
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toContain("kaboom");

  const logged = log.entries();
  expect(logged).toHaveLength(1);
  expect(logged[0]?.level).toBe("error");
  expect(logged[0]?.error.message).toContain("kaboom");
});

test("execute on a handler that throws a non-Error value does not itself throw", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.register("editor.action.weird", () => {
    throw "not an Error instance";
  });

  const result = await registry.execute("editor.action.weird");

  expect(result).toBeUndefined();
  expect(errors[0]?.message).toContain("not an Error instance");
});

test("a successful handler resolves the registry's execute to its return value", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.register("math.add", (...args) => {
    const [a, b] = args as [number, number];
    return a + b;
  });

  const result = await registry.execute("math.add", 2, 3);

  expect(result).toBe(5);
  expect(errors).toHaveLength(0);
});

test("an async handler's resolved value is awaited through execute", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.register("workspace.save", async () => {
    await Promise.resolve();
    return "saved";
  });

  const result = await registry.execute("workspace.save");

  expect(result).toBe("saved");
});

test("dispose removes the command, so a subsequent execute reports it unknown", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  const registration = registry.register("editor.action.foo", () => "ok");
  expect(await registry.execute("editor.action.foo")).toBe("ok");

  registration.dispose();

  const result = await registry.execute("editor.action.foo");
  expect(result).toBeUndefined();
  expect(errors.at(-1)?.message).toBe("Command not found: editor.action.foo");
});

test("double-dispose is a no-op", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  const registration = registry.register("editor.action.foo", () => "ok");
  registration.dispose();
  expect(() => registration.dispose()).not.toThrow();

  expect(await registry.execute("editor.action.foo")).toBeUndefined();
});

test("dispose after re-registration under the same ID does not remove the new handler", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  const first = registry.register("editor.action.foo", () => "first");
  const second = registry.register("editor.action.foo", () => "second");

  // The stale handle from the superseded registration must not remove the
  // still-current one (entry-identity comparison, design.md §5).
  first.dispose();
  expect(await registry.execute("editor.action.foo")).toBe("second");

  second.dispose();
  expect(await registry.execute("editor.action.foo")).toBeUndefined();
});

test("re-registering the same ID is last-wins and logs a warning", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.register("editor.action.foo", () => "first");
  registry.register("editor.action.foo", () => "second");

  expect(await registry.execute("editor.action.foo")).toBe("second");

  const warnings = log.entries().filter((e) => e.level === "warning");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.error.message).toContain("editor.action.foo");
});

test("list returns id, title, category, and when for every registered command", () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.register("editor.action.deleteLine", () => undefined, {
    title: "Delete Line",
    category: "Editor",
    when: "editorTextFocus",
  });
  registry.register("explorer.reveal", () => undefined);

  const descriptors = registry.list();
  expect(descriptors).toHaveLength(2);

  const deleteLine = descriptors.find((d) => d.id === "editor.action.deleteLine");
  expect(deleteLine).toEqual({
    id: "editor.action.deleteLine",
    title: "Delete Line",
    category: "Editor",
    when: "editorTextFocus",
  });

  const reveal = descriptors.find((d) => d.id === "explorer.reveal");
  expect(reveal).toEqual({
    id: "explorer.reveal",
    title: undefined,
    category: undefined,
    when: undefined,
  });
});

test("list does not filter by when — that is the caller's responsibility (design.md §5)", () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.register("explorer.reveal", () => undefined, { when: "false" });

  expect(registry.list().map((d) => d.id)).toEqual(["explorer.reveal"]);
});

test("createHostLog accumulates entries in append order and starts empty", () => {
  const log = createHostLog();
  expect(log.entries()).toEqual([]);

  log.append("warning", { message: "first" });
  log.append("error", { message: "second", extensionId: "demo" });

  expect(log.entries()).toEqual([
    { level: "warning", error: { message: "first" } },
    { level: "error", error: { message: "second", extensionId: "demo" } },
  ]);
});

test("execute keeps its never-throwing contract when the sink itself throws", async () => {
  const log = createHostLog();
  const throwingSink = {
    error() {
      throw new Error("sink is broken");
    },
  };
  const registry = createCommandRegistry({ log, sink: throwingSink });

  expect(await registry.execute("no.such.command")).toBeUndefined();

  registry.register("editor.action.boom", () => {
    throw new Error("handler failure");
  });
  expect(await registry.execute("editor.action.boom")).toBeUndefined();
});

test("execute keeps its never-throwing contract when the log itself throws", async () => {
  const throwingLog = {
    append() {
      throw new Error("log is broken");
    },
    entries: () => [],
  };
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log: throwingLog, sink });

  registry.register("editor.action.boom", () => {
    throw new Error("handler failure");
  });
  expect(await registry.execute("editor.action.boom")).toBeUndefined();
  // Re-registration warnings also go through the guarded log path.
  expect(() => registry.register("editor.action.boom", () => "ok")).not.toThrow();
});

test("execute survives an error whose message getter throws", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.register("editor.action.cursed", () => {
    const cursed = new Error("unreachable");
    Object.defineProperty(cursed, "message", {
      get() {
        throw new Error("message getter throws");
      },
    });
    throw cursed;
  });

  expect(await registry.execute("editor.action.cursed")).toBeUndefined();
  expect(errors[0]?.message).toContain("Unknown error");
});

test("register rejects command IDs that are not namespace.verb form", () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  for (const bad of ["save", "editor.", ".save", "editor..save", "editor save.x", ""]) {
    expect(() => registry.register(bad, () => undefined)).toThrow(TypeError);
  }
  // Multi-segment IDs are valid (e.g. editor.action.deleteLine).
  expect(() =>
    registry.register("editor.action.deleteLine", () => undefined),
  ).not.toThrow();
});

test("HostLog.entries returns a snapshot, not the internal records", () => {
  const log = createHostLog();
  log.append("error", { message: "original" });

  const snapshot = log.entries();
  snapshot[0]!.error.message = "mutated";

  expect(log.entries()[0]?.error.message).toBe("original");
});

test("HostLog.append clones the incoming error, isolating later caller mutations", () => {
  const log = createHostLog();
  const err: HostError = { message: "original" };
  log.append("error", err);

  err.message = "mutated by caller";

  expect(log.entries()[0]?.error.message).toBe("original");
});

// --- registerLazy / lazy commands (design.md §4.1, §5) ---------------------

test("registerLazy adds the command to list() with its meta, but no handler runs it yet", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.registerLazy("demo.run", {
    extensionId: "demo.ext",
    meta: { title: "Run Demo", category: "Demo" },
  });

  expect(registry.list()).toEqual([
    { id: "demo.run", title: "Run Demo", category: "Demo", when: undefined },
  ]);
});

test("executing a lazy, not-yet-activated command reports a HostError and does not throw", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.registerLazy("demo.run", { extensionId: "demo.ext" });

  const result = await registry.execute("demo.run", "arg");

  expect(result).toBeUndefined();
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toContain("demo.ext");
  expect(errors[0]?.message.toLowerCase()).toContain("not activated yet");
  expect(errors[0]?.extensionId).toBe("demo.ext");

  const logged = log.entries();
  expect(logged).toHaveLength(1);
  expect(logged[0]?.level).toBe("warning");
});

test("register() over a lazy entry replaces it with a real handler that execute() then runs", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.registerLazy("demo.run", { extensionId: "demo.ext" });
  registry.register("demo.run", () => "activated!");

  expect(await registry.execute("demo.run")).toBe("activated!");
});

test("registerLazy rejects command IDs that are not namespace.verb form", () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  expect(() => registry.registerLazy("save", { extensionId: "demo.ext" })).toThrow(TypeError);
});

test("registerLazy's Disposable removes the command, matching register()'s dispose semantics", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  const registration = registry.registerLazy("demo.run", { extensionId: "demo.ext" });
  registration.dispose();

  const result = await registry.execute("demo.run");
  expect(result).toBeUndefined();
  expect(errors.at(-1)?.message).toBe("Command not found: demo.run");
});

// --- activateExtension hook (design.md §4.2, Task 1.12) --------------------

test("execute() awaits the activateExtension hook and re-dispatches once it resolves the handler", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const activateCalls: string[] = [];
  const registry = createCommandRegistry({
    log,
    sink,
    activateExtension: async (extensionId) => {
      activateCalls.push(extensionId);
      // Simulate the extension host's activate(ctx) replacing the lazy
      // entry with a real handler via ctx.api.commands.register.
      registry.register("demo.run", () => "activated!");
    },
  });
  registry.registerLazy("demo.run", { extensionId: "demo.ext" });

  const result = await registry.execute("demo.run");

  expect(result).toBe("activated!");
  expect(activateCalls).toEqual(["demo.ext"]);
});

test("execute() calls activateExtension only once across repeated executes once the handler resolves", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const activateCalls: string[] = [];
  const registry = createCommandRegistry({
    log,
    sink,
    activateExtension: async (extensionId) => {
      activateCalls.push(extensionId);
      registry.register("demo.run", () => "activated!");
    },
  });
  registry.registerLazy("demo.run", { extensionId: "demo.ext" });

  await registry.execute("demo.run");
  await registry.execute("demo.run");

  expect(activateCalls).toEqual(["demo.ext"]);
});

test("execute() falls back to the not-activated-yet error when activateExtension does not resolve a handler", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const activateCalls: string[] = [];
  const registry = createCommandRegistry({
    log,
    sink,
    activateExtension: async (extensionId) => {
      // The extension "activates" but never registers a real handler for
      // this command (e.g. it failed, or the manifest was wrong).
      activateCalls.push(extensionId);
    },
  });
  registry.registerLazy("demo.run", { extensionId: "demo.ext" });

  const result = await registry.execute("demo.run");

  expect(result).toBeUndefined();
  expect(activateCalls).toEqual(["demo.ext"]);
  expect(errors.at(-1)?.message.toLowerCase()).toContain("not activated yet");
  expect(errors.at(-1)?.extensionId).toBe("demo.ext");
});

test("execute() never calls activateExtension for a command with no extensionId (plain register)", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  let activateCalls = 0;
  const registry = createCommandRegistry({
    log,
    sink,
    activateExtension: async () => {
      activateCalls += 1;
    },
  });
  registry.register("editor.action.foo", () => "ok");

  expect(await registry.execute("editor.action.foo")).toBe("ok");
  expect(activateCalls).toBe(0);
});

test("execute() never calls activateExtension for an unknown command ID", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  let activateCalls = 0;
  const registry = createCommandRegistry({
    log,
    sink,
    activateExtension: async () => {
      activateCalls += 1;
    },
  });

  expect(await registry.execute("no.such.command")).toBeUndefined();
  expect(activateCalls).toBe(0);
});

test("without an activateExtension hook, execute() keeps Task 1.11's not-activated-yet behavior unchanged", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });
  registry.registerLazy("demo.run", { extensionId: "demo.ext" });

  const result = await registry.execute("demo.run");

  expect(result).toBeUndefined();
  expect(errors.at(-1)?.message.toLowerCase()).toContain("not activated yet");
});

test("execute() keeps its never-throwing contract when activateExtension itself throws", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({
    log,
    sink,
    activateExtension: async () => {
      throw new Error("activation exploded");
    },
  });
  registry.registerLazy("demo.run", { extensionId: "demo.ext" });

  const result = await registry.execute("demo.run");

  expect(result).toBeUndefined();
  expect(errors.at(-1)?.extensionId).toBe("demo.ext");
  const logged = log.entries().filter((e) => e.level === "error");
  expect(logged.some((e) => e.error.message.includes("activation exploded"))).toBe(true);
});

test("registerLazy twice for the same ID logs a re-registration warning (last-wins)", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.registerLazy("demo.run", { extensionId: "first.ext" });
  registry.registerLazy("demo.run", { extensionId: "second.ext" });

  const result = await registry.execute("demo.run");
  expect(result).toBeUndefined();

  const warnings = log.entries().filter((e) => e.level === "warning");
  // One for the re-registration, one for the not-activated-yet report.
  expect(warnings.some((w) => w.error.message.includes("re-registered"))).toBe(true);
});

// --- registerCore / reserved ids (Issue #72) --------------------------
//
// Issue #72: pre-fix, `storeEntry` was pure last-wins with no id policy at
// all — any extension could silently take over a core-owned command id via
// either `tecode.commands.register` OR a manifest's `contributes.commands`
// (which reaches `registerLazy` through `host/registration.ts`). These
// tests exercise `registerCore` (the host-internal third registration
// method that both registers AND reserves an id) and the corresponding
// rejection paths on `register`/`registerLazy`.

test("registerCore registers normally, exactly like register()", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.registerCore("core.action.foo", () => "core-handler");

  expect(await registry.execute("core.action.foo")).toBe("core-handler");
  expect(registry.list().map((d) => d.id)).toEqual(["core.action.foo"]);
});

test("registerCore rejects command IDs that are not namespace.verb form, like register()", () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  expect(() => registry.registerCore("save", () => undefined)).toThrow(TypeError);
});

test("register() on an id reserved by registerCore is rejected: the core handler still runs, an error is logged, the sink is notified, and the returned Disposable is a no-op", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.registerCore("core.action.foo", () => "core-handler");
  const rejected = registry.register("core.action.foo", () => "extension-handler");

  // The core handler ran, not the extension's rejected one.
  expect(await registry.execute("core.action.foo")).toBe("core-handler");

  const logErrors = log.entries().filter((e) => e.level === "error");
  expect(logErrors.some((w) => w.error.message.includes("core.action.foo"))).toBe(true);
  expect(errors.some((e) => e.message.includes("core.action.foo"))).toBe(true);

  // A real, no-op Disposable — never throws, and disposing it removes
  // nothing (the core registration is untouched).
  expect(() => rejected.dispose()).not.toThrow();
  expect(await registry.execute("core.action.foo")).toBe("core-handler");
});

test("registerLazy() on an id reserved by registerCore is rejected the same way, attributing the extensionId on the reported HostError", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.registerCore("core.action.foo", () => "core-handler");
  const rejected = registry.registerLazy("core.action.foo", { extensionId: "sneaky.ext" });

  expect(await registry.execute("core.action.foo")).toBe("core-handler");

  expect(errors.at(-1)?.extensionId).toBe("sneaky.ext");
  expect(errors.at(-1)?.message).toContain("core.action.foo");

  const logErrors = log.entries().filter((e) => e.level === "error");
  expect(logErrors.some((w) => w.error.extensionId === "sneaky.ext")).toBe(true);

  expect(() => rejected.dispose()).not.toThrow();
  expect(await registry.execute("core.action.foo")).toBe("core-handler");
});

test("registerCore twice under the same id is last-wins with a re-registration warning, exactly like register()", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.registerCore("core.action.foo", () => "first");
  registry.registerCore("core.action.foo", () => "second");

  expect(await registry.execute("core.action.foo")).toBe("second");

  const warnings = log.entries().filter((e) => e.level === "warning");
  expect(warnings.some((w) => w.error.message.includes("re-registered"))).toBe(true);
});

test("a non-reserved id is unaffected by the reserved-id check: register() re-registration still last-wins with no rejection reported", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.register("editor.action.foo", () => "first");
  registry.register("editor.action.foo", () => "second");

  expect(await registry.execute("editor.action.foo")).toBe("second");
  // No "reserved" rejection was ever reported — this is ordinary
  // last-wins, ungated.
  expect(errors.some((e) => e.message.toLowerCase().includes("reserved"))).toBe(false);
});

test("a non-reserved id is unaffected by the reserved-id check: registerLazy() re-registration still last-wins with no rejection reported", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  registry.registerLazy("demo.run", { extensionId: "first.ext" });
  registry.registerLazy("demo.run", { extensionId: "second.ext" });

  const result = await registry.execute("demo.run");
  expect(result).toBeUndefined(); // still lazy, not-activated-yet — unrelated to reservation.
  expect(errors.some((e) => e.message.toLowerCase().includes("reserved"))).toBe(false);
});

test("disposing the core registration clears the reservation, so the id can be registered normally afterward", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  const core = registry.registerCore("core.action.foo", () => "core-handler");
  core.dispose();

  // Unreserved AND unregistered now — an ordinary register() succeeds and
  // its handler actually runs, not rejected.
  registry.register("core.action.foo", () => "extension-handler");
  expect(await registry.execute("core.action.foo")).toBe("extension-handler");
});

test("a stale registerCore Disposable from a superseded core registration clears neither the entry nor the reservation", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  const first = registry.registerCore("core.action.foo", () => "first");
  registry.registerCore("core.action.foo", () => "second"); // supersedes `first`.

  first.dispose(); // stale — must be a no-op, matching register()'s own entry-identity guard.

  expect(await registry.execute("core.action.foo")).toBe("second");

  // Still reserved: an extension registration is still rejected.
  registry.register("core.action.foo", () => "extension-handler");
  expect(await registry.execute("core.action.foo")).toBe("second");
  expect(errors.some((e) => e.message.includes("core.action.foo"))).toBe(true);
});

test("double-dispose of a registerCore registration is a no-op, matching register()'s dispose semantics", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const registry = createCommandRegistry({ log, sink });

  const core = registry.registerCore("core.action.foo", () => "ok");
  core.dispose();
  expect(() => core.dispose()).not.toThrow();

  expect(await registry.execute("core.action.foo")).toBeUndefined();
  // Still cleared exactly once — registrable again afterward.
  registry.register("core.action.foo", () => "extension-handler");
  expect(await registry.execute("core.action.foo")).toBe("extension-handler");
});

// --- every core-owned command id is actually reserved (Issue #72) -----
//
// Table-driven over the 13 ids the 6 `ui/*Command.ts` registrar modules
// register via `registerCore` (openFileCommand.ts: 1, modalCommands.ts: 4,
// keybindingsCommands.ts: 2, extensionsReloadCommand.ts: 1, tabCommands.ts:
// 4, themeSelectCommand.ts: 1). The list below is built from each module's
// own exported `*_COMMAND_ID` constant, not retyped strings, so it cannot
// silently drift out of sync with the real registrar modules if one is
// renamed or a new command is added.
const RESERVED_CORE_COMMAND_IDS: readonly string[] = [
  OPEN_FILE_COMMAND_ID,
  MODAL_SELECT_NEXT_COMMAND,
  MODAL_SELECT_PREVIOUS_COMMAND,
  MODAL_ACCEPT_COMMAND,
  MODAL_CLOSE_COMMAND,
  KEYBINDINGS_ENSURE_FILE_COMMAND_ID,
  KEYBINDINGS_RESOLVE_TABLE_COMMAND_ID,
  EXTENSIONS_RELOAD_COMMAND_ID,
  TAB_NEXT_COMMAND,
  TAB_PREVIOUS_COMMAND,
  TAB_CLOSE_COMMAND,
  TAB_CLOSE_OTHERS_COMMAND,
  THEME_SELECT_COMMAND_ID,
];

test("RESERVED_CORE_COMMAND_IDS covers every id the 6 registrar modules actually export (sanity guard on the table itself)", () => {
  expect(RESERVED_CORE_COMMAND_IDS).toHaveLength(13);
  // Every id follows the namespace.verb convention every other command id
  // in this codebase does.
  for (const id of RESERVED_CORE_COMMAND_IDS) {
    expect(id).toMatch(/^[^\s.]+(\.[^\s.]+)+$/);
  }
  // No duplicates — each module owns a distinct id.
  expect(new Set(RESERVED_CORE_COMMAND_IDS).size).toBe(RESERVED_CORE_COMMAND_IDS.length);
});

for (const id of RESERVED_CORE_COMMAND_IDS) {
  test(`"${id}": registerCore reserves it, so both register() and registerLazy() from an extension are rejected and the core handler still runs`, async () => {
    const log = createHostLog();
    const { errors, sink } = createRecordingSink();
    const registry = createCommandRegistry({ log, sink });

    registry.registerCore(id, () => "core-handler");

    const viaRegister = registry.register(id, () => "extension-handler-a");
    expect(await registry.execute(id)).toBe("core-handler");

    const viaLazy = registry.registerLazy(id, { extensionId: "sneaky.ext" });
    expect(await registry.execute(id)).toBe("core-handler");

    // Both rejections reported through log + sink, never thrown.
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const logErrors = log.entries().filter((e) => e.level === "error");
    expect(logErrors.filter((w) => w.error.message.includes(id)).length).toBeGreaterThanOrEqual(2);

    // Both returned Disposables are harmless no-ops.
    expect(() => viaRegister.dispose()).not.toThrow();
    expect(() => viaLazy.dispose()).not.toThrow();
    expect(await registry.execute(id)).toBe("core-handler");
  });
}
