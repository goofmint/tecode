/**
 * The ten `tecode.*` namespaces (Req 10.1, design.md §12) and the
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
import type { ResolvedTheme, ThemeContribution } from "./theme";
import type { CommandMeta, LanguageContribution } from "./manifest";

/* ------------------------------------------------------------------ */
/* tecode.commands                                                     */
/* ------------------------------------------------------------------ */

/** A command handler, invoked with whatever arguments `execute` was
 * called with. May return a value synchronously or a `Promise`. */
export type CommandHandler = (...args: unknown[]) => unknown;

/** One entry of `commands.list()` — the palette's view of a registered
 * command (design.md §5). */
export interface CommandDescriptor extends CommandMeta {
  id: string;
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
  /**
   * Delete the file or (empty or non-empty) directory at `uri` (Task 3.3,
   * Req 11.2 — the explorer's delete command). Rejects on failure (does
   * not exist, permission denied) — same never-silently-swallows contract
   * as {@link read}/{@link write}; the caller (the explorer built-in)
   * surfaces the rejection via `window.showMessage(..., "error")`.
   */
  delete(uri: Uri): Promise<void>;
  /**
   * Rename/move the file or directory at `oldUri` to `newUri` (Task 3.3,
   * Req 11.2 — the explorer's rename command). Rejects on failure
   * (`oldUri` missing, `newUri` already exists, permission denied) —
   * same contract as {@link delete}.
   */
  rename(oldUri: Uri, newUri: Uri): Promise<void>;
  /**
   * Create a new, empty directory at `uri` (Task 3.3, Req 11.2 — the
   * explorer's "New Folder" command). Rejects on failure (already exists,
   * parent missing, permission denied) — same contract as {@link delete}.
   */
  mkdir(uri: Uri): Promise<void>;
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
  /**
   * Save `uri`'s current text to disk (Req 11.1's save command). A no-op
   * (unopened `uri`, a readonly document, or a write failure) surfaces a
   * status-bar error rather than rejecting — this always resolves, never
   * throws, matching `applyEdits`'s own no-throw discipline (design.md
   * §14). Fires `onDidSave` on success.
   */
  save(uri: Uri): Promise<void>;
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
  /**
   * Validate the current value on every keystroke (Task 3.1, design.md
   * §12). A returned string is shown as a validation message and blocks
   * `showInputBox`'s promise from resolving on accept (Enter); `undefined`
   * means the current value is valid. Called once with the initial `value`
   * (or `""`) when the input box opens, so a required-field validator can
   * report immediately rather than only after the first keystroke.
   */
  validateInput?: (value: string) => string | undefined;
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
  readonly selections: readonly Selection[];
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
/* tecode.editor.find                                                  */
/* ------------------------------------------------------------------ */

/**
 * Per-editor in-buffer find/replace (Req 11.1, design.md §13's "Find/replace
 * state is per-editor, rendered as a ... inline widget"). All state — the
 * query, replacement text, current matches, case sensitivity, and whether
 * the widget is open — lives host-side, per document; this namespace is
 * only the action surface `editor-core`'s commands delegate to (design.md
 * §13's "pure command handlers"), never a place extension code reads state
 * back from directly. Every method no-ops with no active editor, the same
 * as the rest of {@link EditorNamespace}.
 */
export interface FindNamespace {
  /** Open the find widget for the active editor, preserving whatever
   * query/matches/case-sensitivity it already had (Req 11.1). */
  open(): void;
  /** Close the find widget. Query, matches, and case-sensitivity are left
   * intact for a subsequent {@link open} — only visibility toggles. */
  close(): void;
  /** Set the search query, recomputing matches against the active
   * document's current text and jumping to the nearest match at/after the
   * cursor (Req 11.1's "live match updates as the buffer changes"). */
  setQuery(query: string): void;
  /** Set the replacement text used by {@link replaceCurrent}/
   * {@link replaceAll}. Does not affect matches. */
  setReplaceQuery(query: string): void;
  /** Flip case-sensitive matching and recompute matches. */
  toggleCaseSensitive(): void;
  /** Advance to the next match, wrapping past the last one back to the
   * first (Req 11.1). A no-op with no matches. */
  next(): void;
  /** Move to the previous match, wrapping past the first one back to the
   * last (Req 11.1). A no-op with no matches. */
  previous(): void;
  /** Replace the current match with the replacement text, then advance to
   * whatever match now occupies its place (Req 11.1). A no-op with no
   * active match or a readonly document. */
  replaceCurrent(): void;
  /** Replace every match with the replacement text as a single undo step
   * (Req 11.1). A no-op with no matches or a readonly document. */
  replaceAll(): void;
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
   * 6.6, 11.1). No active editor: `[]`. */
  readonly selections: readonly Selection[];
  /** The primary cursor position (the active end of `selections[0]`). */
  readonly cursor: Position;
  /** Scroll so `line` is visible, driven by the primary cursor. */
  revealLine(line: number): void;
  /** Insert a snippet at each cursor (tab-stop syntax is host-defined;
   * `@tecode/api` only fixes the entry point). */
  insertSnippet(snippet: string): void;
  /** Apply edits to the active document (see `Document.applyEdits`). */
  applyEdits(edits: TextEdit[]): void;
  /**
   * The text of line `n` (0-based) of the active document, without its
   * line terminator (Req 11.1 — editor-core's movement/editing commands
   * read line text through this rather than a direct buffer handle, since
   * `Document` itself exposes no line-based reads). No active editor, or
   * `n` out of bounds: `""`.
   */
  getLine(line: number): string;
  /** Number of lines in the active document. No active editor: `0`. */
  readonly lineCount: number;
  /**
   * Replace the active editor's selections/cursors wholesale (Req 6.6,
   * 11.1) — how movement and selection commands report a new caret/
   * selection state. No active editor, or an empty array (a document
   * always has at least one selection): no-op.
   */
  setSelections(selections: readonly Selection[]): void;
  /** In-buffer find/replace (Req 11.1, design.md §13). */
  find: FindNamespace;
  /**
   * Fires whenever the active editor changes in a way a status line or
   * similar always-on summary view would want to redraw for (Task 3.4, Req
   * 11.6): the active editor SWITCHING (a different tab/document becomes
   * active, including to/from "no active editor") AND the active editor's
   * selections/cursor changing (a plain caret move, not just a text edit).
   * Carries no payload — the same "just re-read whatever you need, don't
   * diff what changed" shape as this codebase's other coarse `onDidChange`
   * events (`ThemesNamespace.onDidChange`, `ConfigNamespace.onDidChange`).
   * Does NOT fire on every keystroke by itself — a plain text edit with no
   * selection change fires `Document.onDidChange` instead (still reachable
   * via `window.activeEditor.document.onDidChange`), not this event; a
   * caller that wants both should subscribe to each once, re-subscribing
   * `document.onDidChange` on every active-editor switch this event reports
   * (`editor-core`/`statusbar`'s own pattern).
   */
  onDidChange: Event<void>;
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
 * Optional metadata a {@link UiNamespace.registerView} call can attach
 * beyond its component (Req 6.2; Issue #103 — "the explorer sidebar header
 * should show the workspace root's name, the way VS Code does"). `title`
 * is the only field exposed here (deliberately narrower than `@tecode/
 * core`'s internal `RegisterViewMeta`, which also carries `icon`/
 * `statusBar` for core-internal callers only — see `ui/slotRegistry.ts`);
 * an extension has no legitimate reason to override its own manifest-
 * declared icon or a `statusBar.item`'s placement through this path.
 */
export interface RegisterViewOptions {
  /**
   * A live title for this view, published by the extension itself AFTER
   * activation — e.g. the explorer setting its sidebar header to the open
   * folder's name instead of the static "Explorer" its manifest declares.
   * Superseses the manifest's `contributes.views[].title` for THIS view's
   * own rendering (`ui/shell.tsx`'s `Sidebar` reads `sidebarView.title`);
   * every other consumer of the manifest's static title — the command
   * palette's view-focus command label, the activity-bar icon's fallback
   * glyph/tooltip (`ActivityBar`'s `pair.activityItem?.title`) — is a
   * DIFFERENT `SlotViewEntry` (the paired `activityBar.item`, never
   * touched by this option) and keeps showing the manifest's original
   * title unchanged.
   *
   * Reactive, not a one-shot: call `registerView` again for the same
   * `(slot, id)` with a new `title` to update it later — `SlotRegistry`
   * last-wins on a duplicate `(slot, id)` exactly like a plain
   * re-registration, and fires `onDidChange` so `Sidebar` re-renders with
   * no restart needed. Omitting `title` (or omitting `options` entirely)
   * leaves whatever title is already on record — the manifest's static
   * one, if this view has never published its own — untouched.
   */
  title?: string;
}

/**
 * View registration and the common component library (Req 10.1, 6.3).
 */
export interface UiNamespace {
  /** Register `Component` as the content for view `id` in `slot` (Req
   * 6.3). Returns a {@link Disposable} that unregisters it. `options`
   * (Issue #103, Req 6.2) lets the registering extension publish a live
   * title alongside the component — see {@link RegisterViewOptions}. */
  registerView(
    slot: SlotId,
    id: string,
    component: ComponentType,
    options?: RegisterViewOptions,
  ): Disposable;
  /** Read the active theme; components must obtain all colors from here
   * rather than hard-coding literals (Req 7.3). */
  useTheme(): ResolvedTheme;
  List: ComponentType;
  Tree: ComponentType;
  Input: ComponentType;
  Tabs: ComponentType;
  /**
   * The integrated terminal's cell-grid renderer (Issue #98 Phase 4) —
   * owns a VT emulator and draws a live `PtySession`'s output, the same
   * "real, renderer-coupled implementation lives in `@tecode/core`, this
   * is just the `ComponentType`-shaped door into it" pattern {@link Tree}/
   * {@link List}/{@link Input}/{@link Tabs} already establish. Duck-typed
   * props (no dedicated exported prop type here, matching every other
   * component on this namespace — `@tecode/api` stays React-free): `{
   * session: PtySession | undefined; cols: number; rows: number }`. A
   * `panel.tab` extension (the `tecode.terminal` built-in) spawns the
   * session itself via {@link TerminalNamespace.spawn} and hands it to
   * this component as a prop — this component never spawns a process.
   */
  Terminal: ComponentType;
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
  /**
   * The registered {@link LanguageContribution} for `id`, or `undefined`
   * if no extension has registered a language under that id (Req 8.2,
   * 11.1). Lets a command handler read a language's `comments`/`brackets`
   * metadata — e.g. `editor-core`'s toggle-line-comment and bracket
   * auto-close commands — without maintaining its own copy of every
   * language's declaration.
   */
  getLanguage(id: string): LanguageContribution | undefined;
}

/* ------------------------------------------------------------------ */
/* tecode.themes                                                       */
/* ------------------------------------------------------------------ */

/**
 * Theme registration and the active theme (Req 7, 10.1).
 */
export interface ThemesNamespace {
  register(contribution: ThemeContribution): Disposable;
  /** The currently active, fully resolved theme. */
  readonly current: ResolvedTheme;
  /**
   * The currently active theme's display name (its `ThemeContribution.
   * label` — Task 3.4, Req 11.6's "statusbar... SHALL display... the
   * active theme name"). `current` itself carries only resolved colors/
   * tokens, with no id or label (`ResolvedTheme`'s own shape,
   * `theme.ts`) — this is the one place `tecode.themes` exposes the
   * active theme's HUMAN-READABLE identity to extension code, since
   * `theme.select`'s own id/label listing (`ThemeRegistry.list`) is a
   * privileged, core-internal surface with no `tecode.*` equivalent
   * (`ui/themeSelectCommand.ts`'s TSDoc).
   */
  readonly currentLabel: string;
  /**
   * Fires whenever the active theme changes — `theme.select`'s preview/
   * commit/revert, or a live `workbench.colorTheme` config switch (Task
   * 3.4, Req 7.5, 11.6). Carries no payload, mirroring `ThemeService.
   * onDidChange`'s own "just re-render/re-read" shape (`ui/themeService.
   * ts`) — a status line redraws `current`/`currentLabel` off this rather
   * than the event carrying either value itself.
   */
  onDidChange: Event<void>;
}

/* ------------------------------------------------------------------ */
/* tecode.clipboard                                                    */
/* ------------------------------------------------------------------ */

/**
 * The clipboard (Issue #91): an internal buffer holding the last text
 * copied or cut, write-through synced to the terminal's OWN system
 * clipboard via OSC 52 (`@opentui/core`'s `CliRenderer.
 * copyToClipboardOSC52`, `packages/cli/src/renderShell.tsx`'s
 * `onClipboardWriterReady`) when the host terminal supports it and
 * `clipboard.useSystemClipboard` (`editor-core`'s own configuration
 * contribution) is enabled. Backs `editor-core`'s
 * `editor.action.clipboardCopy`/`clipboardCut`/`clipboardPaste` commands
 * (Issue #91), and is available to any other extension that wants
 * programmatic access to the same buffer.
 *
 * **Never throws — matches `FileSystem`'s never-crash discipline, NOT its
 * reject-on-failure one**: unlike {@link FileSystem}'s `read`/`write`
 * (which reject the returned promise on a real I/O failure — a caller is
 * expected to handle that), a clipboard write's OSC 52 half is a
 * best-effort terminal escape sequence with no reliable failure signal at
 * all — a terminal that ignores it produces neither an error nor any
 * other observable difference from success. {@link write} therefore always
 * resolves once the INTERNAL buffer is updated (the part every terminal
 * supports unconditionally); an OSC 52 write that the host reports failing
 * is logged (`HostLog`, design.md §14) and otherwise swallowed, never
 * surfaced as a rejection.
 *
 * **OSC 52 is write-only here, deliberately**: reading a terminal's system
 * clipboard back via OSC 52 is not portable across terminals (many either
 * don't implement the query form at all or gate it behind a user prompt),
 * so {@link read} only ever reports this namespace's OWN internal buffer —
 * never attempts a live OSC 52 query. This means `read()` sees exactly
 * what THIS process (or another `tecode.clipboard.write` caller) most
 * recently wrote, not necessarily whatever the OS clipboard currently
 * holds if something else changed it in between.
 */
export interface ClipboardNamespace {
  /**
   * The clipboard's current internal buffer contents (this namespace's
   * TSDoc's "OSC 52 is write-only" note) — `""` when nothing has been
   * copied/cut yet this session. Always resolves; never rejects.
   */
  read(): Promise<string>;
  /**
   * Store `text` as the clipboard's new internal buffer contents, and
   * (when system-clipboard sync is enabled and the host terminal
   * supports it) write it through to the terminal's OWN clipboard via OSC
   * 52. Always resolves once the internal buffer is updated — an OSC 52
   * write failure is logged and swallowed, never surfaced as a rejection
   * (this namespace's TSDoc).
   */
  write(text: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* tecode.terminal                                                     */
/* ------------------------------------------------------------------ */

/**
 * Options for spawning one pseudo-terminal-attached child process (Issue
 * #98). `cmd[0]` is the executable to run; the remaining entries are its
 * argv (matches `node:child_process`'s/Bun's own `cmd` array shape — no
 * shell parsing is done on it).
 */
export interface PtySpawnOptions {
  /** Argv: `cmd[0]` is the executable, the rest are its arguments. */
  cmd: string[];
  /** Working directory for the spawned process. Host-defined default (the
   * host process's own cwd) when omitted. */
  cwd?: string;
  /** Extra environment variables layered over the host's own `process.env`
   * for the spawned process (host-defined key wins on a collision, EXCEPT
   * `TERM`: the host always forces this to a 256-color terminal name
   * regardless of what is passed here, since the pty needs a real
   * terminfo entry for a full-screen TUI's cursor addressing/colors to
   * render correctly — an under-informed `TERM` here would silently
   * degrade every such program, not just this one call). */
  env?: Record<string, string>;
  /** Initial pty column count. */
  cols: number;
  /** Initial pty row count. */
  rows: number;
}

/** Payload of {@link PtySession.onExit}: the spawned CHILD PROCESS's own
 * exit code — not any lower-level pty-stream lifecycle status the host's
 * pty implementation may track internally for its own bookkeeping. */
export interface PtyExitEvent {
  exitCode: number;
}

/**
 * One live pseudo-terminal-attached child process (Issue #98), returned by
 * {@link TerminalNamespace.spawn}. Every failure this session's own
 * operations can hit (a process that has already died, a write to a
 * disposed session, ...) is reported through the host's own logging and
 * swallowed — none of `write`/`resize`/`dispose` ever throws (matches
 * {@link FileSystem}'s `watch`, not its reject-on-failure `read`/`write`).
 */
export interface PtySession {
  /** Send `data` to the child process as raw terminal input (keystrokes,
   * pasted text, escape sequences the caller constructs itself — e.g.
   * `"\x1b[B"` for a Down-arrow key). A no-op once {@link dispose} has
   * been called. */
  write(data: string): void;
  /**
   * Resize the pty. The child process is expected to notice this the same
   * way it would notice a real terminal resizing — a well-behaved program
   * redraws for the new dimensions without any other signal from the
   * caller. A no-op once {@link dispose} has been called.
   */
  resize(cols: number, rows: number): void;
  /** Fires for every chunk of raw output bytes the child process writes to
   * its side of the pty (its own stdout/stderr, interleaved exactly as a
   * real terminal would receive them) — feed these, in order, to a VT
   * parser to reconstruct what the program is drawing. */
  onData: Event<Uint8Array>;
  /** Fires exactly once, when the child process exits, with its exit
   * code. Never fires again after. This INCLUDES an exit caused by
   * calling {@link dispose} — `dispose` stops the child process by
   * actually killing it, so the child genuinely exits, and this event
   * reports that exit like any other; it is not suppressed just because
   * the exit was caller-initiated. A caller that calls `dispose` itself
   * must therefore tolerate an `onExit` arriving afterward and treat it
   * as a no-op (matches this contract's known consumers — `@tecode/
   * builtin`'s terminal `store.ts` and `@tecode/cli`'s
   * `terminalSessionTracker.ts` — both of which are already written this
   * way). */
  onExit: Event<PtyExitEvent>;
  /**
   * Tear down this session: stop the child process and release the pty.
   * Idempotent — calling this more than once (or after the child has
   * already exited on its own) is always safe and never throws.
   */
  dispose(): void;
}

/**
 * The integrated terminal (Issue #98): spawn a child process attached to a
 * real pseudo-terminal (pty) so full-screen, cursor-addressing CLIs (a
 * shell, `claude`, ...) run and redraw correctly, the same way they would
 * in the user's own terminal emulator.
 *
 * **Vocabulary, used deliberately throughout this namespace's TSDoc**:
 * "terminal" names the FEATURE this namespace exposes (matches its own
 * `Tecode.terminal` field name) — spawning and driving an interactive
 * program from an extension. "pty" (pseudo-terminal) names the underlying
 * OS PRIMITIVE {@link PtySession} wraps: the kernel-level device pair a
 * process can be attached to so it believes it is talking to a real
 * terminal (`isTTY` true, `SIGWINCH` on resize, cursor-addressing escape
 * sequences work). Every method/type below is one or the other, never
 * both at once — {@link spawn}/{@link PtySpawnOptions}/{@link PtySession}
 * are all pty-primitive-shaped (they spawn and drive the OS object
 * directly); {@link isSupported} answers a feature-level question ("can
 * this host offer the terminal feature at all").
 *
 * **Platform support**: the pty primitive this namespace is built on
 * (`Bun.Terminal`) is unconditionally available on Linux/macOS, and on
 * Windows as of Bun 1.3.14 (2026-05-13), which added ConPTY-backed
 * support (`CreatePseudoConsole`) — below that Bun version, Windows has
 * none. {@link isSupported} reports `false` only in that below-threshold
 * Windows case, and {@link spawn} degrades to an inert, harmless session
 * there rather than throwing (this namespace never throws — see {@link
 * PtySession}'s TSDoc).
 */
export interface TerminalNamespace {
  /** Whether this host can spawn ptys at all (Issue #98's Windows
   * degradation) — `false` on an unsupported platform. A caller should
   * check this before offering terminal UI, but {@link spawn} itself
   * never throws even when this is `false` (see its own TSDoc). */
  isSupported(): boolean;
  /**
   * Spawn `options.cmd` attached to a new pty and return a live {@link
   * PtySession} for it. Never throws — see {@link PtySession}'s TSDoc.
   * On an unsupported platform, or when the underlying spawn itself fails
   * (`options.cmd[0]` does not exist, ...), the returned session is inert:
   * `write`/`resize` are no-ops, `onData` never fires, and `onExit` fires
   * once with a non-zero `exitCode` shortly after this call returns (a
   * caller that subscribes to `onExit` immediately after receiving the
   * session — before this call site's own microtask queue runs again —
   * always observes it).
   */
  spawn(options: PtySpawnOptions): PtySession;
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
  clipboard: ClipboardNamespace;
  terminal: TerminalNamespace;
}
