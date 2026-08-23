/**
 * `explorer`'s `activate(ctx)`/`deactivate()` (Task 3.3, Req 11.2;
 * design.md §13's `explorer` design). Builds one {@link ExplorerStore} per
 * activation (`./store.ts`), registers `ExplorerView` into `"sidebar.view"`
 * (`./ExplorerView.tsx`), subscribes `workspace.fs.watch` to keep the tree
 * live, and implements the five commands `manifest.ts` declares
 * (`focus`/`newFile`/`newFolder`/`rename`/`delete`) over `showInputBox`/
 * `showQuickPick`. Only imports `@tecode/api` plus this package's own
 * local `./store`/`./ExplorerView`/`../shared` files (the ESLint layering
 * rule) — every read/write goes through `ctx.api`.
 *
 * **`workspace.fs.watch`, one subscription per LOADED directory**: `Req
 * 11.2`'s "tree view over `workspace.fs.readdir` + `watch`" — `@tecode/
 * core`'s real `FileSystem.watch` (`buffer/fileSystem.ts`) watches exactly
 * one path non-recursively (`node:fs.watch` with no `recursive` option),
 * so keeping the WHOLE visible tree live means one `watch(dirUri, ...)`
 * call per directory the store has ever loaded (the root, up front, plus
 * every directory the user expands), not a single recursive watch on the
 * root. Each watch's listener simply reloads THAT SAME directory
 * (`store.reload(dirUri)`) on any event — the watch is already scoped to
 * exactly that directory's own direct children, so the event's own
 * `type`/`uri` fields need no further inspection. Watches are created
 * once per directory and never torn down on collapse (an accepted MVP
 * simplification: a very deep, very widely-expanded-then-collapsed
 * session accumulates one live watcher per directory ever visited) — all
 * of them still land in `ctx.subscriptions`, so they are cleaned up
 * together on deactivation regardless.
 *
 * **Never throws, out of this module** (design.md §14): every command
 * handler either delegates to `ExplorerStore` methods (already
 * never-throwing, `store.ts`'s TSDoc) or wraps its own `workspace.fs.*`
 * call in a `try`/`catch` that reports via `window.showMessage(...,
 * "error")` — matching Req 11.2's "create/rename/delete with input-box
 * prompts and error surfacing" and design.md §14's "File save I/O error ->
 * status-bar error" row for the same class of failure.
 */

import type { ExtensionContext, QuickPickItem, Uri } from "@tecode/api";
import { createBunGitRunner, createIgnoreChecker, joinChildUri } from "../shared";
import { createExplorerViewComponent } from "./ExplorerView";
import { createExplorerStore, type ExplorerStore } from "./store";
import {
  EXPLORER_DELETE_COMMAND_ID,
  EXPLORER_FOCUS_COMMAND_ID,
  EXPLORER_NEW_FILE_COMMAND_ID,
  EXPLORER_NEW_FOLDER_COMMAND_ID,
  EXPLORER_RENAME_COMMAND_ID,
  EXPLORER_SHOW_HIDDEN_CONFIG_KEY,
  EXPLORER_VIEW_ID,
} from "./manifest";

/** The privileged bridge command `@tecode/core`'s `ui/openFileCommand.ts`
 * registers directly on the core `CommandRegistry` (matches
 * `command-palette/index.ts`'s own documented duplication — `packages/
 * builtin` may never import `@tecode/core`, so this string must stay in
 * sync with `@tecode/core`'s `OPEN_FILE_COMMAND_ID` by hand). */
const OPEN_FILE_COMMAND_ID = "workbench.action.files.openUri";

/** `workbench.view.<id>` is auto-registered by `@tecode/core`'s
 * `shell.tsx`'s `Shell` for every sidebar/activity-bar pair (Req 6.2) —
 * `explorer.focus`'s handler is a one-line delegate to it, which both
 * shows+activates the explorer sidebar AND (VS Code-style) toggles it
 * shut again on a repeat invocation while already active/visible
 * (`shell.tsx`'s `selectSidebarView` TSDoc). Actually moving OpenTUI
 * keyboard focus into the tree happens separately, inside `ExplorerView`
 * mounting fresh every time the sidebar becomes visible again (`shell.
 * tsx`'s `Sidebar` unmounts its content entirely while hidden) — `Tree`'s
 * own `focused` prop below drives that. */
const FOCUS_SIDEBAR_VIEW_COMMAND_ID = `workbench.view.${EXPLORER_VIEW_ID}`;

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches `fileSystem.ts`'s/`walkFiles.ts`'s callers' own
 * `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Validates a new file/folder name (Req 11.2's "create... with input-box
 * prompts"): non-empty, no path separator, and not already used by a
 * sibling already listed in `dirUri` (a best-effort check against
 * whatever the store last loaded — the real `write`/`mkdir` call is still
 * the final authority, so a race with an out-of-band change is simply
 * reported as an error at that point instead). `currentName`, when given
 * (renaming), exempts that one name from the collision check — renaming a
 * file to its own current name is otherwise indistinguishable from "name
 * already taken". */
function validateEntryName(value: string, siblingNames: readonly string[], currentName?: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Name cannot be empty.";
  if (trimmed.includes("/")) return "Name cannot contain \"/\".";
  if (trimmed !== currentName && siblingNames.includes(trimmed)) {
    return `"${trimmed}" already exists here.`;
  }
  return undefined;
}

/** Registers `explorer.focus` (this module's TSDoc). */
function registerFocusCommand(ctx: ExtensionContext): void {
  const { api } = ctx;
  ctx.subscriptions.push(
    api.commands.register(EXPLORER_FOCUS_COMMAND_ID, async () => {
      await api.commands.execute(FOCUS_SIDEBAR_VIEW_COMMAND_ID);
    }),
  );
}

/** Registers `explorer.newFile`/`newFolder` (Req 11.2). Both share the
 * same "resolve target directory -> prompt -> validate -> `fs.write`/
 * `mkdir` -> reload -> select" shape, parameterized only by `kind`. */
function registerCreateCommands(ctx: ExtensionContext, store: ExplorerStore): void {
  const { api } = ctx;

  function registerCreate(commandId: string, kind: "file" | "folder", prompt: string): void {
    ctx.subscriptions.push(
      api.commands.register(commandId, async () => {
        const dirUri = store.resolveTargetDirectory();
        if (!dirUri) {
          api.window.showMessage("No folder is open.", "info");
          return;
        }

        const name = await api.window.showInputBox({
          prompt,
          validateInput: (value) => validateEntryName(value, siblingNamesOf(store, dirUri)),
        });
        if (!name) return;

        const uri = joinChildUri(dirUri, name.trim());
        try {
          if (kind === "file") await api.workspace.fs.write(uri, new Uint8Array());
          else await api.workspace.fs.mkdir(uri);
        } catch (cause) {
          api.window.showMessage(
            `Could not create ${kind === "file" ? "file" : "folder"}: ${describeError(cause)}`,
            "error",
          );
          return;
        }

        await store.reload(dirUri);
        store.setSelectedId(uri);
      }),
    );
  }

  registerCreate(EXPLORER_NEW_FILE_COMMAND_ID, "file", "New file name");
  registerCreate(EXPLORER_NEW_FOLDER_COMMAND_ID, "folder", "New folder name");
}

/** The currently-loaded sibling names of `dirUri` (this module's
 * `validateEntryName`'s TSDoc) — reads `store.getNodes()` for the root, or
 * the already-expanded subtree otherwise; a directory whose children were
 * never loaded (not the target of any prior `reload`) simply has no known
 * siblings yet, which just means the collision check has nothing to catch
 * (the real `fs.write`/`mkdir` call still reports a genuine collision as
 * an error). */
function siblingNamesOf(store: ExplorerStore, dirUri: Uri): string[] {
  function search(nodes: ReturnType<ExplorerStore["getNodes"]>): string[] | undefined {
    for (const node of nodes) {
      if (node.id === dirUri) {
        return (node.children ?? []).map((c) => c.label);
      }
      if (node.children) {
        const found = search(node.children);
        if (found) return found;
      }
    }
    return undefined;
  }
  if (store.getRootUri() === dirUri) return store.getNodes().map((n) => n.label);
  return search(store.getNodes()) ?? [];
}

/** Registers `explorer.rename` (Req 11.2). */
function registerRenameCommand(ctx: ExtensionContext, store: ExplorerStore): void {
  const { api } = ctx;
  ctx.subscriptions.push(
    api.commands.register(EXPLORER_RENAME_COMMAND_ID, async () => {
      const uri = store.getSelectedId();
      if (!uri) {
        api.window.showMessage("Select a file or folder to rename.", "info");
        return;
      }
      const parent = store.getParent(uri);
      const currentName = store.getName(uri);
      if (!parent || currentName === undefined) {
        api.window.showMessage("Could not determine the selected item's location.", "error");
        return;
      }

      const newName = await api.window.showInputBox({
        prompt: "New name",
        value: currentName,
        validateInput: (value) => validateEntryName(value, siblingNamesOf(store, parent), currentName),
      });
      if (!newName || newName.trim() === currentName) return;

      const newUri = joinChildUri(parent, newName.trim());
      try {
        await api.workspace.fs.rename(uri, newUri);
      } catch (cause) {
        api.window.showMessage(`Could not rename: ${describeError(cause)}`, "error");
        return;
      }

      await store.reload(parent);
      store.setSelectedId(newUri);
    }),
  );
}

/** Registers `explorer.delete` (Req 11.2's "delete... with... error
 * surfacing"), confirming via `showQuickPick` (Task 3.3's plan: "delete
 * confirms via `showQuickPick` Delete/Cancel"). */
function registerDeleteCommand(ctx: ExtensionContext, store: ExplorerStore): void {
  const { api } = ctx;
  ctx.subscriptions.push(
    api.commands.register(EXPLORER_DELETE_COMMAND_ID, async () => {
      const uri = store.getSelectedId();
      if (!uri) {
        api.window.showMessage("Select a file or folder to delete.", "info");
        return;
      }
      const name = store.getName(uri) ?? uri;
      const parent = store.getParent(uri);

      const items: QuickPickItem[] = [
        { label: "Delete", description: "confirm" },
        { label: "Cancel", description: "cancel" },
      ];
      const picked = await api.window.showQuickPick(items, {
        placeHolder: `Delete "${name}"?`,
      });
      if (picked?.label !== "Delete") return;

      try {
        await api.workspace.fs.delete(uri);
      } catch (cause) {
        api.window.showMessage(`Could not delete "${name}": ${describeError(cause)}`, "error");
        return;
      }

      if (store.getSelectedId() === uri) store.setSelectedId(undefined);
      if (parent) await store.reload(parent);
    }),
  );
}

/** Sets up one `workspace.fs.watch` subscription per directory the store
 * loads, for the lifetime of this activation (this module's TSDoc). */
function wireWatch(ctx: ExtensionContext, store: ExplorerStore): void {
  const { api } = ctx;
  const watched = new Set<Uri>();

  function watchIfNew(dirUri: Uri): void {
    if (watched.has(dirUri)) return;
    watched.add(dirUri);
    ctx.subscriptions.push(api.workspace.fs.watch(dirUri, () => void store.reload(dirUri)));
  }

  const rootUri = store.getRootUri();
  if (rootUri) watchIfNew(rootUri);

  // A directory only becomes watchable once the store has actually loaded
  // it (the first successful `reload`) — `onDidChange` fires on every
  // mutation, so this scans every currently-known loaded directory after
  // each one; already-watched directories are skipped instantly via
  // `watched`, so this stays cheap even on a large, long-lived tree.
  ctx.subscriptions.push(
    store.onDidChange(() => {
      for (const id of store.getExpandedIds()) {
        if (store.isDirectory(id)) watchIfNew(id);
      }
    }),
  );
}

export function activate(ctx: ExtensionContext): void {
  const { api } = ctx;
  const rootUri = api.workspace.rootUri;

  const ignore = createIgnoreChecker({
    readFile: (uri) => api.workspace.fs.read(uri),
    gitRunner: createBunGitRunner(),
  });

  const store = createExplorerStore(rootUri, {
    readdir: (uri) => api.workspace.fs.readdir(uri),
    ignore,
    showMessage: (message, kind) => api.window.showMessage(message, kind),
    showHidden: api.config.get<boolean>(EXPLORER_SHOW_HIDDEN_CONFIG_KEY) ?? false,
  });

  // Req 9.5's `explorer.showHidden`, live (Task 3.3's "showHidden toggle
  // reflects without restart") — matches `editor-core/index.ts`'s
  // `editor.tabSize`/`editor.insertSpaces` live-reload precedent.
  ctx.subscriptions.push(
    api.config.onDidChange((event) => {
      if (!event.affectsConfiguration(EXPLORER_SHOW_HIDDEN_CONFIG_KEY)) return;
      store.setShowHidden(api.config.get<boolean>(EXPLORER_SHOW_HIDDEN_CONFIG_KEY) ?? false);
    }),
  );

  if (rootUri) void store.reload(rootUri);
  wireWatch(ctx, store);

  ctx.subscriptions.push(
    api.ui.registerView(
      "sidebar.view",
      EXPLORER_VIEW_ID,
      createExplorerViewComponent({
        store,
        Tree: api.ui.Tree,
        onOpenFile: (uri) => void api.commands.execute(OPEN_FILE_COMMAND_ID, uri),
      }),
    ),
  );

  registerFocusCommand(ctx);
  registerCreateCommands(ctx, store);
  registerRenameCommand(ctx, store);
  registerDeleteCommand(ctx, store);
}

export function deactivate(): void {
  // Nothing beyond `ctx.subscriptions` (disposed by the host, Req 2.6) —
  // this extension owns no other resources.
}
