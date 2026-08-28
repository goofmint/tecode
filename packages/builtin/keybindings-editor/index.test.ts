/**
 * Tests for `keybindings-editor`'s `activate(ctx)` (Task 4.3, Req 11.7) —
 * a minimal fake `Tecode` local to this file (`@tecode/api` types only,
 * this suite's "no mock libraries, local fakes" house convention,
 * following `command-palette/index.test.ts`'s `createFakeApi` pattern).
 * `keybindings.internal.ensureFile`/`keybindings.internal.resolveTable`
 * (the privileged bridge commands `activate` reaches through
 * `commands.execute`) are themselves faked by registering plain handlers
 * for their ids on this fake — exactly what a real `@tecode/core` would
 * have already registered before `keybindings-editor` ever activates
 * (`main.ts`'s `buildAssemblyRoot` registers `keybindingsCommands` well
 * before any extension's `onStartup` fires).
 */

import { describe, expect, test } from "bun:test";
import type {
  CommandHandler,
  ExtensionContext,
  MessageKind,
  QuickPickItem,
  QuickPickOptions,
  Tecode,
} from "@tecode/api";
import { activate } from "./index";
import { KEYBINDINGS_OPEN_COMMAND_ID, KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID } from "./manifest";

/** Must stay in sync with `@tecode/core`'s `ui/keybindingsCommands.ts`'s
 * `KEYBINDINGS_ENSURE_FILE_COMMAND_ID`/`KEYBINDINGS_RESOLVE_TABLE_COMMAND_ID`
 * and this built-in's own `index.ts` (which duplicates the same literals
 * for the same "can't import `@tecode/core`" reason — `index.ts`'s
 * TSDoc). */
const ENSURE_FILE_COMMAND_ID = "keybindings.internal.ensureFile";
const RESOLVE_TABLE_COMMAND_ID = "keybindings.internal.resolveTable";
const OPEN_FILE_COMMAND_ID = "workbench.action.files.openUri";

function createFakeApi() {
  const handlers = new Map<string, CommandHandler>();
  const messages: { message: string; kind?: MessageKind }[] = [];
  let lastQuickPick: { items: QuickPickItem[]; options?: QuickPickOptions } | undefined;
  let nextPick: QuickPickItem | undefined;

  const commands: Tecode["commands"] = {
    register(id, handler) {
      handlers.set(id, handler);
      return {
        dispose() {
          handlers.delete(id);
        },
      };
    },
    async execute(id, ...args) {
      const handler = handlers.get(id);
      if (!handler) return undefined;
      return handler(...args);
    },
    list: () => [],
  };

  const api: Tecode = {
    commands,
    workspace: undefined as never,
    editor: undefined as never,
    ui: undefined as never,
    config: undefined as never,
    languages: undefined as never,
    themes: undefined as never,
    clipboard: undefined as never,
    context: undefined as never,
    window: {
      showMessage(message: string, kind?: MessageKind) {
        messages.push({ message, kind });
      },
      async showQuickPick(items: QuickPickItem[], options?: QuickPickOptions) {
        lastQuickPick = { items, options };
        return nextPick;
      },
      showInputBox: async () => undefined,
      setStatusBarItem: () => ({ dispose() {} }),
    } as unknown as Tecode["window"],
  };

  return {
    api,
    commands,
    /** Register a fake handler for one of the privileged bridge command
     * ids, standing in for `@tecode/core`'s real registration (this
     * module's TSDoc). */
    registerBridge: (id: string, handler: CommandHandler) => {
      handlers.set(id, handler);
    },
    setNextPick: (item: QuickPickItem | undefined) => {
      nextPick = item;
    },
    getLastQuickPick: () => lastQuickPick,
    getMessages: () => messages,
  };
}

function activateFixture() {
  const fake = createFakeApi();
  const ctx: ExtensionContext = {
    api: fake.api,
    extensionUri: "<builtin>/tecode.keybindings-editor",
    subscriptions: [],
    storagePath: "/tmp/fake-keybindings-editor-storage",
  };
  activate(ctx);
  return { ...fake, ctx };
}

describe("keybindings-editor activate() — keybindings.open (Req 11.7)", () => {
  test("ensures the file first, then opens the returned Uri", async () => {
    const fake = activateFixture();
    const opened: unknown[] = [];
    fake.registerBridge(ENSURE_FILE_COMMAND_ID, async () => "file:///home/u/.config/tecode/keybindings.json");
    fake.registerBridge(OPEN_FILE_COMMAND_ID, async (...args) => {
      opened.push(...args);
    });

    await fake.api.commands.execute(KEYBINDINGS_OPEN_COMMAND_ID);

    expect(opened).toEqual(["file:///home/u/.config/tecode/keybindings.json"]);
  });

  test("a malformed (non-Uri) ensureFile result surfaces an error and never calls openUri", async () => {
    const fake = activateFixture();
    let openUriCalled = false;
    fake.registerBridge(ENSURE_FILE_COMMAND_ID, async () => 42); // not a string
    fake.registerBridge(OPEN_FILE_COMMAND_ID, async () => {
      openUriCalled = true;
    });

    await fake.api.commands.execute(KEYBINDINGS_OPEN_COMMAND_ID);

    expect(openUriCalled).toBe(false);
    expect(fake.getMessages()).toHaveLength(1);
    expect(fake.getMessages()[0]?.kind).toBe("error");
  });

  test("no ensureFile handler registered at all (bridge command missing) surfaces an error, never throws", async () => {
    const fake = activateFixture();
    // Deliberately no `registerBridge` call — `commands.execute` on an
    // unregistered id resolves `undefined`, matching a real
    // `CommandRegistry.execute("unknown command")`.
    await expect(fake.api.commands.execute(KEYBINDINGS_OPEN_COMMAND_ID)).resolves.toBeUndefined();
    expect(fake.getMessages()).toHaveLength(1);
    expect(fake.getMessages()[0]?.kind).toBe("error");
  });
});

describe("keybindings-editor activate() — keybindings.showResolved (Req 11.7)", () => {
  test("formats rows from all four source layers, including the extension id when known", async () => {
    const fake = activateFixture();
    fake.registerBridge(RESOLVE_TABLE_COMMAND_ID, async () => [
      { key: "ctrl+s", command: "editor.action.save", layer: "defaults" },
      {
        key: "ctrl+shift+alt+p",
        command: "workbench.action.showCommands",
        layer: "fallback",
      },
      {
        key: "ctrl+shift+r",
        command: "demo.run",
        layer: "extension",
        extensionId: "demo.ext",
      },
      {
        key: "ctrl+alt+z",
        command: "user.command",
        layer: "user",
        when: "editorFocus",
      },
    ]);
    fake.setNextPick(undefined);

    await fake.api.commands.execute(KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID);

    const items = fake.getLastQuickPick()!.items;
    expect(items).toHaveLength(4);

    const byLabel = (label: string) => items.find((i) => i.label === label);

    expect(byLabel("ctrl+s — editor.action.save")?.detail).toBe("source: defaults");
    expect(byLabel("ctrl+shift+alt+p — workbench.action.showCommands")?.detail).toBe(
      "source: fallback",
    );
    expect(byLabel("ctrl+shift+r — demo.run")?.detail).toBe("source: extension: demo.ext");
    expect(byLabel("ctrl+alt+z — user.command")?.detail).toBe(
      "source: user  ·  when: editorFocus",
    );
  });

  test("an extension-layer row with no known extensionId falls back to a bare 'extension' source", async () => {
    const fake = activateFixture();
    fake.registerBridge(RESOLVE_TABLE_COMMAND_ID, async () => [
      { key: "ctrl+p", command: "quickOpen.show", layer: "extension" },
    ]);
    fake.setNextPick(undefined);

    await fake.api.commands.execute(KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID);

    const items = fake.getLastQuickPick()!.items;
    expect(items[0]?.detail).toBe("source: extension");
  });

  test("malformed rows are silently dropped rather than crashing the listing", async () => {
    const fake = activateFixture();
    fake.registerBridge(RESOLVE_TABLE_COMMAND_ID, async () => [
      { key: "ctrl+p", command: "quickOpen.show", layer: "defaults" },
      { key: "", command: "bad.emptyKey", layer: "defaults" }, // empty key: invalid
      { key: "ctrl+x", command: "bad.layer", layer: "not-a-real-layer" }, // bad layer
      "not even an object",
      null,
    ]);
    fake.setNextPick(undefined);

    await fake.api.commands.execute(KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID);

    const items = fake.getLastQuickPick()!.items;
    expect(items).toEqual([
      { label: "ctrl+p — quickOpen.show", detail: "source: defaults" },
    ]);
  });

  test("a non-array resolveTable result surfaces an error instead of opening the picker", async () => {
    const fake = activateFixture();
    fake.registerBridge(RESOLVE_TABLE_COMMAND_ID, async () => ({ not: "an array" }));

    await fake.api.commands.execute(KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID);

    expect(fake.getLastQuickPick()).toBeUndefined();
    expect(fake.getMessages()).toHaveLength(1);
    expect(fake.getMessages()[0]?.kind).toBe("error");
  });

  test("zero valid rows surfaces an info message instead of an empty picker", async () => {
    const fake = activateFixture();
    fake.registerBridge(RESOLVE_TABLE_COMMAND_ID, async () => []);

    await fake.api.commands.execute(KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID);

    expect(fake.getLastQuickPick()).toBeUndefined();
    expect(fake.getMessages()).toHaveLength(1);
    expect(fake.getMessages()[0]?.kind).toBe("info");
  });

  test("selecting an entry is display-only for the MVP — no further command execution happens", async () => {
    const fake = activateFixture();
    fake.registerBridge(RESOLVE_TABLE_COMMAND_ID, async () => [
      { key: "ctrl+s", command: "editor.action.save", layer: "defaults" },
    ]);
    fake.setNextPick({ label: "ctrl+s — editor.action.save", detail: "source: defaults" });

    // Should resolve cleanly with no thrown error and no extra side
    // effect beyond having shown the picker (Req 11.7's "MVP:
    // display-only is acceptable").
    await expect(
      fake.api.commands.execute(KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID),
    ).resolves.toBeUndefined();
  });
});
