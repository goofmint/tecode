/**
 * `search`'s manifest (Issue #147): declares the second `slot: "sidebar"`
 * view in this codebase — the one that finally makes the activity bar show
 * more than a single entry (Issue #147's "エクスプローラーと検索ビューを
 * 並べたい"). Read and validated by the host WITHOUT executing `index.ts`
 * (Req 2.2) — pure data, `export default {...} satisfies Manifest`
 * (follows `../explorer/manifest.ts`'s precedent, which this whole
 * extension is modelled on).
 *
 * **The activity-bar entry is free** (Issue #147's own investigation):
 * declaring `views: [{ id, title, slot: "sidebar" }]` is enough — the host
 * synthesizes the paired `activityBar.item` itself (`@tecode/core`'s
 * `ui/slotRegistry.ts`'s `seedPendingView`) and registers a
 * `workbench.view.search` command for the pair (`shell.tsx`'s `Shell`), so
 * nothing here (and nothing in `index.ts`) has to contribute either one.
 *
 * **`activationEvents: ["onCommand:search.focus"]`, not `"onStartup"`**:
 * identical reasoning to `../explorer/manifest.ts`'s own paragraph on this
 * — every `views`/`commands`/`keybindings`/`configuration` contribution is
 * registered at manifest-registration time regardless of activation, so
 * the activity-bar icon, the palette entries, `ctrl+shift+f` and the
 * `search.*` defaults all exist from the first frame; only the actual
 * `SearchView` component (and its workspace-scanning store) waits for
 * `activate(ctx)`, triggered by whichever comes first — `search.focus`, or
 * a click on the activity-bar icon (`slotRegistry.ts`'s
 * `requestActivation`).
 *
 * **`ctrl+shift+f` is a Kitty-protocol hazard shape, deliberately
 * accepted**: `ctrl+shift+<letter>` collapses to the same raw control byte
 * as plain `ctrl+<letter>` on a legacy terminal
 * (`packages/cli/src/fallbackKeybindingsCompleteness.test.ts`'s TSDoc), so
 * this binding comes with a `keybindings.fallback.json` entry
 * (`ctrl+t` -> `search.focus`) exactly like `ctrl+shift+e` ->
 * `explorer.focus` already has. The familiar VS Code key is worth that one
 * extra fallback entry — the remedy is a documented, already-built
 * mechanism, not a new one invented for this extension.
 *
 * **No keybinding for the results tree's own Enter/arrows**, matching
 * `../explorer/manifest.ts`'s "No keybinding for Enter/creation/rename/
 * deletion, deliberately": `tecode.ui.Tree` already handles `up`/`down`/
 * `left`/`right`/`return` on its own focused root node, and a core-level
 * `when: "searchFocus"` binding for the same strokes would race it.
 */

import type { Manifest } from "@tecode/api";

/** The sidebar view id `index.ts` registers `SearchView` under, and the
 * activity-bar/sidebar pairing id (Req 6.2) — also `workbench.view.search`'s
 * auto-registered target (`@tecode/core`'s `shell.tsx`'s `Shell`). Exported
 * so `index.ts` and tests reference the same id. */
export const SEARCH_VIEW_ID = "search";

/** `ctrl+shift+f` — reveals the search sidebar view (Issue #147). */
export const SEARCH_FOCUS_COMMAND_ID = "search.focus";
/** Switches the view between filename search and full-text search without
 * reaching for the mouse (the mode row `SearchView.tsx` renders is
 * click-driven; this is its keyboard/palette counterpart). */
export const SEARCH_TOGGLE_MODE_COMMAND_ID = "search.toggleMode";
/** Drops the cached workspace file list so the next search re-walks the
 * tree (`store.ts`'s `SearchStore.refresh` TSDoc explains why the list is
 * cached at all). */
export const SEARCH_REFRESH_COMMAND_ID = "search.refresh";

/** Whether full-text search matches case-sensitively (Issue #147). */
export const SEARCH_CASE_SENSITIVE_CONFIG_KEY = "search.caseSensitive";
/** How many results (matching files in filename mode, matching lines in
 * full-text mode) the view keeps before reporting itself truncated. */
export const SEARCH_MAX_RESULTS_CONFIG_KEY = "search.maxResults";

/** {@link SEARCH_CASE_SENSITIVE_CONFIG_KEY}'s default — the ONE definition
 * of it: the configuration schema below and `index.ts`'s `api.config.get`
 * read both use this constant, so the "no value configured" behaviour can
 * never drift from the declared schema default (this is not a fallback for
 * a failed read — `ConfigNamespace.get` returns `undefined` only when a key
 * genuinely has no value anywhere). */
export const SEARCH_CASE_SENSITIVE_DEFAULT = false;

/** {@link SEARCH_MAX_RESULTS_CONFIG_KEY}'s default — see
 * {@link SEARCH_CASE_SENSITIVE_DEFAULT}'s TSDoc for why this is a shared
 * constant rather than a literal repeated at each read site. `1000` lines
 * is far more than anyone reads in a sidebar, and small enough that a
 * pathological query (`"e"` over a large workspace) stops early instead of
 * building an unbounded result array. */
export const SEARCH_MAX_RESULTS_DEFAULT = 1000;

/** The activity-bar glyph for this view (Issue #147's "アイコンを設定する").
 * Plain ASCII, deliberately not an emoji — `@tecode/core`'s `shell.tsx`'s
 * `SIDEBAR_COLLAPSE_GLYPH` TSDoc and Issue #121 give the reasoning (not
 * every terminal font renders one, and a wide glyph breaks the fixed
 * 4-column activity bar's monospace cell). */
export const SEARCH_VIEW_ICON = "S";

export default {
  id: "tecode.search",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: [`onCommand:${SEARCH_FOCUS_COMMAND_ID}`],
  contributes: {
    views: [{ id: SEARCH_VIEW_ID, title: "Search", slot: "sidebar", icon: SEARCH_VIEW_ICON }],
    commands: [
      { id: SEARCH_FOCUS_COMMAND_ID, title: "Focus on Search", category: "View" },
      { id: SEARCH_TOGGLE_MODE_COMMAND_ID, title: "Toggle Search Mode", category: "View" },
      { id: SEARCH_REFRESH_COMMAND_ID, title: "Refresh Search File List", category: "View" },
    ],
    keybindings: [{ key: "ctrl+shift+f", command: SEARCH_FOCUS_COMMAND_ID }],
    configuration: {
      title: "Search",
      properties: {
        [SEARCH_CASE_SENSITIVE_CONFIG_KEY]: {
          type: "boolean",
          default: SEARCH_CASE_SENSITIVE_DEFAULT,
          description: "Match case when searching file contents.",
        },
        [SEARCH_MAX_RESULTS_CONFIG_KEY]: {
          type: "number",
          default: SEARCH_MAX_RESULTS_DEFAULT,
          description: "Maximum number of search results kept before the result list is truncated.",
        },
      },
    },
  },
} satisfies Manifest;
