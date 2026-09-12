/**
 * `SearchStore` — the search view's state, kept as a plain, UI-framework-
 * free object (Issue #147), exactly mirroring `../explorer/store.ts`'s own
 * shape and discipline: `index.ts`'s `activate(ctx)` builds one instance
 * per activation, `SearchView.tsx` renders straight off it, and both
 * read/write the SAME store so a command (`search.toggleMode`,
 * `search.refresh`) and the rendered results always agree.
 *
 * **Two modes, one store**: `"files"` ranks the workspace's file PATHS with
 * `../shared/fuzzyMatch.ts` (the same ranking `ctrl+p`'s quick open uses,
 * `../command-palette/index.ts`); `"text"` reads each file and matches its
 * LINES with `./lineMatch.ts`. Both walk the workspace through the same
 * `../shared/walkFiles.ts` + `../shared/ignore.ts` pair the explorer and
 * quick open already share, so `.gitignore`/dotfile visibility is
 * identical everywhere.
 *
 * **The file list is walked once and cached** ({@link
 * SearchStore.refresh}): unlike `ctrl+p`, which walks the tree once per
 * invocation and then closes, this view lives in the sidebar for the whole
 * session and re-searches on EVERY keystroke in filename mode — re-walking
 * the workspace per keystroke would be visibly slow on a real repository.
 * The walk therefore happens on the first search and is reused afterwards;
 * `search.refresh` (and `index.ts`'s `workspace.fs.watch`-free design)
 * leaves the user in control of when it is redone, rather than this store
 * guessing. A file created after the last walk simply does not appear
 * until a refresh — a deliberate, documented limitation, not an oversight.
 *
 * **Generation counter, not cancellation** (Issue #147's plan, Design
 * Choice 3): `walkFiles` is a single Promise with no `AbortSignal`, so
 * every in-flight search carries the generation it started with and
 * commits nothing once a newer search has begun — the same "whichever
 * finishes with a stale generation is discarded" rule `../explorer/
 * store.ts`'s `reloadGenerations` already uses per directory, here applied
 * once globally (there is only ever one query at a time).
 *
 * **Incremental full-text results**: the text scan fires
 * {@link SearchStore.onDidChange} every {@link TEXT_SEARCH_FIRE_INTERVAL}
 * hits rather than only at the end, so a long scan fills the view
 * progressively instead of freezing it on an empty list.
 *
 * **Never throws**: every failure path (an unreadable file, a failed
 * workspace walk) either skips that file silently — `walkFiles.ts`'s own
 * "a partial workspace scan degrades gracefully" convention — or reports
 * through {@link SearchStoreDeps.showMessage}, never by rejecting/throwing
 * back to a caller.
 */

import type { DirEntry, Disposable, Event, Listener, MessageKind, Position, Uri } from "@tecode/api";
import { fuzzyMatch, walkFiles, type IgnoreChecker, type WalkedFile, type WalkFilesResult } from "../shared";
import { findLineMatches, looksBinary, type LineMatch } from "./lineMatch";

/** Which kind of search the view is currently showing (Issue #147's
 * "ファイル名検索と全文検索を切り替えられる"). */
export type SearchMode = "files" | "text";

/** The exact node shape `tecode.ui.Tree` expects — duck-typed, never
 * imported (`../explorer/store.ts`'s `ExplorerTreeNode` TSDoc explains
 * why). */
export interface SearchTreeNode {
  id: string;
  label: string;
  children?: SearchTreeNode[];
  hasChildren?: boolean;
}

/** One file whose CONTENTS matched, with every matching line (full-text
 * mode). */
export interface SearchTextResult {
  uri: Uri;
  /** The file's path relative to the workspace root (`walkFiles.ts`). */
  relativePath: string;
  hits: LineMatch[];
}

/** Where activating a result node should take the editor — a file, plus
 * the matched position in full-text mode (`index.ts` opens the file and,
 * when a position is present, moves the cursor there). */
export interface SearchTarget {
  uri: Uri;
  position?: Position;
}

/** Dependencies for {@link createSearchStore}. */
export interface SearchStoreDeps {
  /** Matches `@tecode/api`'s `FileSystem.readdir` exactly — pass
   * `api.workspace.fs.readdir` directly. */
  readdir(uri: Uri): Promise<DirEntry[]>;
  /** Matches `@tecode/api`'s `FileSystem.read` exactly — pass
   * `api.workspace.fs.read` directly. Full-text mode only. */
  readFile(uri: Uri): Promise<Uint8Array>;
  /** The real `.gitignore`-aware visibility helper (`../shared/ignore.ts`)
   * — shared with the explorer and quick open. */
  ignore: IgnoreChecker;
  /** Surfaces a workspace-walk failure — pass `api.window.showMessage`
   * directly. */
  showMessage(message: string, kind?: MessageKind): void;
  /** `search.caseSensitive`'s initial value — `index.ts` reads
   * `api.config.get` once up front; later changes go through
   * {@link SearchStore.setCaseSensitive} (mirrors `../explorer/store.ts`'s
   * `showHidden` precedent). */
  caseSensitive: boolean;
  /** `search.maxResults`' initial value — same precedent as
   * {@link caseSensitive}; later changes go through
   * {@link SearchStore.setMaxResults}. */
  maxResults: number;
}

/** Cap on how many files the workspace walk collects before abandoning the
 * rest of the tree — the same value and the same reasoning as
 * `../command-palette/index.ts`'s `QUICK_OPEN_MAX_RESULTS` (kept as this
 * module's own constant rather than imported, since the two caps are
 * conceptually independent knobs that merely happen to agree today). */
const SEARCH_WALK_MAX_FILES = 5000;

/** How many newly-found full-text hits accumulate before the scan fires
 * {@link SearchStore.onDidChange} again (this module's TSDoc's
 * "Incremental full-text results") — small enough that results visibly
 * stream in, large enough that a match-dense workspace does not re-render
 * the sidebar once per hit. */
const TEXT_SEARCH_FIRE_INTERVAL = 25;

/** The floor for {@link SearchStore.setMaxResults} — a cap of `0` would
 * make every search silently return nothing, which reads as a bug rather
 * than a setting. */
const MIN_MAX_RESULTS = 1;

/** Clamp a desired `search.maxResults` (mirrors `../explorer/store.ts`'s
 * `clampIndentWidth` in shape): never below {@link MIN_MAX_RESULTS}, no
 * ceiling, and a non-finite value (a hand-edited `settings.json`) degrades
 * to the floor rather than propagating `NaN` into a loop bound. */
function clampMaxResults(desired: number): number {
  const safeDesired = Number.isFinite(desired) ? Math.trunc(desired) : MIN_MAX_RESULTS;
  return Math.max(MIN_MAX_RESULTS, safeDesired);
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches `../explorer/store.ts`'s own `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** The tree-node id for one full-text hit (this module's TSDoc) — the
 * file's uri plus the hit's zero-based position. `#` is safe as the
 * separator: `walkFiles.ts`'s `joinChildUri` percent-encodes every path
 * segment, so a walked file's uri never contains a literal `#`. */
export function hitNodeId(uri: Uri, hit: LineMatch): string {
  return `${uri}#${hit.line}:${hit.startCharacter}`;
}

/** The label one full-text hit renders as: its 1-based line number and the
 * matched line's own text, with surrounding whitespace trimmed so deeply
 * indented code still shows its actual content in a narrow sidebar. */
export function hitLabel(hit: LineMatch): string {
  return `${hit.line + 1}: ${hit.lineText.trim()}`;
}

/** The search view's state (this module's TSDoc). */
export interface SearchStore {
  /** The workspace root this store was built for — `undefined` degrades to
   * a permanently empty, never-searching store (`../explorer/store.ts`'s
   * own "no folder open" degrade), never a crash. */
  getRootUri(): Uri | undefined;
  getMode(): SearchMode;
  /** Switches between filename and full-text search, discarding the other
   * mode's results and re-running the current query (if any) in the new
   * mode. A no-op when already in `mode`. */
  setMode(mode: SearchMode): void;
  getQuery(): string;
  /**
   * Records what the user has typed. In `"files"` mode this ALSO starts a
   * search immediately — ranking an already-walked file list is pure
   * in-memory work, so search-as-you-type is cheap. In `"text"` mode it
   * only clears the previous results and waits for {@link submit}: each
   * full-text search reads every file in the workspace, which is far too
   * expensive to redo on every keystroke.
   */
  setQuery(value: string): void;
  /** Runs the current query in the current mode (the query input's Enter
   * key) — the only way a full-text search ever starts. */
  submit(): void;
  /** Whether a search is currently in flight (the view shows this rather
   * than an empty-looking result list). */
  isLoading(): boolean;
  /** Whether results were cut short — by `search.maxResults`, or by the
   * workspace walk's own {@link SEARCH_WALK_MAX_FILES} cap
   * (`walkFiles.ts`'s "Bounded scans"). */
  isTruncated(): boolean;
  /** How many results the current mode is showing — matching files, or
   * matching lines. */
  getResultCount(): number;
  /** The result tree, ready to pass straight to `<Tree nodes={...} />`. */
  getNodes(): SearchTreeNode[];
  getSelectedId(): string | undefined;
  setSelectedId(id: string | undefined): void;
  /** Full-text mode: every matched file that is not collapsed (files start
   * expanded so hits are visible without a click). Filename mode: `[]` —
   * its nodes have no children. */
  getExpandedIds(): string[];
  /** Collapses/expands one matched file's hit list (full-text mode). */
  toggle(id: string, expanding: boolean): void;
  /** Where activating node `id` should take the editor, or `undefined` for
   * an id this store does not currently show. */
  resolveTarget(id: string): SearchTarget | undefined;
  getCaseSensitive(): boolean;
  /** `search.caseSensitive`, live — re-runs the current full-text query so
   * the change is visible without a restart (`../explorer/store.ts`'s
   * `setShowHidden` precedent). */
  setCaseSensitive(value: boolean): void;
  getMaxResults(): number;
  /** `search.maxResults`, live — applies to the NEXT search rather than
   * retroactively growing/shrinking the results already on screen. */
  setMaxResults(value: number): void;
  /** Drops the cached workspace file list (this module's TSDoc) and
   * re-runs the current query, so a file created since the last walk shows
   * up. */
  refresh(): void;
  /** Fires after every mutation (this module's TSDoc). */
  onDidChange: Event<void>;
}

/**
 * Build a {@link SearchStore} rooted at `rootUri` (Issue #147).
 * `rootUri: undefined` (no folder open) is a fully supported, permanently
 * empty store — every method degrades gracefully rather than assuming a
 * root exists.
 */
export function createSearchStore(rootUri: Uri | undefined, deps: SearchStoreDeps): SearchStore {
  const listeners = new Set<Listener<void>>();
  const decoder = new TextDecoder();
  /** Full-text mode's collapsed files (this module's `getExpandedIds`) —
   * tracked as the INVERSE of expansion so a file found by a later search
   * starts expanded without any bookkeeping. */
  const collapsed = new Set<Uri>();

  let mode: SearchMode = "files";
  let query = "";
  let loading = false;
  let truncated = false;
  let selectedId: string | undefined;
  let caseSensitive = deps.caseSensitive;
  let maxResults = clampMaxResults(deps.maxResults);
  let fileResults: WalkedFile[] = [];
  let textResults: SearchTextResult[] = [];
  // See this module's TSDoc's "Generation counter, not cancellation".
  let generation = 0;
  // See this module's TSDoc's "The file list is walked once and cached".
  let fileListPromise: Promise<WalkFilesResult> | undefined;

  function fireChange(): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch {
        // Isolate listener failures (`../explorer/store.ts`'s own
        // `fireChange` precedent).
      }
    }
  }

  function onDidChange(listener: Listener<void>): Disposable {
    listeners.add(listener);
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        listeners.delete(listener);
      },
    };
  }

  function isStale(startedAt: number): boolean {
    return generation !== startedAt;
  }

  function loadFiles(): Promise<WalkFilesResult> {
    if (!rootUri) return Promise.resolve({ files: [], truncated: false });
    if (!fileListPromise) {
      // `walkFiles` is documented never to throw, but a rejected promise
      // cached here would poison every later search — so the catch both
      // reports and un-caches, letting the next search try again.
      fileListPromise = walkFiles(rootUri, {
        readdir: deps.readdir,
        ignore: deps.ignore,
        maxResults: SEARCH_WALK_MAX_FILES,
      }).catch((cause: unknown): WalkFilesResult => {
        fileListPromise = undefined;
        deps.showMessage(`Could not scan the workspace: ${describeError(cause)}`, "error");
        return { files: [], truncated: false };
      });
    }
    return fileListPromise;
  }

  async function runFileSearch(startedAt: number): Promise<void> {
    const walk = await loadFiles();
    if (isStale(startedAt)) return;

    const ranked = walk.files
      .map((file) => ({ file, score: fuzzyMatch(query, file.relativePath)?.score }))
      .filter((entry): entry is { file: WalkedFile; score: number } => entry.score !== undefined)
      // Stable sort (ES2019+), so equally-scored files keep `walkFiles`'s
      // own deterministic order.
      .sort((a, b) => b.score - a.score);

    fileResults = ranked.slice(0, maxResults).map((entry) => entry.file);
    truncated = walk.truncated || ranked.length > maxResults;
    loading = false;
    fireChange();
  }

  async function runTextSearch(startedAt: number): Promise<void> {
    const walk = await loadFiles();
    if (isStale(startedAt)) return;

    let total = 0;
    let sinceFire = 0;
    let capped = false;

    for (const file of walk.files) {
      if (isStale(startedAt)) return;
      if (total >= maxResults) {
        capped = true;
        break;
      }

      let bytes: Uint8Array;
      try {
        bytes = await deps.readFile(file.uri);
      } catch {
        // One unreadable file never fails the whole search
        // (`walkFiles.ts`'s "Failure handling" convention).
        continue;
      }
      if (isStale(startedAt)) return;
      if (looksBinary(bytes)) continue;

      const hits = findLineMatches(decoder.decode(bytes), query, {
        caseSensitive,
        maxMatches: maxResults - total,
      });
      if (hits.length === 0) continue;

      textResults.push({ uri: file.uri, relativePath: file.relativePath, hits });
      total += hits.length;
      sinceFire += hits.length;
      if (sinceFire >= TEXT_SEARCH_FIRE_INTERVAL) {
        sinceFire = 0;
        fireChange();
      }
    }

    if (isStale(startedAt)) return;
    truncated = walk.truncated || capped || total >= maxResults;
    loading = false;
    fireChange();
  }

  /** Discard whatever is on screen and start the current query in the
   * current mode (this module's TSDoc's generation rule). An empty query,
   * or no workspace root, just clears — never a scan. */
  function startSearch(): void {
    generation += 1;
    const startedAt = generation;
    fileResults = [];
    textResults = [];
    truncated = false;
    selectedId = undefined;

    if (!rootUri || query.length === 0) {
      loading = false;
      fireChange();
      return;
    }

    loading = true;
    fireChange();
    void (mode === "files" ? runFileSearch(startedAt) : runTextSearch(startedAt));
  }

  /** Clear results WITHOUT starting anything (full-text mode's
   * "type now, search on Enter" — {@link SearchStore.setQuery}'s TSDoc). */
  function clearResults(): void {
    generation += 1;
    fileResults = [];
    textResults = [];
    truncated = false;
    loading = false;
    selectedId = undefined;
    fireChange();
  }

  function setMode(value: SearchMode): void {
    if (mode === value) return;
    mode = value;
    collapsed.clear();
    startSearch();
  }

  function setQuery(value: string): void {
    if (query === value) return;
    query = value;
    if (mode === "files") {
      startSearch();
      return;
    }
    clearResults();
  }

  function setSelectedId(id: string | undefined): void {
    if (selectedId === id) return;
    selectedId = id;
    fireChange();
  }

  function toggle(id: string, expanding: boolean): void {
    if (mode !== "text") return;
    if (!textResults.some((entry) => entry.uri === id)) return;
    if (expanding) collapsed.delete(id);
    else collapsed.add(id);
    fireChange();
  }

  function getNodes(): SearchTreeNode[] {
    if (mode === "files") {
      return fileResults.map((file) => ({
        id: file.uri,
        label: file.relativePath,
        hasChildren: false,
      }));
    }
    return textResults.map((entry) => ({
      id: entry.uri,
      label: `${entry.relativePath} (${entry.hits.length})`,
      hasChildren: true,
      children: collapsed.has(entry.uri)
        ? undefined
        : entry.hits.map((hit) => ({ id: hitNodeId(entry.uri, hit), label: hitLabel(hit), hasChildren: false })),
    }));
  }

  function resolveTarget(id: string): SearchTarget | undefined {
    if (mode === "files") {
      return fileResults.some((file) => file.uri === id) ? { uri: id } : undefined;
    }
    for (const entry of textResults) {
      if (entry.uri === id) return { uri: entry.uri };
      for (const hit of entry.hits) {
        if (hitNodeId(entry.uri, hit) === id) {
          return { uri: entry.uri, position: { line: hit.line, character: hit.startCharacter } };
        }
      }
    }
    return undefined;
  }

  function setCaseSensitive(value: boolean): void {
    if (caseSensitive === value) return;
    caseSensitive = value;
    // Only full-text mode consults it (`fuzzyMatch` is always
    // case-insensitive), so only that mode needs re-running.
    if (mode === "text" && query.length > 0) {
      startSearch();
      return;
    }
    fireChange();
  }

  function setMaxResults(value: number): void {
    const clamped = clampMaxResults(value);
    if (maxResults === clamped) return;
    maxResults = clamped;
    fireChange();
  }

  function refresh(): void {
    fileListPromise = undefined;
    startSearch();
  }

  return {
    getRootUri: () => rootUri,
    getMode: () => mode,
    setMode,
    getQuery: () => query,
    setQuery,
    submit: startSearch,
    isLoading: () => loading,
    isTruncated: () => truncated,
    getResultCount: () =>
      mode === "files" ? fileResults.length : textResults.reduce((sum, entry) => sum + entry.hits.length, 0),
    getNodes,
    getSelectedId: () => selectedId,
    setSelectedId,
    getExpandedIds: () =>
      mode === "text" ? textResults.map((entry) => entry.uri).filter((uri) => !collapsed.has(uri)) : [],
    toggle,
    resolveTarget,
    getCaseSensitive: () => caseSensitive,
    setCaseSensitive,
    getMaxResults: () => maxResults,
    setMaxResults,
    refresh,
    onDidChange,
  };
}
