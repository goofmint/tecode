import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigChangeEvent } from "@tecode/api";
import type { HostError } from "../host/errors";
import { createHostLog } from "../host/errors";
import {
  getUserKeybindingsPath,
  getUserSettingsPath,
  getWorkspaceSettingsPath,
} from "../host/paths";
import { createConfigService, type ConfigServiceFs } from "./service";

/** A `StatusSink` stub that records every error it receives (matches
 * documentManager.test.ts's `createRecordingSink`). */
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

/** An in-memory {@link ConfigServiceFs}: `readFile` serves whatever
 * `setFile` last stored (or ENOENT), and `triggerChange` synchronously
 * invokes every listener registered via `watch` for that path — the
 * "injected fake fs/watcher where the test fires the change callback
 * synchronously" seam the task plan calls for. */
function createFakeFs(initial: Record<string, string> = {}): {
  fs: ConfigServiceFs;
  setFile(path: string, content: string): void;
  deleteFile(path: string): void;
  triggerChange(path: string): void;
  watchedPaths(): string[];
} {
  const files = new Map(Object.entries(initial));
  const watchers = new Map<string, Set<() => void>>();
  return {
    fs: {
      async readFile(path) {
        const content = files.get(path);
        if (content === undefined) {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        }
        return content;
      },
      watch(path, onChange) {
        let set = watchers.get(path);
        if (!set) {
          set = new Set();
          watchers.set(path, set);
        }
        set.add(onChange);
        return {
          close() {
            set?.delete(onChange);
          },
        };
      },
    },
    setFile(path, content) {
      files.set(path, content);
    },
    deleteFile(path) {
      files.delete(path);
    },
    triggerChange(path) {
      const set = watchers.get(path);
      if (set) for (const cb of Array.from(set)) cb();
    },
    watchedPaths() {
      return Array.from(watchers.keys());
    },
  };
}

/** Poll `predicate` until it is true or `timeoutMs` elapses, yielding
 * between checks — used instead of a single fixed sleep so reload chains
 * (fake-fs: microtask-only; real-fs: genuine watch latency) settle
 * reliably without over- or under-waiting. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ConfigService.get — layering (Req 9.2, 9.3)", () => {
  test("workspace overrides user overrides defaults, per key", async () => {
    const userPath = getUserSettingsPath();
    const workspaceRoot = "/fake-workspace";
    const workspacePath = getWorkspaceSettingsPath(workspaceRoot);
    const fake = createFakeFs({
      [userPath]: JSON.stringify({ "editor.tabSize": 2, "editor.wordWrap": "off" }),
      [workspacePath]: JSON.stringify({ "editor.tabSize": 4 }),
    });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, workspaceRoot, fs: fake.fs });
    service.registerConfiguration({
      properties: {
        "editor.tabSize": { type: "number", default: 8 },
        "editor.insertSpaces": { type: "boolean", default: true },
      },
    });
    await service.ready;

    expect(service.get<number>("editor.tabSize")).toBe(4); // workspace wins over user and defaults
    expect(service.get<string>("editor.wordWrap")).toBe("off"); // user only, no workspace override
    expect(service.get<boolean>("editor.insertSpaces")).toBe(true); // defaults only
    service.dispose();
  });

  test("with no workspaceRoot, only defaults and user settings apply", async () => {
    const userPath = getUserSettingsPath();
    const fake = createFakeFs({ [userPath]: JSON.stringify({ "editor.tabSize": 2 }) });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    expect(service.get<number>("editor.tabSize")).toBe(2);
    service.dispose();
  });

  test("get on a missing key returns undefined", async () => {
    const fake = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    expect(service.get("nothing.here")).toBeUndefined();
    service.dispose();
  });

  test("a missing settings file is treated as an empty layer, not an error", async () => {
    const fake = createFakeFs(); // no files at all
    const log = createHostLog();
    const { sink, errors } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    expect(errors).toHaveLength(0);
    expect(log.entries()).toHaveLength(0);
    service.dispose();
  });
});

describe("ConfigService.registerConfiguration (Req 9.3)", () => {
  test("populates defaults for properties that declare one", async () => {
    const fake = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    service.registerConfiguration({
      properties: {
        "widget.enabled": { type: "boolean", default: true },
        "widget.count": { type: "number", default: 3 },
        "widget.noDefault": { type: "string" },
      },
    });

    expect(service.get<boolean>("widget.enabled")).toBe(true);
    expect(service.get<number>("widget.count")).toBe(3);
    expect(service.get("widget.noDefault")).toBeUndefined();
    service.dispose();
  });

  test("disposing the registration removes its defaults again", async () => {
    const fake = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    const reg = service.registerConfiguration({
      properties: { "widget.enabled": { type: "boolean", default: true } },
    });
    expect(service.get<boolean>("widget.enabled")).toBe(true);

    reg.dispose();
    expect(service.get("widget.enabled")).toBeUndefined();

    // Idempotent.
    expect(() => reg.dispose()).not.toThrow();
    service.dispose();
  });
});

describe("ConfigService — live reload via watch (Req 9.4)", () => {
  test("a changed user setting fires onDidChange with correct affectsConfiguration", async () => {
    const userPath = getUserSettingsPath();
    const fake = createFakeFs({ [userPath]: JSON.stringify({ "editor.tabSize": 2 }) });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    const events: ConfigChangeEvent[] = [];
    service.onDidChange((e) => events.push(e));

    fake.setFile(userPath, JSON.stringify({ "editor.tabSize": 4 }));
    fake.triggerChange(userPath);
    await waitFor(() => events.length > 0);

    expect(service.get<number>("editor.tabSize")).toBe(4);
    expect(events).toHaveLength(1);
    const event = events[0]!;

    // equal key
    expect(event.affectsConfiguration("editor.tabSize")).toBe(true);
    // section is an ancestor of the changed key (a coarser query)
    expect(event.affectsConfiguration("editor")).toBe(true);
    // the changed key is an ancestor of a finer, hypothetical descendant query
    expect(event.affectsConfiguration("editor.tabSize.nested")).toBe(true);
    // bare-prefix collision without a dot boundary must not match
    expect(event.affectsConfiguration("editorX")).toBe(false);

    service.dispose();
  });

  test("a reload that reproduces identical values fires no event", async () => {
    const userPath = getUserSettingsPath();
    const fake = createFakeFs({ [userPath]: JSON.stringify({ "editor.tabSize": 2 }) });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    const events: unknown[] = [];
    service.onDidChange(() => events.push("fired"));

    // Rewritten with byte-identical JSON content: JSON.parse still yields
    // a fresh object reference, but every value is structurally equal —
    // no onDidChange should fire.
    fake.setFile(userPath, JSON.stringify({ "editor.tabSize": 2 }));
    fake.triggerChange(userPath);

    // Give the reload chain a chance to run before asserting silence —
    // there is no "fired" event to wait for here, so wait for the reload
    // to actually complete via a side channel: re-triggering with a real
    // change and waiting for *that* event proves the first reload had
    // already finished (reload chains are per-file and FIFO).
    fake.setFile(userPath, JSON.stringify({ "editor.tabSize": 5 }));
    fake.triggerChange(userPath);
    await waitFor(() => events.length > 0);

    expect(events).toHaveLength(1); // only the second, real change fired
    expect(service.get<number>("editor.tabSize")).toBe(5);
    service.dispose();
  });

  test("a deep-equal array/object value reloading does not fire a spurious event", async () => {
    const userPath = getUserSettingsPath();
    const fake = createFakeFs({
      [userPath]: JSON.stringify({ "files.exclude": ["a", "b"], "editor.opts": { x: 1 } }),
    });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    const events: unknown[] = [];
    service.onDidChange(() => events.push("fired"));

    fake.setFile(
      userPath,
      JSON.stringify({ "files.exclude": ["a", "b"], "editor.opts": { x: 1 }, extra: "z" }),
    );
    fake.triggerChange(userPath);
    await waitFor(() => service.get("extra") === "z");

    // Only "extra" changed — the deep-equal array/object values must not
    // have produced a change too (implicitly verified: no throw/hang), and
    // exactly one event fired.
    expect(events).toHaveLength(1);
    service.dispose();
  });

  test("workspace file changes fire events scoped only to the workspace layer", async () => {
    const userPath = getUserSettingsPath();
    const workspaceRoot = "/fake-workspace-2";
    const workspacePath = getWorkspaceSettingsPath(workspaceRoot);
    const fake = createFakeFs({
      [userPath]: JSON.stringify({ "editor.tabSize": 2 }),
      [workspacePath]: JSON.stringify({}),
    });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, workspaceRoot, fs: fake.fs });
    await service.ready;

    const events: ConfigChangeEvent[] = [];
    service.onDidChange((e) => events.push(e));

    fake.setFile(workspacePath, JSON.stringify({ "explorer.showHidden": true }));
    fake.triggerChange(workspacePath);
    await waitFor(() => events.length > 0);

    expect(service.get<boolean>("explorer.showHidden")).toBe(true);
    expect(events[0]!.affectsConfiguration("explorer.showHidden")).toBe(true);
    expect(events[0]!.affectsConfiguration("editor.tabSize")).toBe(false);
    service.dispose();
  });
});

describe("ConfigService — parse-error resilience (Req 9, design.md §14)", () => {
  test("a parse error on reload keeps the last-good layer and reports line/column via the sink", async () => {
    const userPath = getUserSettingsPath();
    const fake = createFakeFs({ [userPath]: JSON.stringify({ "editor.tabSize": 2 }) });
    const log = createHostLog();
    const { sink, errors } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    expect(service.get<number>("editor.tabSize")).toBe(2);

    const events: unknown[] = [];
    service.onDidChange(() => events.push("fired"));

    fake.setFile(userPath, "{ this is not valid json");
    fake.triggerChange(userPath);
    await waitFor(() => errors.length > 0);

    expect(service.get<number>("editor.tabSize")).toBe(2); // unchanged — last-good kept
    expect(events).toHaveLength(0); // merged view never touched, no event
    const reported = errors.at(-1)!;
    expect(reported.message).toMatch(/line \d+, column \d+/);
    const errorEntries = log.entries().filter((e) => e.level === "error");
    expect(errorEntries.length).toBeGreaterThan(0);

    service.dispose();
  });

  test("a top-level non-object settings file is rejected and the last-good layer is kept", async () => {
    const userPath = getUserSettingsPath();
    const fake = createFakeFs({ [userPath]: JSON.stringify({ "editor.tabSize": 2 }) });
    const log = createHostLog();
    const { sink, errors } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    fake.setFile(userPath, JSON.stringify([1, 2, 3]));
    fake.triggerChange(userPath);
    await waitFor(() => errors.length > 0);

    expect(service.get<number>("editor.tabSize")).toBe(2);
    service.dispose();
  });

  test("keybindings.json is required to be a top-level array", async () => {
    const keybindingsPath = getUserKeybindingsPath();
    const fake = createFakeFs({ [keybindingsPath]: JSON.stringify({ not: "an array" }) });
    const log = createHostLog();
    const { sink, errors } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    expect(service.getKeybindingEntries()).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    service.dispose();
  });
});

describe("ConfigService — best-effort type validation (Req 9.3 MVP policy)", () => {
  test("a value whose type mismatches its schema is served, and logged as a warning", async () => {
    const userPath = getUserSettingsPath();
    const fake = createFakeFs({
      [userPath]: JSON.stringify({ "editor.tabSize": "not-a-number" }),
    });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    service.registerConfiguration({
      properties: { "editor.tabSize": { type: "number", default: 4 } },
    });
    await service.ready;

    // Served anyway — the MVP never rejects a value, only warns.
    expect(service.get<string>("editor.tabSize")).toBe("not-a-number");
    const warnings = log.entries().filter((e) => e.level === "warning");
    expect(warnings.some((w) => w.error.message.includes("editor.tabSize"))).toBe(true);
    service.dispose();
  });

  test("a value matching its schema type produces no warning", async () => {
    const userPath = getUserSettingsPath();
    const fake = createFakeFs({ [userPath]: JSON.stringify({ "editor.tabSize": 4 }) });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    service.registerConfiguration({
      properties: { "editor.tabSize": { type: "number", default: 4 } },
    });
    await service.ready;

    const warnings = log.entries().filter((e) => e.level === "warning");
    expect(warnings).toHaveLength(0);
    service.dispose();
  });
});

describe("ConfigService — keybindings (Req 9.1)", () => {
  test("getKeybindingEntries reflects the parsed keybindings.json array", async () => {
    const keybindingsPath = getUserKeybindingsPath();
    const entries = [{ key: "ctrl+s", command: "workspace.save" }];
    const fake = createFakeFs({ [keybindingsPath]: JSON.stringify(entries) });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    expect(service.getKeybindingEntries()).toEqual(entries);
    service.dispose();
  });

  test("onKeybindingsChange fires on initial load and again on reload", async () => {
    const keybindingsPath = getUserKeybindingsPath();
    const fake = createFakeFs({
      [keybindingsPath]: JSON.stringify([{ key: "a", command: "x" }]),
    });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const calls: (readonly unknown[])[] = [];
    const service = createConfigService({
      log,
      sink,
      fs: fake.fs,
      onKeybindingsChange: (entries) => calls.push(entries),
    });
    await service.ready;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([{ key: "a", command: "x" }]);

    fake.setFile(keybindingsPath, JSON.stringify([{ key: "b", command: "y" }]));
    fake.triggerChange(keybindingsPath);
    await waitFor(() => calls.length > 1);

    expect(calls[1]).toEqual([{ key: "b", command: "y" }]);
    service.dispose();
  });

  test("a throwing onKeybindingsChange callback does not break loading", async () => {
    const keybindingsPath = getUserKeybindingsPath();
    const fake = createFakeFs({ [keybindingsPath]: JSON.stringify([]) });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({
      log,
      sink,
      fs: fake.fs,
      onKeybindingsChange: () => {
        throw new Error("boom");
      },
    });
    await expect(service.ready).resolves.toBeUndefined();
    const errorEntries = log.entries().filter((e) => e.level === "error");
    expect(errorEntries.some((e) => e.error.message.includes("boom"))).toBe(true);
    service.dispose();
  });
});

describe("ConfigService.dispose", () => {
  test("closes watchers; a change after dispose is not observed", async () => {
    const userPath = getUserSettingsPath();
    const fake = createFakeFs({ [userPath]: JSON.stringify({ "editor.tabSize": 2 }) });
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    const events: unknown[] = [];
    service.onDidChange(() => events.push("fired"));

    service.dispose();
    fake.setFile(userPath, JSON.stringify({ "editor.tabSize": 99 }));
    fake.triggerChange(userPath);

    // No watcher left to observe the change; give any stray async work a
    // moment to (not) run, then assert nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(0);
    expect(service.get<number>("editor.tabSize")).toBe(2);
  });

  test("dispose is idempotent", async () => {
    const fake = createFakeFs();
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;
    service.dispose();
    expect(() => service.dispose()).not.toThrow();
  });
});

describe("ConfigService — a watch on a nonexistent file does not throw (Req 9)", () => {
  test("a watch() that throws synchronously is caught, logged, and does not break load", async () => {
    const userPath = getUserSettingsPath();
    const fake = createFakeFs({ [userPath]: JSON.stringify({ "editor.tabSize": 2 }) });
    const throwingFs: ConfigServiceFs = {
      readFile: fake.fs.readFile,
      watch(path) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      },
    };
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const service = createConfigService({ log, sink, fs: throwingFs });

    await expect(service.ready).resolves.toBeUndefined();
    expect(service.get<number>("editor.tabSize")).toBe(2);
    const warnings = log.entries().filter((e) => e.level === "warning");
    expect(warnings.length).toBeGreaterThan(0);
    service.dispose();
  });
});

describe("ConfigService — real filesystem integration (design.md §16)", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("reads a real workspace settings.json and reloads on a real fs.watch change", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-config-svc-"));
    const tecodeDir = join(dir, ".tecode");
    await mkdir(tecodeDir, { recursive: true });
    const settingsPath = join(tecodeDir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ "editor.tabSize": 2 }), "utf8");

    const log = createHostLog();
    const { sink } = createRecordingSink();
    // No fs override: exercises the real node:fs/promises + node:fs.watch
    // default. The user-level paths (~/.config/tecode/...) point at real
    // OS paths too; a missing user config is the expected, harmless case
    // (ENOENT -> empty layer).
    const service = createConfigService({ log, sink, workspaceRoot: dir });
    await service.ready;

    expect(service.get<number>("editor.tabSize")).toBe(2);

    const events: ConfigChangeEvent[] = [];
    service.onDidChange((e) => events.push(e));

    await writeFile(settingsPath, JSON.stringify({ "editor.tabSize": 4 }), "utf8");

    // fs.watch delivery can be slow/coalesced — poll with a deadline
    // rather than a single fixed sleep.
    await waitFor(() => service.get("editor.tabSize") === 4, 10_000);
    expect(events.some((e) => e.affectsConfiguration("editor.tabSize"))).toBe(true);

    service.dispose();
  }, 15_000);
});

describe("createConfigService — review regressions", () => {
  test("get() does not leak Object.prototype members for unconfigured keys", async () => {
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const fake = createFakeFs();
    const service = createConfigService({ log, sink, fs: fake.fs });
    await service.ready;

    expect(service.get("toString")).toBeUndefined();
    expect(service.get("constructor")).toBeUndefined();
    expect(service.get("hasOwnProperty")).toBeUndefined();
    service.dispose();
  });

  test("an asynchronous watcher failure is reported as a warning, not thrown", async () => {
    const log = createHostLog();
    const { sink } = createRecordingSink();
    const errorCallbacks: ((cause: unknown) => void)[] = [];
    const failingFs: ConfigServiceFs = {
      async readFile(path) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      },
      watch(path, onChange, onError) {
        void path;
        void onChange;
        if (onError) errorCallbacks.push(onError);
        return {
          close() {
            // Nothing to release in this stub.
          },
        };
      },
    };
    const service = createConfigService({ log, sink, fs: failingFs });
    await service.ready;

    // Every watcher's async failure path funnels through the onError
    // callback — firing it must only record a warning.
    expect(errorCallbacks.length).toBeGreaterThan(0);
    for (const cb of errorCallbacks) cb(new Error("watch limit reached"));

    const warnings = log.entries().filter((e) => e.level === "warning");
    expect(
      warnings.some((e) => e.error.message.includes("watch limit reached")),
    ).toBe(true);
    service.dispose();
  });
});
