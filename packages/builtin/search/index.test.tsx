/**
 * Integration tests for `search`'s `activate(ctx)` (Issue #147). A minimal
 * fake `Tecode` (local to this file, `@tecode/api` types only — the house
 * convention `../explorer/index.test.tsx` and `../command-palette/
 * index.test.ts` already follow) stands in for the real core, EXCEPT
 * `workspace.fs`, which is backed by REAL `node:fs/promises` calls against
 * a real temp directory: this extension's whole job is reading a real
 * workspace, so faking the filesystem would fake away the thing under
 * test.
 *
 * **A `.tsx` file, not `.ts`**: the query text and the result activation
 * both arrive through the REGISTERED VIEW's injected `tecode.ui.Input`/
 * `Tree` props, so every test here mounts the registered component with
 * `@opentui/react/test-utils`'s `testRender` to reach them (mirrors
 * `../explorer/index.test.tsx`'s own "A `.tsx` file, not `.ts`"
 * paragraph).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile as nodeReadFile, readdir as nodeReaddir, rm, writeFile } from "node:fs/promises";
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
  FileType,
  Listener,
  MessageKind,
  Selection,
  Tecode,
  Uri,
} from "@tecode/api";
import { activate } from "./index";
import {
  SEARCH_CASE_SENSITIVE_CONFIG_KEY,
  SEARCH_FOCUS_COMMAND_ID,
  SEARCH_MAX_RESULTS_CONFIG_KEY,
  SEARCH_REFRESH_COMMAND_ID,
  SEARCH_TOGGLE_MODE_COMMAND_ID,
  SEARCH_VIEW_ID,
} from "./manifest";

/** `@tecode/core`'s `ui/openFileCommand.ts`'s own `OPEN_FILE_COMMAND_ID` —
 * a hand-kept duplicate, matching `index.ts`'s own (this package may never
 * import `@tecode/core`). */
const OPEN_FILE_COMMAND_ID = "workbench.action.files.openUri";
const FOCUS_SIDEBAR_VIEW_COMMAND_ID = `workbench.view.${SEARCH_VIEW_ID}`;

function pathToUri(path: string): Uri {
  return pathToFileURL(path).href;
}

function classify(entry: { isDirectory(): boolean; isFile(): boolean }): FileType {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "unknown";
}

/** A REAL-filesystem-backed slice of `@tecode/api`'s `FileSystem` — only
 * the two methods this extension actually calls; every other member throws
 * if something ever reaches for it, rather than silently pretending. */
function createRealFs(): Tecode["workspace"]["fs"] {
  return {
    async read(uri: Uri) {
      return new Uint8Array(await nodeReadFile(fileURLToPath(uri)));
    },
    async readdir(uri: Uri) {
      const entries = await nodeReaddir(fileURLToPath(uri), { withFileTypes: true });
      return entries.map((entry): DirEntry => ({ name: entry.name, type: classify(entry) }));
    },
  } as unknown as Tecode["workspace"]["fs"];
}

interface CapturedProps {
  input?: Record<string, unknown>;
  tree?: Record<string, unknown>;
}

function createFakeApi(rootUri: Uri | undefined) {
  const commandHandlers = new Map<string, CommandHandler>();
  const executed: Array<{ id: string; args: unknown[] }> = [];
  const registeredViews = new Map<string, ComponentType>();
  const messages: Array<{ message: string; kind?: MessageKind }> = [];
  const selections: Selection[][] = [];
  const configValues = new Map<string, unknown>();
  const configListeners = new Set<Listener<ConfigChangeEvent>>();
  const captured: CapturedProps = {};

  const Input = ((rawProps: Record<string, unknown>) => {
    captured.input = rawProps;
    return (<text>{typeof rawProps["value"] === "string" ? rawProps["value"] : ""}</text>) as unknown as ReactNode;
  }) as unknown as Tecode["ui"]["Input"];

  const Tree = ((rawProps: Record<string, unknown>) => {
    captured.tree = rawProps;
    const nodes = (rawProps["nodes"] as Array<{ id: string; label: string }> | undefined) ?? [];
    return (
      <box>
        {nodes.map((n) => (
          <text key={n.id}>{n.label}</text>
        ))}
      </box>
    ) as unknown as ReactNode;
  }) as unknown as Tecode["ui"]["Tree"];

  const api: Tecode = {
    commands: {
      register(id, handler) {
        commandHandlers.set(id, handler);
        return { dispose: () => commandHandlers.delete(id) };
      },
      async execute(id, ...args) {
        executed.push({ id, args });
        const handler = commandHandlers.get(id);
        if (!handler) return undefined;
        return handler(...args);
      },
      list: () => [],
    },
    workspace: {
      rootUri,
      fs: createRealFs(),
    } as unknown as Tecode["workspace"],
    window: {
      showMessage(message: string, kind?: MessageKind) {
        messages.push({ message, kind });
      },
    } as unknown as Tecode["window"],
    editor: {
      setSelections(next: readonly Selection[]) {
        selections.push([...next]);
      },
    } as unknown as Tecode["editor"],
    ui: {
      registerView: (_slot, id, component) => {
        if (component) registeredViews.set(id, component);
        return { dispose: () => registeredViews.delete(id) };
      },
      useTheme: undefined as never,
      List: undefined as never,
      Tree,
      Input,
      Tabs: undefined as never,
      Terminal: undefined as never,
    },
    config: {
      get: <T,>(key: string) => configValues.get(key) as T | undefined,
      onDidChange: (listener: Listener<ConfigChangeEvent>) => {
        configListeners.add(listener);
        return { dispose: () => configListeners.delete(listener) };
      },
    },
    context: { get: () => undefined, set: () => {} },
    languages: undefined as never,
    themes: undefined as never,
    clipboard: undefined as never,
    terminal: undefined as never,
  };

  return {
    api,
    captured,
    getExecuted: () => executed,
    getMessages: () => messages,
    getSelections: () => selections,
    hasCommand: (id: string) => commandHandlers.has(id),
    runCommand: async (id: string, ...args: unknown[]) => {
      const handler = commandHandlers.get(id);
      if (!handler) throw new Error(`command not registered: ${id}`);
      return handler(...args);
    },
    registerExternalCommand: (id: string, handler: CommandHandler) => commandHandlers.set(id, handler),
    getRegisteredView: () => registeredViews.get(SEARCH_VIEW_ID),
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
    storagePath: "/tmp/tecode-search-test-storage",
  };
  activate(ctx);
  return {
    ...fake,
    subscriptions,
    dispose: () => {
      for (const sub of subscriptions.reverse()) sub.dispose();
    },
  };
}

/** Mounts the registered view so its injected `Input`/`Tree` props get
 * captured, and returns a handle for driving them. */
async function mountView(fixture: ReturnType<typeof createFixture>) {
  const Component = fixture.getRegisteredView();
  if (!Component) throw new Error("the search view was never registered");
  const render = Component as unknown as (props: Record<string, unknown>) => ReactNode;
  const { renderOnce, captureCharFrame } = await testRender(<>{render({})}</>, { width: 60, height: 20 });
  await renderOnce();
  return { renderOnce, captureCharFrame };
}

function call<T extends unknown[]>(props: Record<string, unknown> | undefined, name: string, ...args: T): void {
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`expected a ${name} callback`);
  (handler as (...a: T) => void)(...args);
}

/** The nodes the view last handed to the fake `tecode.ui.Tree` — `[]`
 * before it has ever rendered one (`SearchView.tsx` renders no `Tree` at
 * all while there are no results). */
function treeNodes(
  fixture: ReturnType<typeof createFixture>,
): Array<{ id: string; label: string; children?: Array<{ id: string }> }> {
  return (
    (fixture.captured.tree?.["nodes"] as Array<{ id: string; label: string; children?: Array<{ id: string }> }>) ?? []
  );
}

/**
 * Re-renders until `predicate` holds, or fails with `description` once
 * `timeoutMs` elapses (CodeRabbit, PR #153). A search started through the
 * view runs asynchronously over a REAL temp workspace — a walk, a `git`
 * availability probe, and one `read` per file — so a fixed sleep can only
 * ever be a guess; polling makes the wait as long as the machine actually
 * needs and turns a genuine hang into a clear failure instead of a flaky
 * assertion. Matches `../explorer/index.test.tsx`'s own `waitFor`, with
 * the extra `renderOnce()` this suite needs to refresh the captured props.
 */
async function waitForRender(
  renderOnce: () => Promise<unknown>,
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    await act(async () => {
      await renderOnce();
    });
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitForRender: timed out waiting for ${description}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

const tempDirs: string[] = [];

async function createWorkspace(files: Record<string, string>): Promise<Uri> {
  const dir = await mkdtemp(join(tmpdir(), "tecode-search-"));
  tempDirs.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const full = join(dir, relative);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return pathToUri(dir);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("search activate (Issue #147)", () => {
  test("registers the sidebar view and every declared command", () => {
    const fixture = createFixture("file:///nowhere/");
    expect(fixture.getRegisteredView()).toBeDefined();
    expect(fixture.hasCommand(SEARCH_FOCUS_COMMAND_ID)).toBe(true);
    expect(fixture.hasCommand(SEARCH_TOGGLE_MODE_COMMAND_ID)).toBe(true);
    expect(fixture.hasCommand(SEARCH_REFRESH_COMMAND_ID)).toBe(true);
    fixture.dispose();
    expect(fixture.getRegisteredView()).toBeUndefined();
    expect(fixture.hasCommand(SEARCH_FOCUS_COMMAND_ID)).toBe(false);
  });

  test("search.focus reveals the view through the host's workbench.view.search command", async () => {
    const fixture = createFixture("file:///nowhere/");
    await fixture.runCommand(SEARCH_FOCUS_COMMAND_ID);
    expect(fixture.getExecuted().map((e) => e.id)).toEqual([FOCUS_SIDEBAR_VIEW_COMMAND_ID]);
    fixture.dispose();
  });

  test("search.toggleMode switches the view between filename and full-text search", async () => {
    const root = await createWorkspace({ "a.ts": "" });
    const fixture = createFixture(root);
    const { renderOnce } = await mountView(fixture);
    expect(fixture.captured.input?.["placeholder"]).toBe("Search file names");

    await act(async () => {
      await fixture.runCommand(SEARCH_TOGGLE_MODE_COMMAND_ID);
    });
    await renderOnce();
    expect(fixture.captured.input?.["placeholder"]).toBe("Search in files");
    fixture.dispose();
  });

  test("filename search over a real workspace opens the activated file", async () => {
    const root = await createWorkspace({ "src/alpha.ts": "", "src/beta.ts": "" });
    const fixture = createFixture(root);
    const { renderOnce } = await mountView(fixture);

    await act(async () => {
      call(fixture.captured.input, "onChange", "alpha");
    });
    await waitForRender(renderOnce, () => treeNodes(fixture).length > 0, "the filename results");

    const nodes = treeNodes(fixture);
    expect(nodes.map((n) => n.label)).toEqual(["src/alpha.ts"]);

    await act(async () => {
      call(fixture.captured.tree, "onActivate", nodes[0]?.id ?? "");
    });
    await waitForRender(renderOnce, () => fixture.getExecuted().length > 0, "the open-file command");
    expect(fixture.getExecuted()).toEqual([{ id: OPEN_FILE_COMMAND_ID, args: [nodes[0]?.id] }]);
    // A filename result carries no position, so no cursor move.
    expect(fixture.getSelections()).toEqual([]);
    fixture.dispose();
  });

  test("full-text search opens the file AND moves the cursor onto the hit", async () => {
    const root = await createWorkspace({ "a.ts": "first\nsecond needle here\n" });
    const fixture = createFixture(root);
    const { renderOnce } = await mountView(fixture);

    await act(async () => {
      await fixture.runCommand(SEARCH_TOGGLE_MODE_COMMAND_ID);
      call(fixture.captured.input, "onChange", "needle");
      call(fixture.captured.input, "onSubmit", "needle");
    });
    await waitForRender(renderOnce, () => treeNodes(fixture).length > 0, "the full-text results");

    const nodes = treeNodes(fixture);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.label).toBe("a.ts (1)");

    const hitId = nodes[0]?.children?.[0]?.id ?? "";
    await act(async () => {
      call(fixture.captured.tree, "onActivate", hitId);
    });
    await waitForRender(renderOnce, () => fixture.getSelections().length > 0, "the cursor move");

    expect(fixture.getExecuted().map((e) => e.id)).toEqual([OPEN_FILE_COMMAND_ID]);
    const position = { line: 1, character: 7 };
    expect(fixture.getSelections()).toEqual([
      [{ start: position, end: position, anchor: position, active: position }],
    ]);
    fixture.dispose();
  });

  test("search.caseSensitive applies live, with no restart", async () => {
    const root = await createWorkspace({ "a.ts": "Needle\n" });
    const fixture = createFixture(root);
    const { renderOnce, captureCharFrame } = await mountView(fixture);

    await act(async () => {
      await fixture.runCommand(SEARCH_TOGGLE_MODE_COMMAND_ID);
      call(fixture.captured.input, "onChange", "needle");
      call(fixture.captured.input, "onSubmit", "needle");
    });
    await waitForRender(renderOnce, () => treeNodes(fixture).length === 1, "the case-insensitive hit");

    await act(async () => {
      fixture.setConfig(SEARCH_CASE_SENSITIVE_CONFIG_KEY, true);
    });
    // With no results the view renders no `Tree` at all (`SearchView.tsx`),
    // so the STATUS row — not the last captured tree props, which are now
    // stale by design — is what reports the re-run's outcome.
    await waitForRender(
      renderOnce,
      () => captureCharFrame().includes("No results"),
      "the case-sensitive re-run to report no results",
    );
    fixture.dispose();
  });

  test("search.maxResults applies live to the next search", async () => {
    const root = await createWorkspace({ "a1.ts": "", "a2.ts": "", "a3.ts": "" });
    const fixture = createFixture(root);
    const { renderOnce } = await mountView(fixture);

    await act(async () => {
      fixture.setConfig(SEARCH_MAX_RESULTS_CONFIG_KEY, 2);
      call(fixture.captured.input, "onChange", "a");
    });
    await waitForRender(renderOnce, () => treeNodes(fixture).length > 0, "the capped results");
    expect(treeNodes(fixture)).toHaveLength(2);
    fixture.dispose();
  });

  test("search.refresh picks up a file created after the first search", async () => {
    const root = await createWorkspace({ "a1.ts": "" });
    const fixture = createFixture(root);
    const { renderOnce } = await mountView(fixture);

    await act(async () => {
      call(fixture.captured.input, "onChange", "a");
    });
    await waitForRender(renderOnce, () => treeNodes(fixture).length === 1, "the first search's single result");

    await writeFile(join(fileURLToPath(root), "a2.ts"), "");
    await act(async () => {
      await fixture.runCommand(SEARCH_REFRESH_COMMAND_ID);
    });
    await waitForRender(renderOnce, () => treeNodes(fixture).length === 2, "the refreshed results");
    fixture.dispose();
  });

  test("no workspace root degrades to an empty, never-throwing view", async () => {
    const fixture = createFixture(undefined);
    const { renderOnce } = await mountView(fixture);
    // No polling needed here, unlike every search above: with no workspace
    // root the store clears synchronously and never starts any async work
    // at all (`store.ts`'s `startSearch`), so there is nothing to wait for.
    await act(async () => {
      call(fixture.captured.input, "onChange", "anything");
    });
    await renderOnce();
    expect(fixture.captured.tree).toBeUndefined();
    expect(fixture.getMessages()).toEqual([]);
    fixture.dispose();
  });
});
