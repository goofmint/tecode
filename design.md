# Design Document — tecode (TUI Programming Editor, MVP)

This document describes the technical design that satisfies `requirements.md`. Requirement references (e.g. *Req 4.7*) point at the numbered acceptance criteria there.

## 1. Overview

tecode is a Bun/TypeScript TUI editor built on OpenTUI. The core is a thin runtime with five responsibilities — extension hosting, command dispatch, keymap resolution, document management, and the UI shell — plus configuration. Everything else, including all bundled features, is an extension using the public `tecode` API.

The design centers on three internal buses that everything plugs into:

- the **command registry** (all behavior is a named command),
- the **context service** (all conditional behavior is a `when` clause over context keys),
- the **event emitters** on documents and configuration (all reactions are subscriptions).

```mermaid
graph TD
    CLI[cli: entry point] --> Core
    subgraph Core
        Host[extension host]
        Cmd[command registry]
        Key[keymap service]
        Ctx[context service]
        Doc[document manager]
        UI[UI shell / slot registry]
        Theme[theme service]
        Lang[language registry]
        Cfg[config service]
    end
    Host -->|activate| Ext[extensions builtin + user + workspace]
    Ext -->|tecode.* API| Cmd
    Ext --> UI
    Ext --> Lang
    Ext --> Theme
    Key -->|execute| Cmd
    Key -->|evaluate when| Ctx
    UI -->|render| OpenTUI[@opentui/react renderer]
    Doc --> UI
    Theme --> UI
    Cfg --> Theme
    Cfg --> Key
```

## 2. Repository and Package Layout

Bun workspaces monorepo (*Req 1.2, 1.3*):

```
packages/
  api/             @tecode/api — type declarations only, zero deps, zero runtime code
  core/            @tecode/core — implements the api against OpenTUI
    src/host/        extension discovery, manifest validation, activation
    src/commands/    command registry
    src/keymap/      key event pipeline, chord state machine, when-clause evaluator
    src/buffer/      Document, LineBuffer, UndoStack, DocumentManager
    src/ui/          Shell, slot registry, theme provider, common components
    src/config/      settings/keybindings loading, JSONC parser, file watcher
    src/api/         builds the concrete `tecode` namespace object handed to extensions
  builtin/         @tecode/builtin — one directory per bundled extension
    explorer/  editor-core/  command-palette/  themes-default/
    languages-basic/  statusbar/  keybindings-editor/
  cli/             @tecode/cli — arg parsing, wiring, `bun build --compile` target
```

Dependency rule enforcement: `api` has an empty `dependencies` field; `builtin/*` list only `@tecode/api` (types) — at runtime they receive the API object by injection, never by importing `core`. An ESLint `no-restricted-imports` rule (checked in CI) forbids `@tecode/core` imports outside `cli`.

**API injection.** Extensions import types from `@tecode/api` but obtain the live API from the host: the host loads each extension module and calls `activate(ctx)` where `ctx.api` is the `tecode` namespace object. For ergonomics the host also registers the object as a Bun module alias so `import { commands } from "tecode"` resolves at runtime, both in dev and inside the compiled binary. This is what keeps built-ins unprivileged (*Req 1.4*): they receive exactly the same object as user extensions.

## 3. Startup Sequence

Order (*Req 12.1*), with first paint before extension code runs (*Req 12.2*):

1. **Synchronous, before first frame (< 100 ms budget):** parse argv; load user + workspace settings and keybindings (JSONC); detect terminal capabilities (Kitty protocol, color depth); build the theme from the configured theme's cached JSON (themes-default's JSON files are embedded assets, so no extension activation is needed to paint); render the Shell with empty slots and a placeholder editor area.
2. **Deferred (queueMicrotask after first frame):** discover extensions and validate manifests; register declared contributions; fire `onStartup` activations; open the file/directory from argv (which fires `onLanguage:*` activations).
3. Manifest reading executes `manifest.ts` as a module (it is TypeScript), but manifests are constrained by convention and validation to be pure data (`export default {...} satisfies Manifest`); the extension's `index.ts` is not imported until activation (*Req 2.2*).
4. **Shutdown** (*Req 12.3*, Issue #84): `createCliRenderer()` puts stdin in raw mode, which disables signal generation, so an interactive Ctrl+C never reaches Node as a real `SIGINT` — OpenTUI's own `exitOnCtrlC` key handling (default `true`) intercepts the byte itself and calls `CliRenderer.destroy()` directly. `destroy()`'s `finalizeDestroy()` never calls `process.exit` itself, so `main.ts` wires its shutdown sequence to `createCliRenderer`'s `onDestroy` config callback (`renderShell.tsx`'s `ShellRenderDeps.onDestroy`), which fires synchronously from inside that teardown with nothing left afterward to catch a throw; `onDestroy` was chosen over subscribing to the `CliRenderEvents.DESTROY` event (which this module already uses for `CAPABILITIES`) because `finalizeDestroy()` emits that event partway through its own teardown, via a plain `EventEmitter.emit` with no try/catch, whereas `onDestroy` fires at the very end and is already wrapped in the library's own try/catch. `SIGINT`/`SIGTERM` (the paths that fire when stdin is NOT in raw mode: `kill`, a supervising shell, headless mode) call the exact same shutdown sequence. The sequence itself (`main.ts`'s `createShutdown`) is a single memoized promise shared by every trigger — so whichever fires first runs the real teardown (flush layout state, dispose every core-owned service, deactivate every extension) and whichever fires afterward, or concurrently, awaits that same settling promise rather than racing a `process.exit(0)` ahead of it — raced against a bounded timeout (a couple of seconds) so a hung disposal degrades to a logged warning rather than hanging forever. That timeout bounds only the `shutdown()` PROMISE, not whatever pending I/O it gave up waiting on — a genuinely hung `flush()`/`dispose()` would otherwise keep the event loop (and the process) alive indefinitely even after `shutdown()` settles, reintroducing the unquittable-editor risk the timeout exists to prevent — so every one of `onDestroy`/`SIGINT`/`SIGTERM` explicitly calls `process.exit(0)` once `shutdown()` settles (`void shutdown().finally(() => process.exit(0))`), rather than relying on the process to exit "naturally" once the loop happens to drain.

## 4. Extension Host

### 4.1 Discovery and registration

`discover()` scans, in order: the embedded `builtin/` registry, `~/.config/tecode/extensions/*/`, `<workspace>/.tecode/extensions/*/` (*Req 2.1*). For each directory it dynamically imports `manifest.ts` (or `manifest.js`) and validates the default export against the `Manifest` schema with a hand-rolled validator in `core/host/validate.ts` (no runtime schema library, keeps the binary lean). A failed validation records a `HostError { extensionId?, path, message }` that the statusbar extension surfaces; startup continues (*Req 2.4*).

Duplicate extension IDs resolve by discovery order — later wins (workspace > user > builtin) — and the shadowed one is reported as a warning. This gives users a natural override path.

Registration walks `contributes` and pushes declarations into the command registry (as *lazy commands*), keymap service, slot registry (as *lazy views*), config schema registry, language registry, and theme registry — all without touching `index.ts`.

A manifest's `contributes.commands` entries reach `registerLazy` (§5) the same way a runtime `tecode.commands.register` call does, so a manifest declaring a core-reserved command ID is rejected there too, not only on the runtime path.

### 4.2 Activation

Activation events (*Req 2.5*):

- `onStartup` — after first frame.
- `onCommand:<id>` — the command registry maps each contributed command to its extension; executing a lazy command activates the extension first, then re-dispatches.
- `onLanguage:<id>` — the document manager notifies the host when a document with that language opens. Lazy views work the same way: revealing a contributed view slot activates its extension before mounting the component.

`activate(ctx)` receives `ExtensionContext { api, extensionUri, subscriptions: Disposable[], storagePath }`. On deactivation/shutdown the host disposes `subscriptions` in reverse order and calls `deactivate()` if exported (*Req 2.6*). Activation is wrapped in try/catch: a throwing extension is marked failed, its contributions stay registered but its commands report the failure when invoked.

### 4.3 API versioning

`api` exports `API_VERSION = "1.0"` (major.minor). Manifests declare `apiVersion: "1"` or `"1.x"`. Compatibility: same major, host minor ≥ requested minor. Incompatible extensions are skipped at registration with a surfaced error (*Req 2.7*).

### 4.4 Loading inside the compiled binary

Built-ins are compiled into the binary as ordinary imports (their manifest data in a static registry). External extensions load via `import(pathToFileURL(file).href)` — Bun's runtime transpiles TS/TSX on the fly, which OpenTUI's own tooling relies on (*Req 10.4*). Extensions with npm dependencies ship a pre-bundled `index.js`; the host prefers `index.js` over `index.ts` when both exist.

`extensions.reload` (*Req 2.8*): MVP implementation re-execs the process (`Bun.spawn` of `process.execPath` with the same argv, then exit) after persisting layout state.

## 5. Command Registry

`core/commands/registry.ts` — a `Map<string, CommandEntry>` where `CommandEntry = { handler?, meta, extensionId?, lazy }`.

- `register(id, handler, meta?)` returns a `Disposable`; re-registering an existing ID replaces the handler and logs a warning (last-wins keeps hot-reload simple).
- `execute(id, ...args)` is async and **never throws** (*Req 3.4, 3.5*): unknown ID → status-bar error `Command not found: <id>`; handler exception → caught, logged to the host log, surfaced in the status bar; the returned promise resolves to `undefined` in both failure cases and to the handler's return value on success.
- `list()` returns `{ id, title, category, when }[]` for the palette; entries whose `when` evaluates false against current context are filtered by the palette, not the registry.
- `registerCore(id, handler, meta?)` is a host-internal fourth method — not part of `tecode.commands` (`api/create.ts` names only `register`/`execute`/`list` on that namespace) — reachable only from the composition root (`cli/main.ts`'s `buildAssemblyRoot`, which calls it for every core command before `runDeferredPhase`'s `loadExtensions` runs). It registers exactly like `register` and additionally marks `id` reserved; disposing the returned `Disposable` clears the reservation along with the entry.
- A `register`/`registerLazy` call on a reserved ID is rejected rather than last-wins (*Req 3.6*): the registry reports the rejection to the host log and the status bar and returns a no-op `Disposable`, leaving the core handler in place and never throwing.

## 6. Keymap Service

### 6.1 Input pipeline

```
terminal bytes → OpenTUI key event → chord state machine → binding lookup → when filter → commands.execute
                                                              ↳ no match → focused component (editor insert, list navigation)
```

The keymap service subscribes to OpenTUI's parsed key events at the shell root (capture phase). If a key matches a pending chord prefix or a full binding whose `when` passes, it is consumed; otherwise it falls through to the focused component.

### 6.2 Resolution model

At load time the service builds a single ordered binding table from five layers (*Req 4.1*), lowest precedence first: core defaults, the terminal-capability `fallback` overlay (§6.5), extension manifest bindings, the selected `preset` (§6.6), and finally the user's own `keybindings.json` — later entries take precedence, and an entry `{ key, command: "-x" }` inserts a *removal* record that masks strictly-earlier bindings of `x` on that key (*Req 4.3*); because masking and override are both order-directional, a layer can only cancel or beat one BELOW it. Lookup normalizes key strings (`ctrl+shift+p` — order-insensitive modifiers, lowercase key) into a canonical form used as the table key.

### 6.3 Chords

Two-stroke chords (*Req 4.4*) use `@opentui/keymap`'s sequence engine: the table stores sequences of 1–2 canonical strokes. When a stroke matches only prefixes, the service enters *pending* state (status bar shows e.g. `(ctrl+k)`), with a 3-second timeout and Escape to cancel. A stroke that completes no sequence in pending state is discarded (VS Code behavior), not replayed.

### 6.4 When-clause evaluator

`core/keymap/when.ts` implements a tiny recursive-descent parser for the MVP grammar (*Req 4.5*):

```
expr   := or
or     := and ("||" and)*
and    := unary ("&&" unary)*
unary  := "!" unary | primary
primary:= key | key "==" value | "(" expr ")"
```

Clauses are parsed once at registration into an AST and evaluated against the context service on each lookup. Unknown keys evaluate to `undefined` (falsy). The context service (`tecode.context`, *Req 4.6*) is a flat `Map<string, unknown>` with a change event; core maintains `editorFocus`, `editorTextFocus`, `editorLangId`, and focus keys as focus moves; extensions set their own (e.g. `explorerFocus`).

### 6.5 Terminal capability fallback

On startup the service performs Kitty Keyboard Protocol detection (query via OpenTUI; also honoring `$TERM`/`$TERM_PROGRAM` heuristics for tmux passthrough). If unsupported, it overlays `keybindings.fallback.json` — shipped in the binary, user-overridable from `~/.config/tecode/` — remapping bindings that need disambiguated modifiers (e.g. `ctrl+shift+p` → `ctrl+p p` chord alternatives) (*Req 4.7, 13.3*). The fallback layer sits between core defaults and extension bindings so explicit user bindings still win.

### 6.6 Keybinding presets (Issue #81 Phase 2)

A `keybindings.preset` setting (*Req 4.8*) selects a bundled keybinding scheme by name — `"default"` (no-op), `"emacs"`, or `"windows"`, resolved by `core/keymap/presetKeybindings.ts`'s `resolveKeybindingPreset` from statically-imported JSON assets under `core/keymap/presets/` (same "shipped in the compiled binary via Bun's static-JSON-import embedding" mechanism `keybindings.fallback.json` already uses — no filesystem read at all, since a preset is selected, not authored, so there is no user-override seam the way the fallback keymap has one). The resolved entries populate a fifth binding-table layer, `preset`, deliberately placed **above `extension`, below `user`** — *not* between `defaults` and `fallback` as an earlier draft of this design had it. That placement is load-bearing, not stylistic: a preset exists specifically to override an extension's own default binding on a key the user opted to remap (e.g. Emacs's `ctrl+f`/`ctrl+s` overriding `editor-core`'s find/save), and both `lookup`'s "highest-order, when-passing entry wins" rule and the removal-masking rule ("a `-command` removal masks only strictly-lower-order bindings of that command," `bindingTable.ts`'s `visibleEntries`) only let a *later* layer override or remove an *earlier* one. With `preset` below `extension`, an override would silently lose to the extension's own binding, and worse, a `-command` removal aimed at an extension binding would be inert.

That masking rule is also why the Emacs preset ships more than a plain remap: `keybindings-editor`'s manifest binds `ctrl+k ctrl+s` → `keybindings.open` unconditionally. §6.3's chord machine checks `hasSequencePrefix` before ever trying an exact match ("prefix wins"), so as long as that chord is registered and visible, every bare `ctrl+k` keystroke would enter chord-pending state first — permanently shadowing Emacs's own `ctrl+k` → kill-line (`editor.action.deleteLine`) binding. `presets/emacs.json` therefore also carries a `{ "key": "ctrl+k ctrl+s", "command": "-keybindings.open" }` removal record, which only takes effect because `preset` outranks `extension`.

The setting is applied and live-reloaded exactly like `workbench.colorTheme` (§11): the composition root (`cli/main.ts`) reads and resolves the initial value once `config.ready` settles, and `cli/keybindingPresetConfigSync.ts`'s `wireKeybindingPresetConfigSync` subscribes to `ConfigService.onDidChange` for every subsequent change, re-resolving with no restart. An unrecognized preset name (or `"default"`) resolves to `[]`; only an unrecognized name also logs a warning. `"vim"` is deliberately not one of the bundled presets — every `when` context in this design (`editorTextFocus`, `editorFocus`, `quickPickFocus`, `inputBoxFocus`, `findWidgetFocus`, `explorerFocus`, `editorLangId`) is purely focus-based, with no mode concept a non-modal "vim" preset could honestly model.

## 7. Documents and Buffer

### 7.1 Data model

```ts
class LineBuffer {            // TS-side line array (decision #1)
  private lines: string[]
  getLine(n): string
  get lineCount(): number
  applyEdits(edits: TextEdit[]): AppliedEdit[]   // sorted desc, applied atomically
  offsetAt(pos: Position): number                // future LSP mapping
  positionAt(offset: number): Position
}

class Document {
  uri: Uri; languageId: string; eol: "\n" | "\r\n"
  version: number; dirty: boolean; readonly: boolean
  private buffer: LineBuffer
  private undo: UndoStack
  applyEdits(edits: TextEdit[], opts?: { undoGroup?: string }): void
  transaction(fn: () => void): void
  onDidChange: Event<DocumentChangeEvent>
}
```

- `TextEdit = { range: Range, newText: string }`; ranges are `{ start: Position, end: Position }` with 0-based line/character (LSP-compatible).
- `applyEdits` validates ranges, sorts edits bottom-up, applies them, bumps `version`, computes inverse edits for undo, and emits one `DocumentChangeEvent` per call (*Req 5.2, 5.3*). On a `readonly` document it surfaces a status-bar error and does nothing.
- **Undo/redo** (*Req 5.4*): `UndoStack` stores entries of `{ inverseEdits, selectionsBefore, selectionsAfter, groupId }`. `transaction(fn)` opens a group so every `applyEdits` inside shares one `groupId`; typing coalesces consecutive single-character inserts on the same line within 750 ms into one group. Redo stack clears on new edits.
- **Rendering sync**: the editor view holds no text copy; it renders directly from `LineBuffer` line accessors, and `onDidChange` carries the dirty line range so the view re-renders only affected lines (supports the 16 ms target, *Req 13.1*).
- **Large files** (*Req 5.5*): `DocumentManager.open` stats the file first; > 10 MB sets `readonly: true` and the statusbar shows a read-only indicator.
- Encoding is UTF-8 only; EOL is detected on load (first occurrence wins, default `\n`) and preserved on save (*Req 5.1*).

### 7.2 DocumentManager

Owns the `Map<UriString, Document>`, exposes `tecode.workspace.openDocument/documents` and the open/close/save events, resolves language IDs via the language registry on open, and fires `onLanguage:*` activation events. Save writes atomically (write temp + rename) and clears `dirty`.

## 8. UI Shell

### 8.1 Component tree

```
<ThemeProvider>                         // theme tokens via React context → useTheme()
  <ContextFocusTracker>                 // maps OpenTUI focus → context keys
    <Shell>
      <ActivityBar/>                    // slot: activityBar.item
      <Sidebar/>                        // slot: sidebar.view (1:1 with activity item)
      <EditorArea>
        <TabBar/>                       // one editor group, N tabs (Req 6.5)
        <EditorView/>                   // custom component (decision #2)
      </EditorArea>
      <Panel/>                          // slot: panel.tab
      <StatusBar/>                      // slot: statusBar.item (side + priority)
    </Shell>
  </ContextFocusTracker>
</ThemeProvider>
```

### 8.2 Slot registry

`tecode.ui.registerView(slot, id, Component)` (*Req 6.3*) stores entries in a per-slot ordered map; shell regions subscribe and re-render on registration. `activityBar` registrations pair a bar icon with the sidebar view of the same id (*Req 6.2*); clicking (or `workbench.view.<id>` command) swaps the sidebar content, activating the owning extension lazily if needed. Status bar items carry `{ side: "left"|"right", priority: number }` and render sorted.

Layout state `{ sidebarVisible, sidebarWidth, panelVisible, panelHeight, activeView }` persists to `~/.config/tecode/state.json` on change (debounced) and on exit (*Req 6.4*).

**Initial editor focus** (*Req 6.7*): `EditorArea` gives its `EditorView`'s text plane keyboard focus the moment a document becomes the active tab — covering startup with a document already open, the first document opening on an empty workspace, and switching tabs — so typing works with no manual focus action. It skips this whenever the command palette, an input box, the find widget, or the explorer sidebar currently holds focus (read back through the shared context service, since none of those are `EditorArea`'s own descendants), so it never steals focus from something the user deliberately focused.

### 8.3 EditorView (custom component, decision #2)

Layers, back to front:

1. **Gutter** — line numbers (`editor.lineNumbers`), fixed width from `lineCount` digits.
2. **Text layer** — renders the visible line window (virtualized by scroll offset; only `viewportHeight` lines exist as OpenTUI nodes) with syntax-highlight spans from the highlight service.
3. **Selection layer** — background spans for each selection region.
4. **Cursor layer** — one block cursor per active cursor; primary cursor drives `revealLine` scrolling.

Editing state lives in an `EditorState` object per tab: `{ documentUri, selections: Selection[], scrollTop }`. Multiple selections/cursors are a first-class array (*Req 6.6, 11.1*); every editor-core command maps over `selections` and merges overlapping results. Key input that reaches the view (not consumed by keymap) becomes an insert `applyEdits` at all cursors.

Wide characters (CJK, emoji) are measured with OpenTUI's cell-width utilities so cursor columns map to terminal cells correctly.

## 9. Theming

`core/ui/theme.ts` (*Req 7*):

- `ThemeRegistry` collects `contributes.themes` entries (name → JSON path). Loading parses the JSON, fills missing UI keys from a built-in base palette (so partial themes degrade gracefully), and produces `ResolvedTheme { colors: Record<UiColorKey, RGB>, tokens: Record<CaptureName, Style> }`.
- The ~40 `UiColorKey`s are a union type in `api`, using VS Code names (*Req 7.2*). `tokenColors` keys are tree-sitter capture names (decision #3), including dotted refinements (`function.builtin` falls back to `function` by longest-prefix match).
- **Color depth** (*Req 7.4*): startup detects truecolor (`$COLORTERM`, terminfo); on 256-color terminals every resolved RGB is quantized once at theme build time (nearest xterm-256 cube/gray entry), so render paths never branch.
- `useTheme()` reads a React context; changing `workbench.colorTheme` (or previewing via `theme.select`, which calls a `previewTheme(name)`/`commitTheme()`/`revertTheme()` triple on the theme service) swaps the context value and re-renders the tree (*Req 7.3, 7.5*).

## 10. Syntax Highlighting

Pipeline (*Req 8*), in `core` with languages contributed by extensions:

1. `LanguageRegistry` maps file extensions → language declarations (*Req 8.2*); no match → `plaintext`, which bypasses the pipeline entirely (*Req 8.3*).
2. On first open of a language, the highlight service loads its tree-sitter WASM grammar via OpenTUI's web-tree-sitter integration and compiles its `highlights.scm` query. Grammars and queries for `languages-basic` are embedded assets (`bun build --compile` file embedding), resolved through an asset-URI indirection that works identically in dev and compiled mode (*Req 8.5*).
3. Per document, the service keeps a parse tree, applies incremental `tree.edit()` on each `DocumentChangeEvent`, re-parses (tree-sitter incremental parse is fast enough to run synchronously for the MVP; if profiling shows misses of the 16 ms budget on the 10k-line target, parsing moves behind a microtask with stale-token rendering), and serves per-line arrays of `{ startCol, endCol, capture }` spans to the EditorView, which resolves captures to styles through the active theme.

## 11. Configuration

`core/config/` (*Req 9*):

- **JSONC**: a small tolerant parser (strip comments + trailing commas, then `JSON.parse`) with error positions surfaced in the status bar; a broken file keeps the last good configuration.
- **Layering**: defaults (from `contributes.configuration` schemas and core defaults) ← user `settings.json` ← workspace `.tecode/settings.json`. `tecode.config.get(key)` reads the merged view; the schema registry supplies types/defaults and (later) validation.
- **Watch**: `fs.watch` on both settings files and `keybindings.json`; on change, re-parse, diff keys, fire `onDidChangeConfiguration({ affectsConfiguration })`, and notify dependent services (theme service on `workbench.colorTheme`, keymap service rebuilds its table) (*Req 9.4*).
- **`--config <dir>` override** (*Req 9.6*): the CLI's `--config <dir>` flag (`cli/argv.ts`'s `resolveConfigDirOverride`) redirects the USER layer only — `<dir>/settings.json` and `<dir>/keybindings.json` replace the home-directory defaults `ConfigServiceDeps.settingsPath`/`keybindingsPath` otherwise fall back to (`host/paths.ts`'s `getUserSettingsPath`/`getUserKeybindingsPath`); the workspace layer's own resolution is untouched. A directory argument still following `--config <dir>` opens as the workspace exactly as before this flag existed; `--config` with no directory argument at all opens no workspace, same as no arguments given.


## 12. Public API Assembly

`core/api/create.ts` builds the frozen `tecode` object per the namespace table in *Req 10.1*, delegating to the services above. Notes:

- `tecode.workspace.fs` wraps `node:fs/promises` + `fs.watch` behind the API so future virtual filesystems stay possible, but imposes no sandbox (*Req 10.2*).
- `tecode.window.showQuickPick/showInputBox` are implemented on the shell's modal layer (a centered overlay component owned by core, since the palette and pickers must exist before any extension UI).
- `tecode.editor` operates on the active `EditorState`; calls with no active editor no-op with a status-bar notice.
- The whole object is `Object.freeze`d shallowly per namespace to prevent accidental monkey-patching across extensions.

## 13. Built-in Extension Designs (key points)

- **editor-core** (*Req 11.1*): pure command handlers over `tecode.editor` + `document.transaction`. Find/replace state is per-editor, rendered as a `panel`-independent inline widget registered on an editor overlay slot; `ctrl+d` implements add-selection-to-next-find-match over the buffer with wraparound. Bracket auto-close consults the language declaration's `brackets`.
- **explorer** (*Req 11.2*): tree state from `tecode.workspace.fs.readdir` + `watch`; `.gitignore` handling — if `git` CLI exists (checked once with `Bun.spawn(["git","--version"])`), visibility uses `git check-ignore --stdin` batched per directory; otherwise a minimal `.gitignore` glob matcher handles the common patterns; `explorer.showHidden` bypasses both.
- **command-palette** (*Req 11.3*): `ctrl+shift+p` lists `commands.list()` filtered by `when`; `ctrl+p` walks the workspace (respecting explorer's ignore logic) into an in-memory file list with a subsequence-scoring fuzzy matcher (VS Code-like: consecutive-run and word-boundary bonuses). Both are thin wrappers over `showQuickPick`.
- **themes-default / languages-basic**: pure-contribution extensions (no `activate` logic beyond registration); their JSON/WASM/scm files are embedded assets.
- **statusbar** (*Req 11.6*): subscribes to active-editor selection changes, document events, and theme changes; registers left items (language, EOL, dirty) and right items (line/column, theme name) via `setStatusBarItem`.
- **keybindings-editor** (*Req 11.7*): `keybindings.open` opens the JSON file as a normal document (creating it with a commented template if absent); `keybindings.showResolved` renders the keymap service's resolved table in a quick pick.

## 14. Error Handling Strategy

| Failure | Behavior |
|---|---|
| Manifest invalid / API version mismatch | Skip extension, status-bar error, startup continues |
| `activate()` throws | Extension marked failed; its commands report failure when invoked |
| Unknown command ID | Status-bar error, no exception (*Req 3.4*) |
| Command handler throws | Caught, logged, status-bar error (*Req 3.5*) |
| Settings/keybindings JSONC parse error | Keep last good config, status-bar error with line/column |
| Theme JSON missing keys | Fall back to base palette per key |
| Grammar WASM fails to load | Language degrades to `plaintext`, one-time warning |
| Edit on readonly document | Status-bar notice, edit ignored |
| File save I/O error | Status-bar error, document stays dirty |

A core `HostLog` collects structured errors; a `developer.showLog` command dumps it into an untitled document for debugging.

## 15. Performance Design

- **Startup < 100 ms** (*Req 12.2*): nothing async before first paint except config file reads; theme resolution from embedded JSON; extension discovery deferred past the first frame.
- **Input < 16 ms at 10k lines** (*Req 13.1*): line-window virtualization (render cost ∝ viewport, not file); dirty-line-range change events; incremental tree-sitter edits; when-clause ASTs precompiled; keymap lookup is a hash-table hit.
- **Binary ≤ 120 MB** (*Req 13.2*): the dominant costs are the Bun runtime and 12 grammar WASMs (~10–15 MB total); no runtime schema/validation libraries; React is the only large JS dependency beyond OpenTUI. CI asserts binary size per target.

## 16. Testing Strategy

(*Req 13.4*)

- **Unit (`bun test`)**: `LineBuffer` edits/undo (property-based round-trip: apply edits then inverse edits restores the buffer), when-clause parser (table-driven), key normalization and chord state machine, JSONC parser, config layering, fuzzy matcher, `.gitignore` matcher, 256-color quantization.
- **Contract tests for the API**: a test harness activates a fixture extension against the real core and asserts every `tecode.*` namespace behaves per its documented contract (register/dispose symmetry, event firing order, freeze-ness). These tests are the compatibility gate for `API_VERSION` bumps.
- **UI snapshots**: OpenTUI's headless renderer renders the Shell and EditorView against fixture states (empty shell, file with selections/multi-cursor, 256-color theme) and snapshots the cell grid.
- **Integration**: startup-sequence test asserting contribution registration happens without extension code execution (spy on module loading), and an end-to-end "open file → type → undo → save" scenario on the headless renderer.
- **Performance checks in CI**: startup-to-first-frame timing and a scripted 10k-line typing benchmark with thresholds slightly above the targets to avoid flakiness.

## 17. Build and Distribution

- Dev: `bun run packages/cli/src/main.ts <path>`.
- Release: `bun build --compile` per target (darwin/linux/windows × x64/arm64) from `cli`, embedding built-in extension assets (theme JSON, grammar WASM, highlight queries, fallback keymap). A `scripts/release.ts` drives the 6-target matrix and size assertions.
- Windows note: config path resolution uses `%APPDATA%\tecode\` when `~/.config` is not conventional, exposed uniformly through a `paths` module so the rest of the code never branches on platform.

## 18. Deferred Design Concerns

Recorded so the MVP design does not paint them out:

- **Rope buffer**: `LineBuffer` is behind the `Document` API; swapping to a rope (or OpenTUI native buffer) touches only `core/buffer`.
- **LSP**: `offsetAt`/`positionAt` and LSP-shaped `TextEdit`/`Position` types are already in place.
- **Editor splitting**: `EditorArea` renders a single group but the tab model is per-group, so a group tree can wrap it later.
- **Sandboxing**: the API-injection design (extensions never import core) is the seam where a future process- or worker-isolated host would sit.
- **TextMate scope mapping**: a translation table from TextMate scopes to capture names can be added in the theme loader without changing themes already written for tecode.
