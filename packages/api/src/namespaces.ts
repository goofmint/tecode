/**
 * The nine `tecode.*` namespaces (Req 10.1, design.md §12) and the
 * aggregate {@link Tecode} interface that bundles them into the single
 * frozen object handed to every extension.
 */

import type {
  Disposable,
  Event,
  Listener,
  Position,
  Selection,
  TextEdit,
  Uri,
} from "./primitives";
import type { Document } from "./document";
import type { ResolvedTheme } from "./theme";
import type { CommandMeta, LanguageContribution } from "./manifest";

/* ------------------------------------------------------------------ */
/* tecode.commands                                                     */
/* ------------------------------------------------------------------ */

/** A command handler, invoked with whatever arguments `execute` was
 * called with. May return a value synchronously or a `Promise`. */
export type CommandHandler = (...args: unknown[]) => unknown;

/** One entry of `commands.list()` — the palette's view of a registered
 * command (design.md §5). */
export interface CommandDescriptor {
  id: string;
  title?: string;
  category?: string;
  when?: string;
}

/**
 * The command registry (Req 3, Req 10.1). All cross-module behavior in
 * tecode — keybindings, the palette, UI callbacks, extension-to-extension
 * calls — goes through here rather than direct function calls (Req 1.5).
 */
export interface CommandsNamespace {
  /**
   * Register a command handler under `id` (`namespace.verb` form — Req
   * 3.2). Re-registering an existing ID replaces its handler
   * (design.md §5). Returns a {@link Disposable} that unregisters it.
   */
  register(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable;
  /**
   * Execute a command by ID. Never throws to the caller (Req 3.4, 3.5):
   * an unknown ID or a handler exception is caught, surfaced in the
   * status bar, and resolves the returned promise to `undefined`.
   */
  execute(id: string, ...args: unknown[]): Promise<unknown>;
  /** List every registered command, for the palette to filter by
   * `when` and fuzzy-match. */
  list(): CommandDescriptor[];
}

/* ------------------------------------------------------------------ */
/* tecode.workspace                                                    */
/* ------------------------------------------------------------------ */

/** The kind of filesystem entry a {@link FileStat} or {@link DirEntry}
 * describes. */
export type FileType = "file" | "directory" | "symlink" | "unknown";

/** Metadata about a filesystem entry, as returned by `fs.stat`. */
export interface FileStat {
  type: FileType;
  /** Size in bytes. */
  size: number;
  /** Last-modified time, in milliseconds since the Unix epoch. */
  mtime: number;
  /** Creation/status-change time, in milliseconds since the Unix
   * epoch. */
  ctime: number;
}

/** One entry returned by `fs.readdir`. */
export interface DirEntry {
  name: string;
  type: FileType;
}

/** The kind of change reported by `fs.watch`. */
export type FileChangeType = "created" | "changed" | "deleted";

/** An event fired by an `fs.watch` subscription. */
export interface FileChangeEvent {
  type: FileChangeType;
  uri: Uri;
}

/**
 * Filesystem access, wrapping `node:fs/promises` and `fs.watch` behind the
 * API so a future virtual filesystem stays possible; the MVP imposes no
 * sandboxing (Req 10.2, design.md §12).
 */
export interface FileSystem {
  read(uri: Uri): Promise<Uint8Array>;
  write(uri: Uri, content: Uint8Array): Promise<void>;
  stat(uri: Uri): Promise<FileStat>;
  readdir(uri: Uri): Promise<DirEntry[]>;
  /** Watch a file or directory for changes. Returns a {@link Disposable}
   * that stops the watch. */
  watch(uri: Uri, listener: Listener<FileChangeEvent>): Disposable;
}

/**
 * The open workspace (a single root directory in the MVP) and its open
 * documents (Req 10.1).
 */
export interface WorkspaceNamespace {
  /** The workspace root, or `undefined` when tecode was opened on a
   * single file with no enclosing workspace. */
  readonly rootUri: Uri | undefined;
  /** Open (or return the already-open) document for `uri`. */
  openDocument(uri: Uri): Promise<Document>;
  /** All currently open documents. */
  readonly documents: readonly Document[];
  readonly fs: FileSystem;
  onDidOpen: Event<Document>;
  onDidClose: Event<Document>;
  onDidSave: Event<Document>;
}

/* ------------------------------------------------------------------ */
/* tecode.window                                                       */
/* ------------------------------------------------------------------ */

/** Severity of a `window.showMessage` notification. */
export type MessageKind = "info" | "warning" | "error";

/** One selectable item in `window.showQuickPick`. */
export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface QuickPickOptions {
  placeHolder?: string;
  canPickMany?: boolean;
}

export interface InputBoxOptions {
  prompt?: string;
  value?: string;
  placeHolder?: string;
  /** Mask the input, for secrets. */
  password?: boolean;
}

/** Which side of the status bar an item renders on, and its sort
 * priority within that side (higher first — Req 6.2). */
export interface StatusBarItem {
  id: string;
  text: string;
  tooltip?: string;
  side: "left" | "right";
  priority: number;
}

/** The active editor's document and cursor/selection state. */
export interface Editor {
  document: Document;
  selections: Selection[];
}

/**
 * Window-level UI: notifications, pickers, and the status bar (Req 10.1).
 */
export interface WindowNamespace {
  /** The editor currently in focus, or `undefined` if none. */
  readonly activeEditor: Editor | undefined;
  showMessage(message: string, kind?: MessageKind): void;
  showQuickPick(
    items: QuickPickItem[],
    options?: QuickPickOptions,
  ): Promise<QuickPickItem | undefined>;
  showInputBox(options?: InputBoxOptions): Promise<string | undefined>;
  /** Create or update a status bar item. Returns a {@link Disposable}
   * that removes it. */
  setStatusBarItem(item: StatusBarItem): Disposable;
}

/* ------------------------------------------------------------------ */
/* tecode.editor                                                       */
/* ------------------------------------------------------------------ */

/**
 * Operations on the active editor (Req 10.1). Calls made with no active
 * editor no-op with a status-bar notice (design.md §12).
 */
export interface EditorNamespace {
  /** The active editor's selections/cursors (first-class array — Req
   * 6.6, 11.1). */
  readonly selections: Selection[];
  /** The primary cursor position (the active end of `selections[0]`). */
  readonly cursor: Position;
  /** Scroll so `line` is visible, driven by the primary cursor. */
  revealLine(line: number): void;
  /** Insert a snippet at each cursor (tab-stop syntax is host-defined;
   * `@tecode/api` only fixes the entry point). */
  insertSnippet(snippet: string): void;
  /** Apply edits to the active document (see `Document.applyEdits`). */
  applyEdits(edits: TextEdit[]): void;
}

/* ------------------------------------------------------------------ */
/* tecode.ui                                                           */
/* ------------------------------------------------------------------ */

/** The UI slot a view can be registered into (Req 6.2). */
export type SlotId =
  | "activityBar.item"
  | "sidebar.view"
  | "panel.tab"
  | "statusBar.item"
  | "editor.viewType";

/**
 * A UI component type. `@tecode/api` has no dependency on React (or any UI
 * framework), so this is modeled loosely as a props-in/element-out
 * function rather than `React.ComponentType`; `@tecode/core` substitutes
 * the real React component type at the integration boundary
 * (design.md §12).
 */
export type ComponentType<P = Record<string, unknown>> = (props: P) => unknown;

/**
 * View registration and the common component library (Req 10.1, 6.3).
 */
export interface UiNamespace {
  /** Register `Component` as the content for view `id` in `slot` (Req
   * 6.3). Returns a {@link Disposable} that unregisters it. */
  registerView(slot: SlotId, id: string, component: ComponentType): Disposable;
  /** Read the active theme; components must obtain all colors from here
   * rather than hard-coding literals (Req 7.3). */
  useTheme(): ResolvedTheme;
  List: ComponentType;
  Tree: ComponentType;
  Input: ComponentType;
  Tabs: ComponentType;
}

/* ------------------------------------------------------------------ */
/* tecode.config                                                       */
/* ------------------------------------------------------------------ */

/** Fired by `config.onDidChange`; `affectsConfiguration` reports whether a
 * given key (or one of its children) changed (Req 9.4). */
export interface ConfigChangeEvent {
  affectsConfiguration(key: string): boolean;
}

/**
 * Read access to the merged (defaults ← user ← workspace) settings tree
 * (Req 9, 10.1).
 */
export interface ConfigNamespace {
  get<T = unknown>(key: string): T | undefined;
  onDidChange: Event<ConfigChangeEvent>;
}

/* ------------------------------------------------------------------ */
/* tecode.context                                                      */
/* ------------------------------------------------------------------ */

/**
 * The flat context-key store `when` clauses evaluate against (Req 4.6,
 * 10.1).
 */
export interface ContextNamespace {
  set(key: string, value: unknown): void;
  get<T = unknown>(key: string): T | undefined;
}

/* ------------------------------------------------------------------ */
/* tecode.languages                                                    */
/* ------------------------------------------------------------------ */

/**
 * Programmatic language registration (a runtime-equivalent of
 * `contributes.languages` — Req 8.2, 10.1) and language-ID lookup.
 */
export interface LanguagesNamespace {
  register(contribution: LanguageContribution): Disposable;
  /** The language ID resolved for `uri` (`"plaintext"` if none match —
   * Req 8.3). */
  getLanguageId(uri: Uri): string;
}

/* ------------------------------------------------------------------ */
/* tecode.themes                                                       */
/* ------------------------------------------------------------------ */

/** A theme registered at runtime (a runtime-equivalent of one
 * `contributes.themes` entry). */
export interface ThemeContribution {
  id: string;
  label: string;
  /** Path to the theme's VS Code-subset color theme JSON. */
  path: string;
}

/**
 * Theme registration and the active theme (Req 7, 10.1).
 */
export interface ThemesNamespace {
  register(contribution: ThemeContribution): Disposable;
  /** The currently active, fully resolved theme. */
  readonly current: ResolvedTheme;
}

/* ------------------------------------------------------------------ */
/* Tecode — the aggregate namespace object                            */
/* ------------------------------------------------------------------ */

/**
 * The complete `tecode` API object handed to every extension (built-in or
 * third-party) via `ExtensionContext.api`, and available as the `"tecode"`
 * module alias at runtime (design.md §2). Frozen shallowly per namespace
 * by the host so extensions cannot monkey-patch across each other
 * (design.md §12).
 */
export interface Tecode {
  commands: CommandsNamespace;
  workspace: WorkspaceNamespace;
  window: WindowNamespace;
  editor: EditorNamespace;
  ui: UiNamespace;
  config: ConfigNamespace;
  context: ContextNamespace;
  languages: LanguagesNamespace;
  themes: ThemesNamespace;
}
