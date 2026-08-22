import { expect, test } from "bun:test";
import type { ExtensionContext, Manifest, Tecode } from "@tecode/api";
import { createCommandRegistry } from "../commands/registry";
import { createExtensionHost, type ExtensionRecord } from "./activation";
import { createHostLog, type HostError } from "./errors";

/** A `StatusSink` stub that records every error it receives (matches
 * `commands/registry.test.ts`'s/`host/registration.test.ts`'s
 * `createRecordingSink`). */
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

function fixtureManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: "demo.ext",
    version: "1.0.0",
    apiVersion: "1.0",
    activationEvents: ["onStartup"],
    contributes: {},
    ...overrides,
  };
}

/** Builds an `ExtensionRecord` whose `loadModule()` resolves to `mod`
 * (an in-memory fixture — no real files, no dynamic imports). */
function fixtureRecord(
  id: string,
  manifest: Partial<Manifest>,
  mod: unknown,
  loadModule?: () => Promise<unknown>,
): ExtensionRecord {
  return {
    id,
    manifest: fixtureManifest({ id, ...manifest }),
    extensionUri: `/extensions/${id}`,
    storagePath: `/storage/${id}`,
    loadModule: loadModule ?? (() => Promise.resolve(mod)),
  };
}

/** A minimal `Tecode` whose `commands` namespace is the real registry under
 * test (so a fixture's `activate(ctx)` can call `ctx.api.commands.register`
 * and actually replace a lazy command) — every other namespace is unused by
 * these tests and stubbed out via a type assertion. */
function fixtureApi(commands: ReturnType<typeof createCommandRegistry>): Tecode {
  return { commands } as unknown as Tecode;
}

// --- activateExtension: exactly-once, per event -----------------------------

test("onStartup activates a matching extension exactly once, even across repeated calls", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  let activateCalls = 0;
  const record = fixtureRecord("demo.ext", { activationEvents: ["onStartup"] }, {
    activate() {
      activateCalls += 1;
    },
  });
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await host.activateStartupExtensions();
  await host.activateStartupExtensions();

  expect(activateCalls).toBe(1);
  expect(host.getState("demo.ext")).toBe("active");
});

test("activateExtension is a no-op for an unknown extension ID", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const host = createExtensionHost({ extensions: [], api: fixtureApi(commands), log, sink });

  await expect(host.activateExtension("no.such.ext")).resolves.toBeUndefined();
  expect(host.getState("no.such.ext")).toBeUndefined();
});

test("a missing activate export still marks the extension active", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const record = fixtureRecord("demo.ext", {}, {});
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await host.activateExtension("demo.ext");

  expect(host.getState("demo.ext")).toBe("active");
});

test("concurrent activateExtension calls for the same extension share one in-flight activation", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  let activateCalls = 0;
  const record = fixtureRecord("demo.ext", {}, {
    async activate() {
      activateCalls += 1;
      await Promise.resolve();
    },
  });
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await Promise.all([host.activateExtension("demo.ext"), host.activateExtension("demo.ext")]);

  expect(activateCalls).toBe(1);
});

// --- onCommand, via registry.execute() re-dispatch --------------------------

test("registry.execute() on a lazy command activates its owning extension, then runs the real handler", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  let activateCalls = 0;
  const commands = createCommandRegistry({
    log,
    sink,
    activateExtension: (id) => host.activateExtension(id),
  });
  const record = fixtureRecord("demo.ext", { activationEvents: ["onCommand:demo.run"] }, {
    activate(ctx: ExtensionContext) {
      activateCalls += 1;
      ctx.api.commands.register("demo.run", () => "activated!");
    },
  });
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });
  commands.registerLazy("demo.run", { extensionId: "demo.ext" });

  const first = await commands.execute("demo.run");
  const second = await commands.execute("demo.run");

  expect(first).toBe("activated!");
  expect(second).toBe("activated!");
  expect(activateCalls).toBe(1);
  expect(host.getState("demo.ext")).toBe("active");
});

test("onLanguage activates every extension declaring that language, exactly once", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  let tsActivations = 0;
  let jsActivations = 0;
  const ts = fixtureRecord("lang.ts", { activationEvents: ["onLanguage:typescript"] }, {
    activate() {
      tsActivations += 1;
    },
  });
  const js = fixtureRecord("lang.js", { activationEvents: ["onLanguage:javascript"] }, {
    activate() {
      jsActivations += 1;
    },
  });
  const host = createExtensionHost({ extensions: [ts, js], api: fixtureApi(commands), log, sink });

  host.onLanguage("typescript");
  // onLanguage is fire-and-forget (synchronous, matches DocumentManagerDeps'
  // onLanguageActivation shape) — join the same in-flight activation via
  // activateExtension instead of guessing a microtask count, so the wait
  // stays deterministic however many awaits performActivation grows.
  await host.activateExtension("lang.ts");

  expect(tsActivations).toBe(1);
  expect(jsActivations).toBe(0);
  expect(host.getState("lang.ts")).toBe("active");
  expect(host.getState("lang.js")).toBe("registered");

  host.onLanguage("typescript");
  await host.activateExtension("lang.ts");

  expect(tsActivations).toBe(1);
});

test("onLanguage is a plain synchronous void function", () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const host = createExtensionHost({ extensions: [], api: fixtureApi(commands), log, sink });

  // No await, no .then — matches DocumentManagerDeps.onLanguageActivation's
  // `(languageId: string) => void` shape exactly.
  const result: void = host.onLanguage("typescript");
  expect(result).toBeUndefined();
});

// --- subscriptions and deactivate --------------------------------------------

test("deactivateExtension disposes subscriptions in reverse push order, then calls deactivate()", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const order: string[] = [];
  const record = fixtureRecord("demo.ext", {}, {
    activate(ctx: ExtensionContext) {
      ctx.subscriptions.push({ dispose: () => order.push("sub-1") });
      ctx.subscriptions.push({ dispose: () => order.push("sub-2") });
      ctx.subscriptions.push({ dispose: () => order.push("sub-3") });
    },
    deactivate() {
      order.push("deactivate");
    },
  });
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await host.activateExtension("demo.ext");
  await host.deactivateExtension("demo.ext");

  expect(order).toEqual(["sub-3", "sub-2", "sub-1", "deactivate"]);
  expect(host.getState("demo.ext")).toBe("registered");
});

test("deactivateExtension is a no-op for an extension that is not active", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const record = fixtureRecord("demo.ext", {}, {});
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await expect(host.deactivateExtension("demo.ext")).resolves.toBeUndefined();
  expect(host.getState("demo.ext")).toBe("registered");

  await expect(host.deactivateExtension("no.such.ext")).resolves.toBeUndefined();
});

test("a subscription that throws on dispose is logged, and the remaining subscriptions still dispose", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const order: string[] = [];
  const record = fixtureRecord("demo.ext", {}, {
    activate(ctx: ExtensionContext) {
      ctx.subscriptions.push({ dispose: () => order.push("sub-1") });
      ctx.subscriptions.push({
        dispose: () => {
          throw new Error("dispose boom");
        },
      });
      ctx.subscriptions.push({ dispose: () => order.push("sub-3") });
    },
  });
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await host.activateExtension("demo.ext");
  await host.deactivateExtension("demo.ext");

  expect(order).toEqual(["sub-3", "sub-1"]);
  const errors = log.entries().filter((e) => e.level === "error");
  expect(errors.some((e) => e.error.message.includes("dispose boom"))).toBe(true);
});

test("disposeAll deactivates every active extension and is idempotent", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const order: string[] = [];
  const a = fixtureRecord("ext.a", {}, {
    deactivate() {
      order.push("a");
    },
  });
  const b = fixtureRecord("ext.b", {}, {
    deactivate() {
      order.push("b");
    },
  });
  const host = createExtensionHost({ extensions: [a, b], api: fixtureApi(commands), log, sink });

  await host.activateExtension("ext.a");
  await host.activateExtension("ext.b");

  await host.disposeAll();
  expect(order.sort()).toEqual(["a", "b"]);
  expect(host.getState("ext.a")).toBe("registered");
  expect(host.getState("ext.b")).toBe("registered");

  // Idempotent: nothing left active, so a second call deactivates nothing.
  await host.disposeAll();
  expect(order.sort()).toEqual(["a", "b"]);
});

test("disposeAll settles an in-flight activation first, so its subscriptions are still disposed", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  let releaseActivate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseActivate = resolve;
  });
  const disposed: string[] = [];
  const slow = fixtureRecord(
    "lang.slow",
    { activationEvents: ["onLanguage:slow"] },
    {
      async activate(ctx: ExtensionContext) {
        ctx.subscriptions.push({
          dispose() {
            disposed.push("slow-sub");
          },
        });
        await gate;
      },
    },
  );
  const host = createExtensionHost({ extensions: [slow], api: fixtureApi(commands), log, sink });

  // Fire-and-forget start, then shut down while activation is still pending.
  host.onLanguage("slow");
  const disposal = host.disposeAll();
  releaseActivate();
  await disposal;

  expect(disposed).toEqual(["slow-sub"]);
  expect(host.getState("lang.slow")).toBe("registered");
});

test("activateExtension after disposeAll started is a no-op, so nothing activates on a shut-down host", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  let releaseActivate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseActivate = resolve;
  });
  let lateActivations = 0;
  const slow = fixtureRecord(
    "lang.slow",
    { activationEvents: ["onLanguage:slow"] },
    {
      async activate() {
        await gate;
      },
    },
  );
  const late = fixtureRecord("lang.late", { activationEvents: ["onLanguage:late"] }, {
    activate() {
      lateActivations += 1;
    },
  });
  const host = createExtensionHost({
    extensions: [slow, late],
    api: fixtureApi(commands),
    log,
    sink,
  });

  host.onLanguage("slow");
  const disposal = host.disposeAll();
  // Fired AFTER shutdown began: must not start a fresh activation that
  // would finish on the disposed host.
  host.onLanguage("late");
  releaseActivate();
  await disposal;
  await host.activateExtension("lang.late");

  expect(lateActivations).toBe(0);
  expect(host.getState("lang.late")).toBe("registered");
});

test("a concurrent external execute() of the same lazy command awaits the shared activation and succeeds", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({
    log,
    sink,
    activateExtension: (extensionId) => host.activateExtension(extensionId),
  });
  let releaseActivate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseActivate = resolve;
  });
  let activations = 0;
  const slowExt = fixtureRecord("slow.ext", { activationEvents: ["onCommand:slow.run"] }, {
    async activate(ctx: ExtensionContext) {
      activations += 1;
      await gate;
      ctx.api.commands.register("slow.run", () => "ready");
    },
  });
  const host = createExtensionHost({ extensions: [slowExt], api: fixtureApi(commands), log, sink });
  commands.registerLazy("slow.run", { extensionId: "slow.ext" });

  // Two independent callers race the same lazy command while its extension
  // is still activating — both must join the one activation and succeed.
  const first = commands.execute("slow.run");
  const second = commands.execute("slow.run");
  releaseActivate();

  expect(await first).toBe("ready");
  expect(await second).toBe("ready");
  expect(activations).toBe(1);
});

test("an extension executing its own lazy command during activate() does not deadlock", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  // The hook closes over `host`, declared below — safe because the hook only
  // runs from execute(), long after the const initializes (the standard
  // registry-before-host wiring order documented in registry.ts).
  const commands = createCommandRegistry({
    log,
    sink,
    activateExtension: (extensionId) => host.activateExtension(extensionId),
  });
  let innerResult: unknown = "not-run";
  const selfCalling = fixtureRecord("self.ext", { activationEvents: ["onCommand:self.run"] }, {
    async activate(ctx: ExtensionContext) {
      // Executes its own still-lazy command BEFORE registering the real
      // handler — without registry.ts's `activating` re-entrancy guard this
      // would await its own in-flight activation promise forever.
      innerResult = await ctx.api.commands.execute("self.run");
      ctx.api.commands.register("self.run", () => "real");
    },
  });
  const host = createExtensionHost({
    extensions: [selfCalling],
    api: fixtureApi(commands),
    log,
    sink,
  });
  commands.registerLazy("self.run", { extensionId: "self.ext" });

  const result = await commands.execute("self.run");

  // The outer call re-dispatches to the real handler after activation; the
  // recursive inner call fell through to the not-activated error path.
  expect(result).toBe("real");
  expect(innerResult).toBeUndefined();
  expect(errors.some((e) => e.message.includes("self.run"))).toBe(true);
  expect(host.getState("self.ext")).toBe("active");
});

// --- failure isolation --------------------------------------------------------

test("a throwing activate marks only that extension failed, reports a HostError, and leaves others unaffected", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  let goodActivated = false;
  const bad = fixtureRecord("bad.ext", { activationEvents: ["onStartup"] }, {
    activate() {
      throw new Error("boom");
    },
  });
  const good = fixtureRecord("good.ext", { activationEvents: ["onStartup"] }, {
    activate() {
      goodActivated = true;
    },
  });
  const host = createExtensionHost({
    extensions: [bad, good],
    api: fixtureApi(commands),
    log,
    sink,
  });

  await host.activateStartupExtensions();

  expect(host.getState("bad.ext")).toBe("failed");
  expect(host.getState("good.ext")).toBe("active");
  expect(goodActivated).toBe(true);
  expect(errors.some((e) => e.extensionId === "bad.ext" && e.message.includes("boom"))).toBe(
    true,
  );
  const logged = log.entries().filter((e) => e.level === "error");
  expect(logged.some((e) => e.error.extensionId === "bad.ext")).toBe(true);
});

test("a rejecting async activate likewise marks the extension failed and reports a HostError", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const record = fixtureRecord("demo.ext", {}, {
    async activate() {
      await Promise.resolve();
      throw new Error("async boom");
    },
  });
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await host.activateExtension("demo.ext");

  expect(host.getState("demo.ext")).toBe("failed");
  expect(errors.some((e) => e.message.includes("async boom"))).toBe(true);
});

test("re-activating a failed extension is a no-op (failed is terminal until an explicit deactivate)", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  let calls = 0;
  const record = fixtureRecord("demo.ext", {}, {
    activate() {
      calls += 1;
      throw new Error("boom");
    },
  });
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await host.activateExtension("demo.ext");
  await host.activateExtension("demo.ext");

  expect(calls).toBe(1);
  expect(host.getState("demo.ext")).toBe("failed");
});

test("a rejected loadModule() marks the extension failed without throwing out of activateExtension", async () => {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const record = fixtureRecord(
    "demo.ext",
    {},
    undefined,
    () => Promise.reject(new Error("load failed")),
  );
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await expect(host.activateExtension("demo.ext")).resolves.toBeUndefined();

  expect(host.getState("demo.ext")).toBe("failed");
  expect(errors.some((e) => e.message.includes("load failed"))).toBe(true);
});

test("subscriptions pushed before a throwing activate are still disposed", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  let disposed = false;
  const record = fixtureRecord("demo.ext", {}, {
    activate(ctx: ExtensionContext) {
      ctx.subscriptions.push({
        dispose: () => {
          disposed = true;
        },
      });
      throw new Error("boom after partial setup");
    },
  });
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await host.activateExtension("demo.ext");

  expect(host.getState("demo.ext")).toBe("failed");
  expect(disposed).toBe(true);
});

// --- never-throw guarantees ---------------------------------------------------

test("a throwing log does not break activateExtension's never-throwing contract", async () => {
  const throwingLog = {
    append() {
      throw new Error("log is broken");
    },
    entries: () => [],
  };
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log: throwingLog, sink });
  const record = fixtureRecord("demo.ext", {}, {
    activate() {
      throw new Error("boom");
    },
  });
  const host = createExtensionHost({
    extensions: [record],
    api: fixtureApi(commands),
    log: throwingLog,
    sink,
  });

  await expect(host.activateExtension("demo.ext")).resolves.toBeUndefined();
  expect(host.getState("demo.ext")).toBe("failed");
});

test("a throwing sink does not break activateExtension's never-throwing contract", async () => {
  const log = createHostLog();
  const throwingSink = {
    error() {
      throw new Error("sink is broken");
    },
  };
  const commands = createCommandRegistry({ log, sink: throwingSink });
  const record = fixtureRecord("demo.ext", {}, {
    activate() {
      throw new Error("boom");
    },
  });
  const host = createExtensionHost({
    extensions: [record],
    api: fixtureApi(commands),
    log,
    sink: throwingSink,
  });

  await expect(host.activateExtension("demo.ext")).resolves.toBeUndefined();
  expect(host.getState("demo.ext")).toBe("failed");
});

test("a throwing deactivate() is logged and does not stop deactivateExtension from completing", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const record = fixtureRecord("demo.ext", {}, {
    deactivate() {
      throw new Error("deactivate boom");
    },
  });
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await host.activateExtension("demo.ext");
  await expect(host.deactivateExtension("demo.ext")).resolves.toBeUndefined();

  expect(host.getState("demo.ext")).toBe("registered");
  const errs = log.entries().filter((e) => e.level === "error");
  expect(errs.some((e) => e.error.message.includes("deactivate boom"))).toBe(true);
});

// --- re-activation after deactivate -------------------------------------------

test("an extension can be activated again after an explicit deactivate", async () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  let activateCalls = 0;
  const record = fixtureRecord("demo.ext", {}, {
    activate() {
      activateCalls += 1;
    },
  });
  const host = createExtensionHost({ extensions: [record], api: fixtureApi(commands), log, sink });

  await host.activateExtension("demo.ext");
  await host.deactivateExtension("demo.ext");
  await host.activateExtension("demo.ext");

  expect(activateCalls).toBe(2);
  expect(host.getState("demo.ext")).toBe("active");
});

test("getState returns undefined for an extension the host was never given", () => {
  const log = createHostLog();
  const { sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const host = createExtensionHost({ extensions: [], api: fixtureApi(commands), log, sink });

  expect(host.getState("mystery.ext")).toBeUndefined();
});
