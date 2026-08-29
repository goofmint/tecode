/**
 * Integration-ish tests for `command-palette`'s `activate(ctx)` (Task 3.2,
 * Req 11.3) — a minimal fake `Tecode` (local to this file, `@tecode/api`
 * types only, matching this suite's "no mock libraries, local fakes" house
 * convention — follows `editor-core/index.test.ts`'s `createFakeApi`
 * pattern) stands in for the real core, so `activate` is exercised through
 * the same public surface a real extension would see.
 */

import { describe, expect, test } from "bun:test";
import type {
  CommandDescriptor,
  CommandHandler,
  CommandMeta,
  DirEntry,
  ExtensionContext,
  MessageKind,
  QuickPickItem,
  QuickPickOptions,
  Tecode,
  Uri,
} from "@tecode/api";
import { activate } from "./index";
import { QUICK_OPEN_COMMAND_ID, SHOW_COMMANDS_COMMAND_ID } from "./manifest";

const OPEN_FILE_COMMAND_ID = "workbench.action.files.openUri";

/** A fake in-memory directory tree for `workspace.fs.readdir` — a
 * directory value is a `Record<name, Entry>`; a file value is `null`. */
type FakeTree = { [name: string]: FakeTree | null };

/** A minimal fake `Tecode`, backing exactly what `command-palette`'s
 * `activate` reads/writes: `commands` (with a real lazy-activation
 * simulation, so a picked lazy command's owning extension is proven to
 * activate before the command's own handler runs), `context.get`,
 * `window.showQuickPick`/`showMessage`, and `workspace.rootUri`/`fs.readdir`.
 * Everything else is left `undefined` — `activate` never touches it. */
function createFakeApi(tree: FakeTree, rootUri: Uri | undefined = "file:///workspace/") {
  const commandHandlers = new Map<string, CommandHandler>();
  const commandMeta = new Map<string, CommandMeta>();
  const lazyOwners = new Map<string, string>();
  const lazyRegisterers = new Map<string, () => void>();
  const activationLog: string[] = [];
  const contextValues = new Map<string, unknown>();
  const messages: { message: string; kind?: MessageKind }[] = [];
  let nextPick: QuickPickItem | undefined;
  let lastQuickPick: { items: QuickPickItem[]; options?: QuickPickOptions } | undefined;
  let quickPickThrows: Error | undefined;

  /** Register a lazy (manifest-declared, not-yet-activated) command owned
   * by `ownerId`; `onActivate` is what "activating `ownerId`" does — call
   * `commands.register` for real, exactly like a real extension's
   * `activate()` would. */
  function registerLazyCommand(id: string, ownerId: string, meta: CommandMeta, onActivate: () => void): void {
    commandMeta.set(id, meta);
    lazyOwners.set(id, ownerId);
    lazyRegisterers.set(id, onActivate);
  }

  const commands: Tecode["commands"] = {
    register(id, handler, meta) {
      commandHandlers.set(id, handler);
      if (meta) commandMeta.set(id, meta);
      lazyOwners.delete(id);
      return {
        dispose() {
          commandHandlers.delete(id);
        },
      };
    },
    async execute(id, ...args) {
      if (!commandHandlers.has(id)) {
        const owner = lazyOwners.get(id);
        if (owner) {
          activationLog.push(`activate:${owner}`);
          lazyOwners.delete(id);
          lazyRegisterers.get(id)?.();
        }
      }
      activationLog.push(`execute:${id}`);
      const handler = commandHandlers.get(id);
      if (!handler) return undefined;
      return handler(...args);
    },
    list(): CommandDescriptor[] {
      const ids = new Set([...commandHandlers.keys(), ...lazyOwners.keys()]);
      return Array.from(ids).map((id) => {
        const meta = commandMeta.get(id) ?? {};
        return { id, title: meta.title, category: meta.category, when: meta.when };
      });
    },
  };

  function readdir(uri: Uri): Promise<DirEntry[]> {
    const relative = uri.replace(rootUri ?? "", "").replace(/\/$/, "");
    const segments = relative.length > 0 ? relative.split("/") : [];
    let node: FakeTree = tree;
    for (const segment of segments) {
      const decoded = decodeURIComponent(segment);
      const next = node[decoded];
      if (next === null || next === undefined) return Promise.reject(new Error(`ENOENT: ${uri}`));
      node = next;
    }
    return Promise.resolve(
      Object.entries(node).map(([name, value]) => ({
        name,
        type: value === null ? "file" : "directory",
      })),
    );
  }

  const api: Tecode = {
    commands,
    workspace: {
      rootUri,
      fs: { readdir } as unknown as Tecode["workspace"]["fs"],
    } as unknown as Tecode["workspace"],
    window: {
      showMessage(message: string, kind?: MessageKind) {
        messages.push({ message, kind });
      },
      async showQuickPick(items: QuickPickItem[], options?: QuickPickOptions) {
        lastQuickPick = { items, options };
        if (quickPickThrows) throw quickPickThrows;
        return nextPick;
      },
      showInputBox: async () => undefined,
      setStatusBarItem: () => ({ dispose() {} }),
    } as unknown as Tecode["window"],
    editor: undefined as never,
    ui: undefined as never,
    config: undefined as never,
    context: {
      get: <T = unknown>(key: string): T | undefined => contextValues.get(key) as T | undefined,
      set: (key: string, value: unknown) => contextValues.set(key, value),
    },
    languages: undefined as never,
    themes: undefined as never,
    clipboard: undefined as never,
    terminal: undefined as never,
  };

  return {
    api,
    registerLazyCommand,
    activationLog,
    setContext: (key: string, value: unknown) => contextValues.set(key, value),
    setNextPick: (item: QuickPickItem | undefined) => {
      nextPick = item;
    },
    setQuickPickThrows: (err: Error | undefined) => {
      quickPickThrows = err;
    },
    getLastQuickPick: () => lastQuickPick,
    getMessages: () => messages,
  };
}

function activateFixture(tree: FakeTree = {}, rootUri: Uri | undefined = "file:///workspace/") {
  const fake = createFakeApi(tree, rootUri);
  const ctx: ExtensionContext = {
    api: fake.api,
    extensionUri: "<builtin>/tecode.command-palette",
    subscriptions: [],
    storagePath: "/tmp/fake-command-palette-storage",
  };
  activate(ctx);
  return { ...fake, ctx };
}

describe("command-palette activate() — workbench.action.showCommands (Task 3.2, Req 11.3)", () => {
  test("lists commands with a title, formatted as Category: Title", async () => {
    const fake = activateFixture();
    fake.api.commands.register("editor.action.save", () => {}, { title: "Save File", category: "Editor" });
    fake.setNextPick(undefined); // cancel — we only inspect what was shown
    await fake.api.commands.execute(SHOW_COMMANDS_COMMAND_ID);

    const shown = fake.getLastQuickPick()!.items;
    const saveItem = shown.find((i) => i.description === "editor.action.save");
    expect(saveItem?.label).toBe("Editor: Save File");
  });

  test("a title with no category is labeled with just the title", async () => {
    const fake = activateFixture();
    fake.api.commands.register("theme.select.ui", () => {}, { title: "Select Theme" });
    fake.setNextPick(undefined);
    await fake.api.commands.execute(SHOW_COMMANDS_COMMAND_ID);

    const shown = fake.getLastQuickPick()!.items;
    const item = shown.find((i) => i.description === "theme.select.ui");
    expect(item?.label).toBe("Select Theme");
  });

  test("a command with no title at all falls back to showing its raw id (never silently hidden)", async () => {
    // Real registry behavior (`@tecode/core`'s `commands/registry.ts`):
    // `register(id, handler)` with no meta wipes any earlier title, so an
    // ordinary, real command (not just an internal bridge one) can
    // legitimately end up title-less post-activation — this must still
    // show, not vanish (`index.ts`'s "Why this does NOT filter out
    // title-less commands").
    const fake = activateFixture();
    fake.api.commands.register("theme.select", () => {}); // no meta at all
    fake.setNextPick(undefined);
    await fake.api.commands.execute(SHOW_COMMANDS_COMMAND_ID);

    const shown = fake.getLastQuickPick()!.items;
    const item = shown.find((i) => i.description === "theme.select");
    expect(item?.label).toBe("theme.select");
  });

  test("an internal bridge command (workbench.action.files.openUri's own convention) is hidden via its when clause, not its title", async () => {
    const fake = activateFixture();
    // Mirrors `ui/openFileCommand.ts`'s real registration exactly: no
    // title, `when` set to a context key nothing ever sets.
    fake.api.commands.register(OPEN_FILE_COMMAND_ID, () => {}, {
      when: "tecode.internal.neverShown",
    });
    fake.setNextPick(undefined);
    await fake.api.commands.execute(SHOW_COMMANDS_COMMAND_ID);

    const shown = fake.getLastQuickPick()!.items;
    expect(shown.some((i) => i.description === OPEN_FILE_COMMAND_ID)).toBe(false);
  });

  test("a command whose when clause evaluates false against context is hidden", async () => {
    const fake = activateFixture();
    fake.api.commands.register("explorer.reveal", () => {}, {
      title: "Reveal in Explorer",
      when: "explorerFocus",
    });
    fake.api.commands.register("editor.action.find", () => {}, {
      title: "Find",
      when: "editorTextFocus",
    });
    fake.setContext("editorTextFocus", true);
    fake.setContext("explorerFocus", false);
    fake.setNextPick(undefined);
    await fake.api.commands.execute(SHOW_COMMANDS_COMMAND_ID);

    const shownIds = fake.getLastQuickPick()!.items.map((i) => i.description);
    expect(shownIds).toContain("editor.action.find");
    expect(shownIds).not.toContain("explorer.reveal");
  });

  test("picking an item executes its command id, activating a still-lazy owner first", async () => {
    const fake = activateFixture();
    let ranAfterActivation = false;
    fake.registerLazyCommand("explorer.reveal", "tecode.explorer", { title: "Reveal", category: "File" }, () => {
      fake.api.commands.register("explorer.reveal", () => {
        ranAfterActivation = true;
      });
    });
    fake.setNextPick({ label: "File: Reveal", description: "explorer.reveal" });

    await fake.api.commands.execute(SHOW_COMMANDS_COMMAND_ID);

    expect(ranAfterActivation).toBe(true);
    expect(fake.activationLog).toEqual([
      // The palette's own command activating+running:
      "execute:workbench.action.showCommands",
      // Then, from inside the handler, the picked lazy command:
      "activate:tecode.explorer",
      "execute:explorer.reveal",
    ]);
  });

  test("cancelling the picker (undefined) is a no-op — no command is executed", async () => {
    const fake = activateFixture();
    let called = false;
    fake.api.commands.register("editor.action.save", () => {
      called = true;
    }, { title: "Save File" });
    fake.setNextPick(undefined);

    await fake.api.commands.execute(SHOW_COMMANDS_COMMAND_ID);

    expect(called).toBe(false);
  });

  test("a throwing showQuickPick rejects — no local catch swallows it (code review finding: the registry's own execute() is the one documented catch point)", async () => {
    const fake = activateFixture();
    fake.setQuickPickThrows(new Error("picker exploded"));
    // This fake `commands.execute` (unlike the real `CommandRegistry.
    // execute`, `@tecode/core`'s `commands/registry.ts`) does not itself
    // catch a thrown handler — so the handler's own promise rejecting here
    // is exactly what proves `registerShowCommands` no longer has a local
    // `try`/`catch` swallowing it before it would reach the registry.
    await expect(fake.api.commands.execute(SHOW_COMMANDS_COMMAND_ID)).rejects.toThrow(
      "picker exploded",
    );
  });
});

describe("command-palette activate() — workbench.action.quickOpen (Task 3.2, Req 11.3)", () => {
  test("walks the workspace and shows relative paths as labels", async () => {
    const fake = activateFixture({
      "b.ts": null,
      "a.ts": null,
      src: { "index.ts": null },
    });
    fake.setNextPick(undefined);

    await fake.api.commands.execute(QUICK_OPEN_COMMAND_ID);

    const items = fake.getLastQuickPick()!.items;
    expect(items.map((i) => i.label)).toEqual(["a.ts", "b.ts", "src/index.ts"]);
  });

  test("picking a file executes workbench.action.files.openUri with the file's uri", async () => {
    const fake = activateFixture({ "notes.txt": null });
    let openedUri: unknown;
    fake.api.commands.register(OPEN_FILE_COMMAND_ID, (uri: unknown) => {
      openedUri = uri;
    });
    fake.setNextPick({ label: "notes.txt", description: "file:///workspace/notes.txt" });

    await fake.api.commands.execute(QUICK_OPEN_COMMAND_ID);

    expect(openedUri).toBe("file:///workspace/notes.txt");
  });

  test("excludes .git and node_modules via the default ignore stub", async () => {
    const fake = activateFixture({
      ".git": { HEAD: null },
      node_modules: { pkg: { "index.js": null } },
      "keep.ts": null,
    });
    fake.setNextPick(undefined);

    await fake.api.commands.execute(QUICK_OPEN_COMMAND_ID);

    const items = fake.getLastQuickPick()!.items;
    expect(items.map((i) => i.label)).toEqual(["keep.ts"]);
  });

  test("no workspace root shows a message instead of opening an empty picker", async () => {
    const fake = activateFixture({}, undefined);
    await fake.api.commands.execute(QUICK_OPEN_COMMAND_ID);

    expect(fake.getLastQuickPick()).toBeUndefined();
    expect(fake.getMessages().length).toBeGreaterThan(0);
  });

  test("an empty workspace shows a message instead of opening an empty picker", async () => {
    const fake = activateFixture({});
    await fake.api.commands.execute(QUICK_OPEN_COMMAND_ID);

    expect(fake.getLastQuickPick()).toBeUndefined();
    expect(fake.getMessages().length).toBeGreaterThan(0);
  });

  test("cancelling the picker is a no-op", async () => {
    const fake = activateFixture({ "a.ts": null });
    let called = false;
    fake.api.commands.register(OPEN_FILE_COMMAND_ID, () => {
      called = true;
    });
    fake.setNextPick(undefined);

    await fake.api.commands.execute(QUICK_OPEN_COMMAND_ID);

    expect(called).toBe(false);
  });

  test("a throwing showQuickPick rejects — no local catch swallows it (code review finding)", async () => {
    const fake = activateFixture({ "a.ts": null });
    fake.setQuickPickThrows(new Error("picker exploded"));
    await expect(fake.api.commands.execute(QUICK_OPEN_COMMAND_ID)).rejects.toThrow(
      "picker exploded",
    );
  });

  test("a workspace with more files than the walk's cap surfaces a truncation note (code review finding: bounded workspace scan)", async () => {
    // Flat tree of more files than command-palette's internal
    // `QUICK_OPEN_MAX_RESULTS` cap (5000) — all siblings under root, so one
    // `readdir` call is enough to exceed it.
    const tree: FakeTree = {};
    for (let i = 0; i < 5001; i++) {
      tree[`file-${String(i).padStart(5, "0")}.ts`] = null;
    }
    const fake = activateFixture(tree);
    fake.setNextPick(undefined);

    await fake.api.commands.execute(QUICK_OPEN_COMMAND_ID);

    const items = fake.getLastQuickPick()!.items;
    expect(items.length).toBe(5000);
    const messages = fake.getMessages();
    expect(messages.some((m) => /more/i.test(m.message) && m.kind === "info")).toBe(true);
  });
});
