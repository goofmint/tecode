/**
 * Integration tests for `explorer`'s `activate(ctx)` (Task 3.3, Req 11.2)
 * — replaces the Task 3.2-era placeholder. A minimal fake `Tecode` (local
 * to this file, `@tecode/api` types only, matching `command-palette/
 * index.test.ts`'s `createFakeApi` house convention) stands in for the
 * real core, EXCEPT `workspace.fs`, which is backed by REAL `node:fs/
 * promises` calls against a real temp directory (this task's completion
 * requirement: "create/rename/delete against a temp dir") — `packages/
 * builtin/**` may not import `@tecode/core` even in its own tests (this
 * package's other `index.test.ts` files' own precedent), so this is a
 * small, local reimplementation of `@tecode/api`'s `FileSystem` contract
 * over real `node:fs`/`node:url`, not `@tecode/core`'s own
 * `buffer/fileSystem.ts`.
 *
 * **A `.tsx` file, not `.ts`**: several tests need a currently-SELECTED
 * node (rename/delete operate on `store.getSelectedId()`) — the only way
 * to set that from outside `activate`'s own closure is through the
 * registered view's `tecode.ui.Tree`'s `onSelect` prop, so this suite's
 * fake `ui.Tree` captures its own props (mirrors `ExplorerView.test.tsx`'s
 * `createFakeTree`) and `mountView`/`select` below actually mount the
 * registered component with `@opentui/react/test-utils`'s `testRender` to
 * reach it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { watch as nodeWatchFs, statSync } from "node:fs";
import {
  mkdir as nodeMkdir,
  mkdtemp,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  rename as nodeRename,
  rm,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import type {
  CommandHandler,
  ComponentType,
  ConfigChangeEvent,
  DirEntry,
  Disposable,
  ExtensionContext,
  FileChangeEvent,
  FileType,
  InputBoxOptions,
  Listener,
  MessageKind,
  QuickPickItem,
  QuickPickOptions,
  Tecode,
  Uri,
} from "@tecode/api";
import { activate } from "./index";
import {
  EXPLORER_DELETE_COMMAND_ID,
  EXPLORER_FOCUS_COMMAND_ID,
  EXPLORER_NEW_FILE_COMMAND_ID,
  EXPLORER_NEW_FOLDER_COMMAND_ID,
  EXPLORER_RENAME_COMMAND_ID,
  EXPLORER_SHOW_HIDDEN_CONFIG_KEY,
  EXPLORER_VIEW_ID,
} from "./manifest";

function uriToPath(uri: Uri): string {
  return fileURLToPath(uri);
}
function pathToUri(path: string): Uri {
  return pathToFileURL(path).href;
}

/** Waits for `predicate` to become true, polling — real `fs.watch`
 * delivery is not synchronous (matches `@tecode/core`'s `fileSystem.
 * test.ts`'s own `waitFor`). */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function classify(entry: { isDirectory(): boolean; isFile(): boolean }): FileType {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "unknown";
}

/** A REAL-filesystem-backed `FileSystem` (this module's TSDoc) — every
 * method is a thin `node:fs/promises` pass-through, mirroring (but not
 * importing) `@tecode/core`'s own `buffer/fileSystem.ts`. */
function createRealFs(): Tecode["workspace"]["fs"] {
  return {
    async read(uri) {
      return nodeReadFile(uriToPath(uri));
    },
    async write(uri, content) {
      await nodeWriteFile(uriToPath(uri), content);
    },
    async stat(uri) {
      const s = await nodeStat(uriToPath(uri));
      return { type: classify(s), size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
    },
    async readdir(uri) {
      const entries = await nodeReaddir(uriToPath(uri), { withFileTypes: true });
      return entries.map((entry): DirEntry => ({ name: entry.name, type: classify(entry) }));
    },
    watch(uri, listener: Listener<FileChangeEvent>): Disposable {
      const path = uriToPath(uri);
      let isDirectory = false;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        // Matches `fileSystem.ts`'s own fallback.
      }
      let disposed = false;
      let watcher: ReturnType<typeof nodeWatchFs>;
      try {
        watcher = nodeWatchFs(path, (eventType, filename) => {
          if (disposed) return;
          const name = typeof filename === "string" ? filename : undefined;
          const affectedPath = isDirectory && name ? join(path, name) : path;
          listener({ type: eventType === "change" ? "changed" : "created", uri: pathToUri(affectedPath) });
        });
      } catch {
        // Matches the real `FileSystem.watch`'s contract (`fileSystem.
        // ts`'s TSDoc): a setup failure (e.g. the path does not exist)
        // degrades to a no-op disposable rather than throwing.
        return { dispose() {} };
      }
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          watcher.close();
        },
      };
    },
    async delete(uri) {
      await rm(uriToPath(uri), { recursive: true });
    },
    async rename(oldUri, newUri) {
      await nodeRename(uriToPath(oldUri), uriToPath(newUri));
    },
    async mkdir(uri) {
      await nodeMkdir(uriToPath(uri));
    },
  };
}

/** A minimal fake `Tecode` (this module's TSDoc) — real `fs` (above), a
 * capturing fake `ui.Tree` (this module's TSDoc's "A `.tsx` file"), and an
 * in-memory fake for everything else `explorer`'s `activate` touches. */
function createFakeApi(rootUri: Uri | undefined) {
  const commandHandlers = new Map<string, CommandHandler>();
  const registeredViews = new Map<string, ComponentType>();
  const messages: Array<{ message: string; kind?: MessageKind }> = [];
  const configValues = new Map<string, unknown>([[EXPLORER_SHOW_HIDDEN_CONFIG_KEY, false]]);
  const configListeners = new Set<Listener<ConfigChangeEvent>>();
  let nextInputValue: string | undefined;
  let nextPick: QuickPickItem | undefined;
  let lastQuickPickOptions: QuickPickOptions | undefined;
  let lastValidateInput: ((value: string) => string | undefined) | undefined;
  let lastTreeProps: Record<string, unknown> | undefined;

  const commands: Tecode["commands"] = {
    register(id, handler) {
      commandHandlers.set(id, handler);
      return { dispose: () => commandHandlers.delete(id) };
    },
    async execute(id, ...args) {
      const handler = commandHandlers.get(id);
      if (!handler) return undefined;
      return handler(...args);
    },
    list: () => [],
  };

  // Renders each node's label as plain text (unlike a "capture-only" fake
  // that returns `null`) so tests that poll `captureCharFrame()` for a
  // filename (the watch-driven-refresh and `showHidden` suites below) can
  // actually observe the tree's current contents, not just its props.
  const Tree = ((rawProps: Record<string, unknown>) => {
    lastTreeProps = rawProps;
    const nodes = (rawProps["nodes"] as Array<{ id: string; label: string }> | undefined) ?? [];
    return (
      <box>
        {nodes.map((n) => (
          <text key={n.id}>{n.label}</text>
        ))}
      </box>
    );
  }) as unknown as Tecode["ui"]["Tree"];

  const api: Tecode = {
    commands,
    workspace: {
      rootUri,
      fs: createRealFs(),
      openDocument: async () => {
        throw new Error("not implemented in this fake");
      },
      documents: [],
      onDidOpen: () => ({ dispose() {} }),
      onDidClose: () => ({ dispose() {} }),
      onDidSave: () => ({ dispose() {} }),
      save: async () => {},
    } as unknown as Tecode["workspace"],
    window: {
      activeEditor: undefined,
      showMessage(message: string, kind?: MessageKind) {
        messages.push({ message, kind });
      },
      async showQuickPick(items: QuickPickItem[], options?: QuickPickOptions) {
        lastQuickPickOptions = options;
        void items;
        return nextPick;
      },
      async showInputBox(options?: InputBoxOptions) {
        lastValidateInput = options?.validateInput;
        return nextInputValue;
      },
      setStatusBarItem: () => ({ dispose() {} }),
    } as unknown as Tecode["window"],
    editor: undefined as never,
    ui: {
      registerView: (_slot, id, component) => {
        if (component) registeredViews.set(id, component);
        return { dispose: () => registeredViews.delete(id) };
      },
      useTheme: undefined as never,
      List: undefined as never,
      Tree,
      Input: undefined as never,
      Tabs: undefined as never,
    },
    config: {
      get: <T,>(key: string) => configValues.get(key) as T | undefined,
      onDidChange: (listener: Listener<ConfigChangeEvent>) => {
        configListeners.add(listener);
        return { dispose: () => configListeners.delete(listener) };
      },
    },
    context: {
      get: () => undefined,
      set: () => {},
    },
    languages: undefined as never,
    themes: undefined as never,
    clipboard: undefined as never,
  };

  return {
    api,
    getMessages: () => messages,
    getRegisteredView: () => registeredViews.get(EXPLORER_VIEW_ID),
    setNextInputValue: (value: string | undefined) => (nextInputValue = value),
    setNextPick: (pick: QuickPickItem | undefined) => (nextPick = pick),
    getLastQuickPickOptions: () => lastQuickPickOptions,
    getLastValidateInput: () => lastValidateInput,
    getLastTreeProps: () => lastTreeProps,
    setConfig: (key: string, value: unknown) => {
      configValues.set(key, value);
      for (const listener of configListeners) listener({ affectsConfiguration: (k) => k === key });
    },
  };
}

function createFixture(rootUri: Uri | undefined) {
  const fake = createFakeApi(rootUri);
  const subscriptions: Disposable[] = [];
  const ctx: ExtensionContext = {
    api: fake.api,
    extensionUri: rootUri ?? ("file:///nowhere/" as Uri),
    subscriptions,
    storagePath: "/tmp/tecode-explorer-test-storage",
  };
  activate(ctx);
  return {
    ...fake,
    dispose: () => {
      for (const sub of subscriptions.reverse()) sub.dispose();
    },
  };
}

/** Mount the registered view once (so its `tecode.ui.Tree` props get
 * captured — this module's TSDoc) and select `uri` through the captured
 * `onSelect` callback. The mount is disposed immediately after — selection
 * itself lives in `explorer`'s own store closure, not in this render, so
 * it survives the unmount (`store.ts`'s TSDoc). */
async function selectViaTree(
  fixture: ReturnType<typeof createFixture>,
  uri: string,
): Promise<void> {
  const Component = fixture.getRegisteredView() as unknown as (props: Record<string, unknown>) => ReactNode;
  const { renderer, renderOnce } = await testRender(<Component />, { width: 30, height: 10 });
  await renderOnce();
  const onSelect = fixture.getLastTreeProps()?.["onSelect"] as ((id: string) => void) | undefined;
  act(() => onSelect?.(uri));
  renderer.destroy();
}

describe("explorer activate() (Task 3.3, Req 11.2)", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("registers the sidebar view under EXPLORER_VIEW_ID", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
    const fixture = createFixture(pathToUri(dir));
    expect(fixture.getRegisteredView()).toBeDefined();
    fixture.dispose();
  });

  test("explorer.focus delegates to workbench.view.explorer", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
    const fixture = createFixture(pathToUri(dir));
    let focusedViewCalled = false;
    fixture.api.commands.register(`workbench.view.${EXPLORER_VIEW_ID}`, () => {
      focusedViewCalled = true;
    });
    await fixture.api.commands.execute(EXPLORER_FOCUS_COMMAND_ID);
    expect(focusedViewCalled).toBe(true);
    fixture.dispose();
  });

  describe("explorer.newFile", () => {
    test("creates an empty file at the workspace root and surfaces no error", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const fixture = createFixture(pathToUri(dir));
      fixture.setNextInputValue("new-file.ts");

      await fixture.api.commands.execute(EXPLORER_NEW_FILE_COMMAND_ID);
      await waitFor(() => {
        try {
          statSync(join(dir!, "new-file.ts"));
          return true;
        } catch {
          return false;
        }
      });

      expect(fixture.getMessages().filter((m) => m.kind === "error")).toEqual([]);
      fixture.dispose();
    });

    test("cancelling the input box (undefined) creates nothing", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const fixture = createFixture(pathToUri(dir));
      fixture.setNextInputValue(undefined);

      await fixture.api.commands.execute(EXPLORER_NEW_FILE_COMMAND_ID);

      const entries = await nodeReaddir(dir);
      expect(entries).toEqual([]);
      fixture.dispose();
    });

    test("validateInput rejects an empty name and accepts a normal one", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const fixture = createFixture(pathToUri(dir));
      fixture.setNextInputValue(undefined);

      await fixture.api.commands.execute(EXPLORER_NEW_FILE_COMMAND_ID);

      expect(fixture.getLastValidateInput()?.("")).toBeDefined();
      expect(fixture.getLastValidateInput()?.("ok.ts")).toBeUndefined();
      fixture.dispose();
    });

    test("validateInput rejects a name already present at the target directory", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      await nodeWriteFile(join(dir, "existing.ts"), "");
      const fixture = createFixture(pathToUri(dir));
      await waitFor(async () => (await nodeReaddir(dir!)).length > 0);
      await new Promise((r) => setTimeout(r, 50)); // let the store's own async reload settle

      fixture.setNextInputValue(undefined);
      await fixture.api.commands.execute(EXPLORER_NEW_FILE_COMMAND_ID);

      expect(fixture.getLastValidateInput()?.("existing.ts")).toBeDefined();
      fixture.dispose();
    });

    test("a write failure (nonexistent target directory) surfaces via showMessage error", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      // rootUri points somewhere that does not exist on disk at all —
      // `resolveTargetDirectory()` still resolves to it (nothing
      // selected), so the real `fs.write` call itself fails.
      const missingRoot = pathToUri(join(dir, "does-not-exist"));
      const fixture = createFixture(missingRoot);
      fixture.setNextInputValue("file.ts");

      await fixture.api.commands.execute(EXPLORER_NEW_FILE_COMMAND_ID);

      expect(fixture.getMessages().some((m) => m.kind === "error")).toBe(true);
      fixture.dispose();
    });

    test("no folder open (rootUri undefined) shows an info message instead of crashing", async () => {
      const fixture = createFixture(undefined);
      fixture.setNextInputValue("file.ts");

      await fixture.api.commands.execute(EXPLORER_NEW_FILE_COMMAND_ID);

      expect(fixture.getMessages().some((m) => m.kind === "info")).toBe(true);
      fixture.dispose();
    });

    test("validateInput rejects '.' and '..'", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const fixture = createFixture(pathToUri(dir));
      fixture.setNextInputValue(undefined);

      await fixture.api.commands.execute(EXPLORER_NEW_FILE_COMMAND_ID);

      expect(fixture.getLastValidateInput()?.(".")).toBeDefined();
      expect(fixture.getLastValidateInput()?.("..")).toBeDefined();
      fixture.dispose();
    });

    test("a '..' name is rejected even when it bypasses validateInput (a programmatic caller), never escaping the target directory", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const fixture = createFixture(pathToUri(dir));
      // The fake `showInputBox` above returns whatever was queued
      // regardless of `validateInput` — exactly the "bypasses the input
      // box's own validation" scenario the explicit re-check at the
      // `joinChildUri` call site guards against.
      fixture.setNextInputValue("..");

      await fixture.api.commands.execute(EXPLORER_NEW_FILE_COMMAND_ID);

      expect(fixture.getMessages().some((m) => m.kind === "error")).toBe(true);
      // Nothing was created — in particular, no `fs.write` call ever
      // reached the (would-be escaped) parent directory.
      expect(await nodeReaddir(dir)).toEqual([]);
      fixture.dispose();
    });
  });

  test("explorer.newFolder creates a real directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
    const fixture = createFixture(pathToUri(dir));
    fixture.setNextInputValue("new-dir");

    await fixture.api.commands.execute(EXPLORER_NEW_FOLDER_COMMAND_ID);
    await waitFor(() => {
      try {
        return statSync(join(dir!, "new-dir")).isDirectory();
      } catch {
        return false;
      }
    });
    fixture.dispose();
  });

  describe("explorer.rename", () => {
    test("no selection shows an info message", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const fixture = createFixture(pathToUri(dir));
      await fixture.api.commands.execute(EXPLORER_RENAME_COMMAND_ID);
      expect(fixture.getMessages().some((m) => m.kind === "info")).toBe(true);
      fixture.dispose();
    });

    test("renames a real file on disk and updates the selection to the new uri", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      await nodeWriteFile(join(dir, "old.ts"), "content");
      const fixture = createFixture(pathToUri(dir));
      await waitFor(async () => (await nodeReaddir(dir!)).length > 0);
      await new Promise((r) => setTimeout(r, 50));

      await selectViaTree(fixture, pathToUri(join(dir, "old.ts")));
      fixture.setNextInputValue("new.ts");

      await fixture.api.commands.execute(EXPLORER_RENAME_COMMAND_ID);
      await waitFor(() => {
        try {
          statSync(join(dir!, "new.ts"));
          return true;
        } catch {
          return false;
        }
      });

      expect(fixture.getMessages().filter((m) => m.kind === "error")).toEqual([]);
      const remaining = await nodeReaddir(dir);
      expect(remaining).toEqual(["new.ts"]);
      fixture.dispose();
    });

    test("a rename failure (the file vanished underneath) surfaces via showMessage error", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const filePath = join(dir, "vanishing.ts");
      await nodeWriteFile(filePath, "");
      const fixture = createFixture(pathToUri(dir));
      await waitFor(async () => (await nodeReaddir(dir!)).length > 0);
      await new Promise((r) => setTimeout(r, 50));

      await selectViaTree(fixture, pathToUri(filePath));
      await rm(filePath); // the store's cache is now stale — the real rename call must fail
      fixture.setNextInputValue("renamed.ts");

      await fixture.api.commands.execute(EXPLORER_RENAME_COMMAND_ID);

      expect(fixture.getMessages().some((m) => m.kind === "error")).toBe(true);
      fixture.dispose();
    });

    test("validateInput rejects '.' and '..'", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      await nodeWriteFile(join(dir, "old.ts"), "content");
      const fixture = createFixture(pathToUri(dir));
      await waitFor(async () => (await nodeReaddir(dir!)).length > 0);
      await new Promise((r) => setTimeout(r, 50));

      await selectViaTree(fixture, pathToUri(join(dir, "old.ts")));
      fixture.setNextInputValue(undefined);
      await fixture.api.commands.execute(EXPLORER_RENAME_COMMAND_ID);

      expect(fixture.getLastValidateInput()?.(".")).toBeDefined();
      expect(fixture.getLastValidateInput()?.("..")).toBeDefined();
      fixture.dispose();
    });

    test("a '..' name is rejected even when it bypasses validateInput, never escaping the parent directory", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      await nodeWriteFile(join(dir, "old.ts"), "content");
      const fixture = createFixture(pathToUri(dir));
      await waitFor(async () => (await nodeReaddir(dir!)).length > 0);
      await new Promise((r) => setTimeout(r, 50));

      await selectViaTree(fixture, pathToUri(join(dir, "old.ts")));
      // The fake `showInputBox` returns whatever was queued regardless of
      // `validateInput` — the "bypasses the input box's own validation"
      // scenario the explicit re-check at the `joinChildUri` call site
      // guards against.
      fixture.setNextInputValue("..");

      await fixture.api.commands.execute(EXPLORER_RENAME_COMMAND_ID);

      expect(fixture.getMessages().some((m) => m.kind === "error")).toBe(true);
      // The original file is untouched — no rename call ever reached the
      // (would-be escaped) grandparent directory.
      expect(await nodeReaddir(dir)).toEqual(["old.ts"]);
      fixture.dispose();
    });
  });

  describe("explorer.delete", () => {
    test("no selection shows an info message", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const fixture = createFixture(pathToUri(dir));
      await fixture.api.commands.execute(EXPLORER_DELETE_COMMAND_ID);
      expect(fixture.getMessages().some((m) => m.kind === "info")).toBe(true);
      fixture.dispose();
    });

    test("confirming deletes the real file on disk", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const filePath = join(dir, "doomed.ts");
      await nodeWriteFile(filePath, "");
      const fixture = createFixture(pathToUri(dir));
      await waitFor(async () => (await nodeReaddir(dir!)).length > 0);
      await new Promise((r) => setTimeout(r, 50));

      await selectViaTree(fixture, pathToUri(filePath));
      fixture.setNextPick({ label: "Delete", description: "confirm" });

      await fixture.api.commands.execute(EXPLORER_DELETE_COMMAND_ID);
      await waitFor(async () => !(await nodeReaddir(dir!)).includes("doomed.ts"));

      expect(fixture.getLastQuickPickOptions()?.placeHolder).toContain("doomed.ts");
      fixture.dispose();
    });

    test("cancelling leaves the file untouched", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const filePath = join(dir, "safe.ts");
      await nodeWriteFile(filePath, "");
      const fixture = createFixture(pathToUri(dir));
      await waitFor(async () => (await nodeReaddir(dir!)).length > 0);
      await new Promise((r) => setTimeout(r, 50));

      await selectViaTree(fixture, pathToUri(filePath));
      fixture.setNextPick({ label: "Cancel", description: "cancel" });

      await fixture.api.commands.execute(EXPLORER_DELETE_COMMAND_ID);

      const entries = await nodeReaddir(dir);
      expect(entries).toContain("safe.ts");
      fixture.dispose();
    });

    test("a delete failure (already gone) surfaces via showMessage error", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const filePath = join(dir, "already-gone.ts");
      await nodeWriteFile(filePath, "");
      const fixture = createFixture(pathToUri(dir));
      await waitFor(async () => (await nodeReaddir(dir!)).length > 0);
      await new Promise((r) => setTimeout(r, 50));

      await selectViaTree(fixture, pathToUri(filePath));
      await rm(filePath); // stale cache, as above
      fixture.setNextPick({ label: "Delete", description: "confirm" });

      await fixture.api.commands.execute(EXPLORER_DELETE_COMMAND_ID);

      expect(fixture.getMessages().some((m) => m.kind === "error")).toBe(true);
      fixture.dispose();
    });
  });

  describe("watch-driven refresh (Task 3.3, Req 11.2)", () => {
    test("an externally created file is picked up and shown without any command being run", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      const fixture = createFixture(pathToUri(dir));

      await nodeWriteFile(join(dir, "external.ts"), "");

      const Component = fixture.getRegisteredView() as unknown as (props: Record<string, unknown>) => ReactNode;
      const { renderOnce, captureCharFrame } = await testRender(<Component />, { width: 30, height: 10 });
      await waitFor(async () => {
        await act(async () => {
          await renderOnce();
        });
        return captureCharFrame().includes("external.ts");
      });

      expect(fixture.getMessages().filter((m) => m.kind === "error")).toEqual([]);
      fixture.dispose();
    });
  });

  describe("explorer.showHidden (Req 9.5)", () => {
    test("toggling the setting live reveals dotfiles without a restart", async () => {
      dir = await mkdtemp(join(tmpdir(), "tecode-explorer-"));
      await nodeWriteFile(join(dir, ".env"), "");
      await nodeWriteFile(join(dir, "visible.ts"), "");
      const fixture = createFixture(pathToUri(dir));

      const Component = fixture.getRegisteredView() as unknown as (props: Record<string, unknown>) => ReactNode;
      const { renderOnce, captureCharFrame } = await testRender(<Component />, { width: 30, height: 10 });
      await waitFor(async () => {
        await act(async () => {
          await renderOnce();
        });
        return captureCharFrame().includes("visible.ts");
      });
      expect(captureCharFrame()).not.toContain(".env");

      act(() => fixture.setConfig(EXPLORER_SHOW_HIDDEN_CONFIG_KEY, true));
      await waitFor(async () => {
        await act(async () => {
          await renderOnce();
        });
        return captureCharFrame().includes(".env");
      });

      expect(fixture.getMessages().filter((m) => m.kind === "error")).toEqual([]);
      fixture.dispose();
    });
  });
});
