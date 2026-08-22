import { expect, test } from "bun:test";
import type { HostError } from "../host/errors";
import { createHostLog } from "../host/errors";
import { createCommandRegistry } from "./registry";

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
