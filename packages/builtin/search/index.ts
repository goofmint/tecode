/**
 * `search`'s `activate(ctx)`/`deactivate()` (Issue #147). Builds one
 * {@link SearchStore} per activation (`./store.ts`), registers
 * `SearchView` into `"sidebar.view"` (`./SearchView.tsx`), keeps
 * `search.caseSensitive`/`search.maxResults` live through
 * `api.config.onDidChange`, and implements the three commands
 * `manifest.ts` declares (`focus`/`toggleMode`/`refresh`). Only imports
 * `@tecode/api` plus this package's own local files (the ESLint layering
 * rule) — every read goes through `ctx.api`.
 *
 * **Opening a result**: `api.commands.execute("workbench.action.files.
 * openUri", uri)` opens (and activates) the file — the privileged core
 * bridge command every built-in reaches through `commands.execute` rather
 * than importing. For a full-text hit, the public `api.editor.
 * setSelections` then places a collapsed cursor at the match's own
 * position; the editor scrolls that line into view itself as part of
 * applying the selection, so nothing here asks it to scroll.
 *
 * **No `workspace.fs.watch`**, unlike `../explorer/index.ts`: the explorer
 * shows a live directory listing, while search shows the RESULT OF A QUERY
 * the user explicitly ran — silently re-running a workspace-wide scan on
 * every file change would be both surprising and expensive. `search.
 * refresh` is the deliberate, user-driven equivalent (`store.ts`'s "The
 * file list is walked once and cached").
 *
 * **Never throws, out of this module**: every handler either delegates to
 * `SearchStore` methods (already never-throwing, `store.ts`'s TSDoc) or
 * awaits a `commands.execute`, which `@tecode/core`'s `CommandRegistry`
 * already wraps in its own catch-log-notify path.
 */

import type { ExtensionContext, Position, Selection } from "@tecode/api";
import { createBunGitRunner, createIgnoreChecker } from "../shared";
import { createSearchViewComponent } from "./SearchView";
import { createSearchStore, type SearchStore, type SearchTarget } from "./store";
import {
  SEARCH_CASE_SENSITIVE_CONFIG_KEY,
  SEARCH_CASE_SENSITIVE_DEFAULT,
  SEARCH_FOCUS_COMMAND_ID,
  SEARCH_MAX_RESULTS_CONFIG_KEY,
  SEARCH_MAX_RESULTS_DEFAULT,
  SEARCH_REFRESH_COMMAND_ID,
  SEARCH_TOGGLE_MODE_COMMAND_ID,
  SEARCH_VIEW_ID,
} from "./manifest";

/**
 * The privileged bridge command `@tecode/core`'s `ui/openFileCommand.ts`
 * registers directly on the core `CommandRegistry`. Duplicated as a
 * literal string, not imported, because `packages/builtin` may never
 * import `@tecode/core` — the same hand-kept duplicate
 * `../explorer/index.ts` and `../command-palette/index.ts` already carry.
 */
const OPEN_FILE_COMMAND_ID = "workbench.action.files.openUri";

/** `workbench.view.search` — the host auto-registers one such command per
 * `activityBar.item` ↔ `sidebar.view` pair (`@tecode/core`'s `shell.tsx`'s
 * `Shell`), so `search.focus` simply executes it rather than reaching into
 * the layout state itself (mirrors `../explorer/index.ts`'s
 * `FOCUS_SIDEBAR_VIEW_COMMAND_ID`). */
const FOCUS_SIDEBAR_VIEW_COMMAND_ID = `workbench.view.${SEARCH_VIEW_ID}`;

/** A collapsed selection (a plain cursor) at `position` — what a full-text
 * hit jumps to. `anchor`/`active`/`start`/`end` all coincide, matching
 * `@tecode/api`'s `Selection` contract for a caret with no selected
 * text. */
function cursorAt(position: Position): Selection {
  return { start: position, end: position, anchor: position, active: position };
}

/** Opens `target`'s file and, for a full-text hit, moves the cursor onto
 * the match (this module's TSDoc). */
async function openTarget(ctx: ExtensionContext, target: SearchTarget): Promise<void> {
  const { api } = ctx;
  await api.commands.execute(OPEN_FILE_COMMAND_ID, target.uri);
  if (!target.position) return;
  api.editor.setSelections([cursorAt(target.position)]);
}

/** Registers `search.focus`/`search.toggleMode`/`search.refresh` (this
 * module's TSDoc). */
function registerCommands(ctx: ExtensionContext, store: SearchStore): void {
  const { api } = ctx;
  ctx.subscriptions.push(
    api.commands.register(SEARCH_FOCUS_COMMAND_ID, async () => {
      await api.commands.execute(FOCUS_SIDEBAR_VIEW_COMMAND_ID);
    }),
  );
  ctx.subscriptions.push(
    api.commands.register(SEARCH_TOGGLE_MODE_COMMAND_ID, () => {
      store.setMode(store.getMode() === "files" ? "text" : "files");
    }),
  );
  ctx.subscriptions.push(
    api.commands.register(SEARCH_REFRESH_COMMAND_ID, () => {
      store.refresh();
    }),
  );
}

export function activate(ctx: ExtensionContext): void {
  const { api } = ctx;
  const rootUri = api.workspace.rootUri;

  // Built ONCE per activation, like `../command-palette/index.ts`'s own
  // checker: `IgnoreChecker` caches its `git`-availability probe and the
  // root `.gitignore` parse internally, so one instance serves every
  // search in the session without re-spawning `git`.
  const ignore = createIgnoreChecker({
    readFile: (uri) => api.workspace.fs.read(uri),
    gitRunner: createBunGitRunner(),
  });

  const store = createSearchStore(rootUri, {
    readdir: (uri) => api.workspace.fs.readdir(uri),
    readFile: (uri) => api.workspace.fs.read(uri),
    ignore,
    showMessage: (message, kind) => api.window.showMessage(message, kind),
    // `?? <manifest default>`: `config.get` returns `undefined` only when
    // a key has no value anywhere — the manifest's own declared default is
    // the single source of truth for that case (`manifest.ts`'s
    // `SEARCH_CASE_SENSITIVE_DEFAULT` TSDoc), reused here rather than a
    // second literal that could drift from the schema. Same shape as
    // `../explorer/index.ts`'s `explorer.showHidden` read.
    caseSensitive: api.config.get<boolean>(SEARCH_CASE_SENSITIVE_CONFIG_KEY) ?? SEARCH_CASE_SENSITIVE_DEFAULT,
    maxResults: api.config.get<number>(SEARCH_MAX_RESULTS_CONFIG_KEY) ?? SEARCH_MAX_RESULTS_DEFAULT,
  });

  // Both settings live, mirroring `../explorer/index.ts`'s
  // `explorer.showHidden`/`explorer.indentWidth` subscriptions exactly.
  ctx.subscriptions.push(
    api.config.onDidChange((event) => {
      if (!event.affectsConfiguration(SEARCH_CASE_SENSITIVE_CONFIG_KEY)) return;
      store.setCaseSensitive(
        api.config.get<boolean>(SEARCH_CASE_SENSITIVE_CONFIG_KEY) ?? SEARCH_CASE_SENSITIVE_DEFAULT,
      );
    }),
  );
  ctx.subscriptions.push(
    api.config.onDidChange((event) => {
      if (!event.affectsConfiguration(SEARCH_MAX_RESULTS_CONFIG_KEY)) return;
      store.setMaxResults(api.config.get<number>(SEARCH_MAX_RESULTS_CONFIG_KEY) ?? SEARCH_MAX_RESULTS_DEFAULT);
    }),
  );

  ctx.subscriptions.push(
    api.ui.registerView(
      "sidebar.view",
      SEARCH_VIEW_ID,
      createSearchViewComponent({
        store,
        Input: api.ui.Input,
        Tree: api.ui.Tree,
        onActivateTarget: (target) => void openTarget(ctx, target),
      }),
    ),
  );

  registerCommands(ctx, store);
}

export function deactivate(): void {
  // Nothing beyond `ctx.subscriptions` (disposed by the host, Req 2.6) —
  // this extension owns no other resources.
}
