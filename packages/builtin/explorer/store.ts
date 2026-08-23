/**
 * `ExplorerStore` — the explorer's tree state, kept as a plain, UI-
 * framework-free object (Task 3.3, Req 11.2; design.md §13's `explorer`
 * design: "tree state from `tecode.workspace.fs.readdir` + `watch`").
 * `index.ts`'s `activate(ctx)` builds one instance per activation and
 * `ExplorerView.tsx` renders straight off it; both read/write the SAME
 * store, so a command (`explorer.newFile`, a `fs.watch` reload, ...) and
 * the rendered tree always agree.
 *
 * **`ExplorerTreeNode`, not `@tecode/core`'s `TreeNode`**: `packages/
 * builtin/**` may never import `@tecode/core` (the ESLint layering rule),
 * and `tecode.ui.Tree`'s node shape is not part of `@tecode/api` either
 * (`namespaces.ts`'s `UiNamespace.Tree` is the bare, React-free
 * `ComponentType`). {@link ExplorerTreeNode} below is this module's own
 * LOCAL declaration of the exact same shape `@tecode/core`'s
 * `components.tsx`'s `TreeNode` documents (`id`/`label`/`children`/
 * `hasChildren`) — duck-typed compatibility, not a real import, is all
 * `ExplorerView.tsx` needs to hand {@link getNodes}' result straight to
 * `<Tree nodes={...} />` as a `Record<string, unknown>[]`.
 *
 * **Lazy per-directory loading, mirroring `walkFiles.ts`'s shape but NOT
 * reusing it directly**: `walkFiles` eagerly recurses the WHOLE tree for
 * `ctrl+p`'s candidate list; the explorer instead loads exactly one
 * directory's children at a time — the root, up front, and any other
 * directory only once the user actually expands it ({@link
 * ExplorerStore.toggle}) — since an always-visible sidebar tree walking an
 * entire large workspace up front would be needlessly expensive. Both this
 * module and `walkFiles.ts` still share the SAME `../shared/ignore.ts`
 * `IgnoreChecker` and `../shared/walkFiles.ts`'s `joinChildUri` for the one
 * join operation each directory listing needs (Task 3.3's "one
 * ignore-aware walk `ctrl+p` and the explorer both use").
 *
 * **`onDidChange` fires on every mutation** (this module's TSDoc): a
 * directory finishing its `readdir`, an expand/collapse, a selection
 * change, or a `showHidden` flip. `ExplorerView.tsx` subscribes once and
 * force-re-renders — the same "subscribe + force-render" shape
 * `@tecode/core`'s `ui/shell.tsx`'s `useSlotViews`/`useOpenDocuments`
 * already use for an external store (`keymap/context.ts`'s
 * `createContextService` for the underlying emitter shape this module
 * copies).
 *
 * **Never throws**: every method that can fail internally (a `readdir`
 * rejecting) reports through {@link ExplorerStoreDeps.showMessage} rather
 * than rejecting/throwing back to its caller (design.md §14's "a partial
 * workspace scan degrades gracefully" convention, `walkFiles.ts`'s own
 * "an unreadable directory is skipped" precedent) — the affected directory
 * simply renders with whatever it last successfully loaded (empty, the
 * first time).
 */

import type { DirEntry, Disposable, Event, Listener, MessageKind, Uri } from "@tecode/api";
import { joinChildUri, type IgnoreChecker } from "../shared";

/** The exact node shape `tecode.ui.Tree` expects (this module's TSDoc) —
 * duck-typed, not imported. */
export interface ExplorerTreeNode {
  id: string;
  label: string;
  children?: ExplorerTreeNode[];
  hasChildren?: boolean;
}

/** One directory's cached, already-ignore-filtered children. */
interface ExplorerChild {
  uri: Uri;
  name: string;
  isDirectory: boolean;
}

/** Dependencies for {@link createExplorerStore}. */
export interface ExplorerStoreDeps {
  /** Matches `@tecode/api`'s `FileSystem.readdir` exactly — pass
   * `api.workspace.fs.readdir` directly. */
  readdir(uri: Uri): Promise<DirEntry[]>;
  /** The real `.gitignore`-aware visibility helper (`../shared/ignore.ts`,
   * Task 3.3) — batched per directory, exactly matching what one `readdir`
   * call here produces. */
  ignore: IgnoreChecker;
  /** Surfaces a `readdir` failure (design.md §14) — pass
   * `api.window.showMessage` directly. */
  showMessage(message: string, kind?: MessageKind): void;
  /** Req 9.5's `explorer.showHidden` initial value — `index.ts` reads
   * `api.config.get` once up front and passes the result here; later
   * changes go through {@link ExplorerStore.setShowHidden}. */
  showHidden: boolean;
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches `fileSystem.ts`'s/`registry.ts`'s `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** The explorer's tree state (this module's TSDoc). */
export interface ExplorerStore {
  /** The workspace root this store was built for — `undefined` degrades
   * to an always-empty tree (Task 3.3's plan: "`rootUri` undefined ->
   * empty degrade"), never a crash. */
  getRootUri(): Uri | undefined;
  getShowHidden(): boolean;
  /** Flips `explorer.showHidden` and reloads every directory ALREADY
   * loaded (root, plus every expanded directory) so the change is visible
   * immediately — Task 3.3's "showHidden toggle reflects without
   * restart". */
  setShowHidden(value: boolean): void;
  getSelectedId(): Uri | undefined;
  setSelectedId(id: Uri | undefined): void;
  /** Every currently-expanded directory's uri, as plain strings (`tecode.
   * ui.Tree`'s `expandedIds` prop wants `string[]`). */
  getExpandedIds(): string[];
  /** The root's children, built depth-first from whatever has been loaded
   * and is currently expanded (this module's TSDoc) — ready to pass
   * straight to `<Tree nodes={...} />`. `getRootUri()` being `undefined`,
   * or the root not having finished its initial load yet, both report
   * `[]` (a loading/empty tree, never a crash). */
  getNodes(): ExplorerTreeNode[];
  /** Whether `uri` is a known directory (loaded as some OTHER directory's
   * child at some point) — `undefined` (never seen) is treated as "not a
   * directory" by every caller that needs a yes/no answer (e.g.
   * `resolveTargetDirectory`), which is the safe default for an unknown
   * id. */
  isDirectory(uri: Uri): boolean;
  /** `uri`'s own display name (its `readdir` entry name), if known. */
  getName(uri: Uri): string | undefined;
  /** `uri`'s parent DIRECTORY uri, if known (every child learned via a
   * `reload` call is recorded against the directory it came from). The
   * root itself has no recorded parent. */
  getParent(uri: Uri): Uri | undefined;
  /**
   * Expand or collapse directory `uri` (Task 3.3's keyboard-nav-driven
   * `onToggle`, or a mouse click): `expanding: true` loads its children
   * on the FIRST expand (subsequent re-expands reuse the cache — a
   * `fs.watch`-triggered {@link reload} is what keeps it fresh, not a
   * reload on every re-expand); `false` just collapses without discarding
   * the cached children (a re-expand is instant). A no-op for a `uri`
   * this store does not know is a directory.
   */
  toggle(uri: Uri, expanding: boolean): void;
  /**
   * (Re)load one directory's children from `workspace.fs.readdir` —
   * called for the root once up front, for a directory the first time it
   * expands, and again whenever a `fs.watch` subscription reports a
   * change under it. Never throws (this module's TSDoc); a `readdir`
   * failure reports via `showMessage` and leaves that directory's
   * children exactly as they were before the call.
   */
  reload(uri: Uri): Promise<void>;
  /**
   * Where a create command (`explorer.newFile`/`newFolder`) should place
   * the new entry, and delete/rename's error surfaces read the CURRENT
   * selection to resolve it: the selected directory itself, the selected
   * file's PARENT directory, or the root when nothing is selected/known.
   * `undefined` only when `getRootUri()` is itself `undefined` (Task
   * 3.3's plan: "no folder open" degrade).
   */
  resolveTargetDirectory(): Uri | undefined;
  /** Fires after every mutation (this module's TSDoc). */
  onDidChange: Event<void>;
}

/**
 * Build an {@link ExplorerStore} rooted at `rootUri` (Task 3.3, Req 11.2).
 * `rootUri: undefined` (no folder open) is a fully supported, permanently
 * empty store — every method degrades gracefully rather than assuming a
 * root exists.
 */
export function createExplorerStore(rootUri: Uri | undefined, deps: ExplorerStoreDeps): ExplorerStore {
  const childrenByDir = new Map<Uri, ExplorerChild[]>();
  const relativeDirByUri = new Map<Uri, string>();
  const parentByUri = new Map<Uri, Uri>();
  const directoryUris = new Set<Uri>();
  const expanded = new Set<Uri>();
  const listeners = new Set<Listener<void>>();

  let showHidden = deps.showHidden;
  let selectedId: Uri | undefined;

  if (rootUri) relativeDirByUri.set(rootUri, "");

  function fireChange(): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch {
        // Isolate listener failures (matches `keymap/context.ts`'s
        // `createContextService`'s own `set()`).
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

  async function reload(dirUri: Uri): Promise<void> {
    if (!rootUri) return;
    const relativeDir = relativeDirByUri.get(dirUri) ?? "";

    let entries: DirEntry[];
    try {
      entries = await deps.readdir(dirUri);
    } catch (cause) {
      deps.showMessage(`Could not read directory: ${describeError(cause)}`, "error");
      return;
    }

    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    let visible: DirEntry[];
    try {
      visible = await deps.ignore.filterEntries({
        rootUri,
        dirUri,
        relativeDir,
        entries: sorted,
        showHidden,
      });
    } catch (cause) {
      // `IgnoreChecker.filterEntries` is documented never to throw
      // (`ignore.ts`'s TSDoc); guarded anyway (this codebase's
      // "guard even a documented never-throw dependency" convention).
      deps.showMessage(`Could not filter directory listing: ${describeError(cause)}`, "error");
      visible = sorted;
    }

    const children: ExplorerChild[] = visible.map((entry) => {
      const childUri = joinChildUri(dirUri, entry.name);
      const isDirectory = entry.type === "directory";
      relativeDirByUri.set(childUri, relativeDir.length > 0 ? `${relativeDir}/${entry.name}` : entry.name);
      parentByUri.set(childUri, dirUri);
      if (isDirectory) directoryUris.add(childUri);
      return { uri: childUri, name: entry.name, isDirectory };
    });

    childrenByDir.set(dirUri, children);
    fireChange();
  }

  function buildNodes(dirUri: Uri): ExplorerTreeNode[] | undefined {
    const children = childrenByDir.get(dirUri);
    if (!children) return undefined;
    return children.map((child) => ({
      id: child.uri,
      label: child.name,
      hasChildren: child.isDirectory,
      children: child.isDirectory && expanded.has(child.uri) ? buildNodes(child.uri) : undefined,
    }));
  }

  function toggle(uri: Uri, expanding: boolean): void {
    if (!directoryUris.has(uri)) return;
    if (expanding) {
      expanded.add(uri);
      if (!childrenByDir.has(uri)) {
        void reload(uri);
        return; // reload() itself fires the change once loaded.
      }
    } else {
      expanded.delete(uri);
    }
    fireChange();
  }

  function setShowHidden(value: boolean): void {
    if (showHidden === value) return;
    showHidden = value;
    // Reload everything already loaded (root + every expanded directory)
    // so the change is visible without a restart (this module's TSDoc).
    const loadedDirs = Array.from(childrenByDir.keys());
    fireChange(); // reflect the flag itself immediately; reloads land as they resolve.
    for (const dirUri of loadedDirs) void reload(dirUri);
  }

  function setSelectedId(id: Uri | undefined): void {
    if (selectedId === id) return;
    selectedId = id;
    fireChange();
  }

  function resolveTargetDirectory(): Uri | undefined {
    if (!rootUri) return undefined;
    if (selectedId && directoryUris.has(selectedId)) return selectedId;
    if (selectedId) {
      const parent = parentByUri.get(selectedId);
      if (parent) return parent;
    }
    return rootUri;
  }

  return {
    getRootUri: () => rootUri,
    getShowHidden: () => showHidden,
    setShowHidden,
    getSelectedId: () => selectedId,
    setSelectedId,
    getExpandedIds: () => Array.from(expanded),
    getNodes: () => (rootUri ? (buildNodes(rootUri) ?? []) : []),
    isDirectory: (uri) => directoryUris.has(uri),
    getName: (uri) => {
      const parent = parentByUri.get(uri);
      if (!parent) return undefined;
      return childrenByDir.get(parent)?.find((c) => c.uri === uri)?.name;
    },
    getParent: (uri) => parentByUri.get(uri),
    toggle,
    reload,
    resolveTargetDirectory,
    onDidChange,
  };
}
