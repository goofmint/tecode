/**
 * Contract tests for `createTecodeApi` (Req 10.1, 10.2; design.md §12, §16;
 * Task 1.13) — design.md §16's "compatibility gate for `API_VERSION`
 * bumps": "a test harness activates a fixture extension against the real
 * core and asserts every `tecode.*` namespace behaves per its documented
 * contract (register/dispose symmetry, event firing order, freeze-ness)."
 * A future `API_VERSION` bump (`host/validate.ts`'s
 * `checkApiVersionCompatibility`) that changes what a namespace guarantees
 * should break a test in this file first, before it ever reaches a real
 * extension.
 *
 * The composition root below (`buildRoot`) is assembled by hand from the
 * real services — `createCommandRegistry`, `createDocumentManager`,
 * `createConfigService`, `createContextService`, `createFileSystem` — the
 * same shape `cli/main.ts`'s startup wiring (Task 1.15) will eventually
 * build, rather than fakes: this suite exists specifically to catch
 * integration-level wiring mistakes a per-service unit test cannot see.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, Tecode } from "@tecode/api";
import { createCommandRegistry } from "../commands/registry";
import { createDocumentManager, type DocumentManager } from "../buffer/documentManager";
import { createFileSystem } from "../buffer/fileSystem";
import { pathToUri } from "../buffer/uri";
import { createConfigService, type ConfigService } from "../config/service";
import { createContextService } from "../keymap/context";
import { createHostLog, type HostError } from "../host/errors";
import type { ExtensionModule } from "../host/activation";
import { createEditorSessionService } from "../ui/editorSession";
import { createTecodeApi } from "./create";
import { registerTecodeAlias } from "./alias";

/** A `StatusSink` stub that records every error it receives (matches
 * `commands/registry.test.ts`'s `createRecordingSink`). */
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

interface Root {
  api: Tecode;
  errors: HostError[];
  documents: DocumentManager;
  config: ConfigService;
}

/**
 * Build a full composition root from the real services (no fakes).
 * `workspaceRoot` doubles as the redirected user-config directory
 * (`HOME`/`APPDATA`) for the duration of `createConfigService`'s
 * construction, so this suite never reads or watches the real user's
 * `~/.config/tecode` files (matches `config/service.test.ts`'s
 * real-filesystem integration test).
 */
async function buildRoot(workspaceRoot: string): Promise<Root> {
  const log = createHostLog();
  const { errors, sink } = createRecordingSink();
  const commands = createCommandRegistry({ log, sink });
  const documents = createDocumentManager({ log, sink });
  const fs = createFileSystem({ log });

  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = workspaceRoot;
  process.env["APPDATA"] = workspaceRoot;
  let config: ConfigService;
  try {
    config = createConfigService({ log, sink, workspaceRoot });
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }
  await config.ready;

  const context = createContextService();

  const api = createTecodeApi({
    commands,
    documents,
    fs,
    rootUri: pathToUri(workspaceRoot),
    config,
    context,
    sink,
  });

  return { api, errors, documents, config };
}

/** A fixture extension module (Req 2.6's `activate(ctx)`/`deactivate()`
 * shape) that touches all nine `tecode.*` namespaces through `ctx.api`,
 * pushing every subscription it creates onto `ctx.subscriptions` — the
 * same disposal contract `host/activation.ts`'s `disposeSubscriptions`
 * relies on — and records a breadcrumb per namespace into `events` so the
 * test can assert every one was actually reached. */
function createFixtureExtensionModule(events: string[]): ExtensionModule {
  return {
    async activate(ctx: ExtensionContext) {
      const { api } = ctx;

      // commands
      let executed = 0;
      const commandSub = api.commands.register("fixture.contract.activate", () => {
        executed += 1;
      });
      ctx.subscriptions.push(commandSub);
      await api.commands.execute("fixture.contract.activate");
      events.push(`commands:executed=${executed},list=${api.commands.list().length}`);

      // workspace
      const openSub = api.workspace.onDidOpen((doc) => events.push(`workspace.onDidOpen:${doc.uri}`));
      ctx.subscriptions.push(openSub);
      events.push(`workspace.rootUri:${api.workspace.rootUri ?? "none"}`);
      events.push(`workspace.documents:${api.workspace.documents.length}`);
      events.push(`workspace.fs:${typeof api.workspace.fs.read}`);

      // window
      api.window.showMessage("hello from the fixture extension");
      events.push(`window.activeEditor:${String(api.window.activeEditor)}`);
      const statusBarSub = api.window.setStatusBarItem({
        id: "fixture.contract.status",
        text: "fixture",
        side: "left",
        priority: 0,
      });
      ctx.subscriptions.push(statusBarSub);

      // editor
      events.push(`editor.selections:${api.editor.selections.length}`);
      events.push(`editor.cursor:${api.editor.cursor.line},${api.editor.cursor.character}`);
      api.editor.revealLine(1);
      api.editor.insertSnippet("fixture-snippet");
      api.editor.applyEdits([]);

      // ui
      const viewSub = api.ui.registerView("sidebar.view", "fixture.contract.view", () => undefined);
      ctx.subscriptions.push(viewSub);
      events.push(`ui.useTheme:${typeof api.ui.useTheme().colors}`);

      // config
      events.push(`config.get:${String(api.config.get("fixture.contract.key"))}`);
      const configSub = api.config.onDidChange(() => events.push("config.onDidChange"));
      ctx.subscriptions.push(configSub);

      // context
      api.context.set("fixture.contract.flag", true);
      events.push(`context.get:${String(api.context.get("fixture.contract.flag"))}`);

      // languages
      const languageSub = api.languages.register({
        id: "fixture-contract-lang",
        extensions: [".fxc"],
        grammar: "g.wasm",
        highlights: "h.scm",
      });
      ctx.subscriptions.push(languageSub);
      events.push(`languages.getLanguageId:${api.languages.getLanguageId("file:///a.fxc")}`);

      // themes
      const themeSub = api.themes.register({
        id: "fixture-contract-theme",
        label: "Fixture Contract Theme",
        path: "theme.json",
      });
      ctx.subscriptions.push(themeSub);
      events.push(`themes.current:${typeof api.themes.current.colors}`);

      events.push("activate:done");
    },
    deactivate() {
      events.push("deactivate:done");
    },
  };
}

describe("createTecodeApi — contract tests (design.md §16 compatibility gate)", () => {
  let dir: string;
  let root: Root | undefined;

  afterEach(async () => {
    root?.config.dispose();
    root = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("every tecode.* namespace is reachable via ctx.api and identical via the 'tecode' module alias", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-api-contract-"));
    root = await buildRoot(dir);
    const { api } = root;

    registerTecodeAlias(api);
    // A dynamic import is required here, not a static one: a static
    // `import ... from "tecode"` at the top of this file would resolve
    // before `registerTecodeAlias` above ever runs, since ES module
    // imports are hoisted and resolved at module-load time — Bun's
    // virtual-module binding would not exist yet. This is the one
    // sanctioned dynamic `import()` in a test file; the specifier is
    // `"tecode"`, not the `"@tecode/core"` literal `eslint.config.mjs`'s
    // `no-restricted-syntax` rule bans, so the layering rule does not
    // apply to it.
    const tecodeModule = await import("tecode");

    expect(tecodeModule.commands).toBe(api.commands);
    expect(tecodeModule.workspace).toBe(api.workspace);
    expect(tecodeModule.window).toBe(api.window);
    expect(tecodeModule.editor).toBe(api.editor);
    expect(tecodeModule.ui).toBe(api.ui);
    expect(tecodeModule.config).toBe(api.config);
    expect(tecodeModule.context).toBe(api.context);
    expect(tecodeModule.languages).toBe(api.languages);
    expect(tecodeModule.themes).toBe(api.themes);
  });

  test("the aggregate object and every namespace are frozen (mutation throws in strict mode)", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-api-contract-"));
    root = await buildRoot(dir);
    const { api } = root;

    expect(Object.isFrozen(api)).toBe(true);
    for (const namespace of Object.values(api)) {
      expect(Object.isFrozen(namespace)).toBe(true);
    }

    // This is a runtime behavior (`Object.freeze` + strict-mode assignment
    // throwing `TypeError`), not something the type system is meant to
    // catch on its own — every mutation attempt below is cast through
    // `Record<string, unknown>` deliberately, so the type checker's
    // ordinary readonly/void-return leniency (e.g. any function is
    // assignable where a `void`-returning one is expected) can't mask
    // whether the *runtime* freeze actually held.
    const mutableApi = api as unknown as Record<string, unknown>;
    expect(() => {
      mutableApi["commands"] = {};
    }).toThrow(TypeError);

    const mutableCommands = api.commands as unknown as Record<string, unknown>;
    expect(() => {
      mutableCommands["register"] = () => {};
    }).toThrow(TypeError);

    const mutableEditor = api.editor as unknown as Record<string, unknown>;
    expect(() => {
      mutableEditor["revealLine"] = () => {};
    }).toThrow(TypeError);
  });

  test("commands: register/dispose symmetry — a disposed command reports 'not found' on execute", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-api-contract-"));
    root = await buildRoot(dir);
    const { api, errors } = root;

    let calls = 0;
    const sub = api.commands.register("fixture.contract.symmetry", () => {
      calls += 1;
    });

    await api.commands.execute("fixture.contract.symmetry");
    expect(calls).toBe(1);

    sub.dispose();
    const result = await api.commands.execute("fixture.contract.symmetry");

    expect(result).toBeUndefined();
    expect(calls).toBe(1); // did not fire again
    expect(errors.some((e) => e.message.includes("fixture.contract.symmetry"))).toBe(true);
    expect(() => sub.dispose()).not.toThrow(); // idempotent
  });

  test("workspace.onDidOpen -> onDidSave -> onDidClose fire in that order for a real document", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-api-contract-"));
    root = await buildRoot(dir);
    const { api, documents } = root;
    const filePath = join(dir, "doc.txt");
    await writeFile(filePath, "hello", "utf8");
    const uri = pathToUri(filePath);

    const events: string[] = [];
    const openSub = api.workspace.onDidOpen((doc) => events.push(`open:${doc.uri}`));
    const saveSub = api.workspace.onDidSave((doc) => events.push(`save:${doc.uri}`));
    const closeSub = api.workspace.onDidClose((doc) => events.push(`close:${doc.uri}`));

    const doc = await api.workspace.openDocument(uri);
    expect(api.workspace.documents).toContain(doc);

    // `workspace.close` has no public `WorkspaceNamespace` counterpart (Req
    // 10.1 lists no such method), so this test drives the underlying
    // `DocumentManager` directly for it; `workspace.save` (Req 11.1, Task
    // 2.3) IS public now — exercised through `api.workspace.save` itself to
    // prove the real namespace method (not just the underlying manager) is
    // correctly wired and fires `onDidSave`.
    await api.workspace.save(uri);
    documents.close(uri);

    expect(events).toEqual([`open:${uri}`, `save:${uri}`, `close:${uri}`]);

    openSub.dispose();
    saveSub.dispose();
    closeSub.dispose();

    // Register/dispose symmetry: none of the disposed listeners fire again.
    await api.workspace.openDocument(uri);
    expect(events).toHaveLength(3);
  });

  test("editor calls with no active editor no-op and deliver a HostError to the injected sink", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-api-contract-"));
    root = await buildRoot(dir);
    const { api, errors } = root;

    expect(api.editor.selections).toEqual([]);
    expect(api.editor.cursor).toEqual({ line: 0, character: 0 });

    const before = errors.length;
    api.editor.revealLine(2);
    api.editor.insertSnippet("snippet");
    api.editor.applyEdits([]);

    const newErrors = errors.slice(before);
    expect(newErrors).toHaveLength(3);
    expect(newErrors.every((e) => e.message.startsWith("No active editor"))).toBe(true);
  });

  test("a fixture extension touches every ctx.api namespace without throwing, then deactivates cleanly", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-api-contract-"));
    root = await buildRoot(dir);
    const { api } = root;

    const events: string[] = [];
    const extensionModule = createFixtureExtensionModule(events);
    const ctx: ExtensionContext = {
      api,
      extensionUri: pathToUri(join(dir, "fixture-ext")),
      subscriptions: [],
      storagePath: join(dir, ".tecode-storage", "fixture-ext"),
    };

    await extensionModule.activate?.(ctx);

    expect(events).toContain("activate:done");
    expect(events).toContain("commands:executed=1,list=1");
    expect(events.some((e) => e.startsWith("workspace.rootUri:"))).toBe(true);
    expect(events).toContain("editor.selections:0");
    expect(events.some((e) => e.startsWith("ui.useTheme:object"))).toBe(true);
    expect(events).toContain("languages.getLanguageId:plaintext");
    expect(events.some((e) => e.startsWith("themes.current:object"))).toBe(true);
    expect(events).toContain("context.get:true");

    // Deactivation (matches host/activation.ts's disposeSubscriptions:
    // reverse push order), then the module's deactivate().
    for (let i = ctx.subscriptions.length - 1; i >= 0; i--) {
      ctx.subscriptions[i]?.dispose();
    }
    await extensionModule.deactivate?.();

    expect(events).toContain("deactivate:done");

    // Register/dispose symmetry: the fixture's command is gone post-teardown.
    const result = await api.commands.execute("fixture.contract.activate");
    expect(result).toBeUndefined();
  });
});

describe("createTecodeApi — real editor.* backing via editorSession (Req 6.5, 6.6, 11.1, Task 2.3)", () => {
  let dir: string;
  let config: ConfigService | undefined;

  afterEach(async () => {
    config?.dispose();
    config = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("editor/window.activeEditor read the real active document and selections once one is open", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-api-contract-editor-"));
    const filePath = join(dir, "doc.txt");
    await writeFile(filePath, "hello\nworld", "utf8");
    const uri = pathToUri(filePath);

    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });
    const documents = createDocumentManager({ log, sink });
    const fs = createFileSystem({ log });
    config = createConfigService({ log, sink, workspaceRoot: dir });
    await config.ready;
    const context = createContextService();
    const editorSession = createEditorSessionService({ documents });

    const api = createTecodeApi({
      commands,
      documents,
      fs,
      rootUri: pathToUri(dir),
      config,
      context,
      sink,
      editorSession,
    });

    // Before anything is open: identical to the no-editorSession stub
    // contract (this file's earlier "no active editor" test).
    expect(api.editor.selections).toEqual([]);
    expect(api.editor.lineCount).toBe(0);
    expect(api.editor.getLine(0)).toBe("");
    expect(api.window.activeEditor).toBeUndefined();

    await api.workspace.openDocument(uri);

    // `EditorSessionService`'s active-document policy (`ui/editorSession.ts`)
    // makes the freshly opened document active synchronously.
    expect(api.window.activeEditor?.document.uri).toBe(uri);
    expect(api.editor.lineCount).toBe(2);
    expect(api.editor.getLine(0)).toBe("hello");
    expect(api.editor.getLine(1)).toBe("world");
    expect(api.editor.selections).toEqual([
      { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } },
    ]);

    const newPos = { line: 1, character: 3 };
    api.editor.setSelections([{ start: newPos, end: newPos, anchor: newPos, active: newPos }]);
    expect(api.editor.cursor).toEqual(newPos);
    expect(api.window.activeEditor?.selections[0]?.active).toEqual(newPos);

    // `window.activeEditor.document` is the real `Document` — `applyEdits`/
    // `transaction` work exactly as `editor-core`'s command handlers need
    // (design.md §13's "pure command handlers over tecode.editor + document.
    // transaction").
    api.window.activeEditor?.document.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "X" },
    ]);
    expect(api.editor.getLine(0)).toBe("Xhello");

    // Finding 2: `api.editor.selections[0]`/`api.editor.cursor`/
    // `api.window.activeEditor.selections[0]` are deep copies — mutating one
    // must not reach back into `EditorSessionService` state or bypass
    // `setSelections`.
    const liveSelection = api.editor.selections[0]!;
    liveSelection.active.character = 999;
    liveSelection.start.line = 999;
    const liveCursor = api.editor.cursor;
    liveCursor.character = 999;
    const liveWindowSelection = api.window.activeEditor?.selections[0];
    liveWindowSelection!.active.character = 999;

    expect(api.editor.selections[0]?.active).toEqual(newPos);
    expect(api.editor.cursor).toEqual(newPos);
    expect(api.window.activeEditor?.selections[0]?.active).toEqual(newPos);
  });

  test("workspace.save persists to disk and clears dirty through the real API", async () => {
    dir = await mkdtemp(join(tmpdir(), "tecode-api-contract-editor-"));
    const filePath = join(dir, "save.txt");
    await writeFile(filePath, "before", "utf8");
    const uri = pathToUri(filePath);

    const log = createHostLog();
    const { sink } = createRecordingSink();
    const commands = createCommandRegistry({ log, sink });
    const documents = createDocumentManager({ log, sink });
    const fs = createFileSystem({ log });
    config = createConfigService({ log, sink, workspaceRoot: dir });
    await config.ready;
    const context = createContextService();
    const editorSession = createEditorSessionService({ documents });

    const api = createTecodeApi({
      commands,
      documents,
      fs,
      rootUri: pathToUri(dir),
      config,
      context,
      sink,
      editorSession,
    });

    const doc = await api.workspace.openDocument(uri);
    doc.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "X" },
    ]);
    expect(doc.dirty).toBe(true);

    await api.workspace.save(uri);

    expect(doc.dirty).toBe(false);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(filePath, "utf8")).toBe("Xbefore");
  });
});
