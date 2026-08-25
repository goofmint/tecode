# Requirements Document — tecode (TUI Programming Editor, MVP)

## Introduction

tecode is a terminal (TUI) programming editor inspired by the look and feel of VS Code. The core is kept deliberately thin — it loads extensions and provides UI slots, text buffers, and a command bus — and nearly all functionality, including bundled features such as the file explorer, is implemented as extensions using the same public API. tecode is built on Bun / TypeScript / OpenTUI (`@opentui/core`, `@opentui/react`, `@opentui/keymap`), is distributed as a single self-contained binary via `bun build --compile`, and is extended with TypeScript extensions loaded via dynamic import.

This document defines the requirements for the MVP in EARS (Easy Approach to Requirements Syntax) form. Design decisions about *how* these requirements are implemented belong to the subsequent design document.

### Naming

The product, CLI command, and repository are all named `tecode`. User-level configuration lives in `~/.config/tecode/`, workspace-level configuration in `.tecode/`, and the extension API is exposed under the `tecode` namespace (imported by extensions as their sole dependency).

### Decisions carried into this document

The following points were open in the draft specification and are resolved here as MVP decisions:

1. **Buffer implementation** — The core SHALL own the document model as a TypeScript-side line-based text buffer, synchronized to the OpenTUI renderer. This keeps undo/redo, change events, and future LSP position mapping under core control and keeps the `api` layer independent of OpenTUI internals. Revisiting a native rope-based buffer is deferred to a later phase if profiling shows the line buffer cannot meet the latency targets.
2. **Editor component** — The editor view SHALL be a custom component (text renderer plus an editor-owned cursor/selection overlay) rather than a wrapped `<textarea>`, because multi-cursor editing and a line-number gutter are MVP requirements that a plain textarea cannot provide.
3. **Token color naming** — Theme `tokenColors` SHALL use tree-sitter capture names (`keyword`, `string`, `comment`, `function`, `type`, `variable`, `number`, `operator`, `punctuation`). A compatibility mapping from VS Code TextMate scopes is out of scope for the MVP.

### Glossary

- **Core**: The minimal runtime — extension host, command registry, keymap resolution, document/buffer management, UI shell, configuration.
- **Extension**: A directory containing `manifest.ts` (declarations) and `index.ts` (activation code) that contributes commands, keybindings, views, languages, themes, or configuration.
- **Built-in extension**: An extension bundled with tecode under `builtin/`, implemented against the same public API as third-party extensions.
- **Command**: A named operation identified by a string ID in `namespace.verb` form, executed through the command registry.
- **Contribution**: A declarative entry in an extension manifest (commands, keybindings, views, configuration, languages, themes).
- **Slot**: A named region of the UI shell that extensions can fill with a React component.
- **When clause**: A boolean context expression that gates keybindings and command visibility.

---

## Requirements

### Requirement 1: Core Architecture and Layering

**User Story:** As a maintainer, I want the core kept minimal with strict layer boundaries, so that all features can evolve as extensions without entangling the core.

#### Acceptance Criteria

1. THE core SHALL provide only: the extension host, the command registry, keymap resolution, document/buffer management, the UI shell with slots, and configuration loading. Features such as the file tree, search, Git integration, and LSP SHALL NOT be part of the core.
2. THE codebase SHALL be organized as `packages/core` (implementation), `packages/builtin` (bundled extensions), `packages/cli` (entry point and bundling), and an `api` package containing only type definitions.
3. THE `api` package SHALL have no dependencies; `core` SHALL depend only on `api`; `builtin` extensions SHALL import only from `api` and SHALL NOT import `core` directly; `cli` SHALL contain wiring only.
4. WHEN a built-in extension needs a capability, it SHALL use the same public extension API available to third-party extensions, with no privileged core access. (The core-reserved-command-ID registration path introduced by Requirement 3.6 is not an exception: it is called only from core's own UI modules, never from `packages/builtin`, which registers commands through the same `tecode.commands.register` third-party extensions use and is rejected under Requirement 3.6 exactly the same way on a reserved ID.)
5. WHEN one component needs to invoke behavior in another (UI, keybindings, palette, extension-to-extension), it SHALL do so by executing a command through the command registry, not by direct function call across module boundaries.

### Requirement 2: Extension Host and Lifecycle

**User Story:** As an extension author, I want tecode to discover, validate, and lazily activate my extension from a declarative manifest, so that my extension integrates predictably without slowing startup.

#### Acceptance Criteria

1. WHEN tecode starts, THE system SHALL discover extensions in this order: `builtin/`, then `~/.config/tecode/extensions/*/`, then the workspace's `.tecode/extensions/*/`.
2. WHEN an extension is discovered, THE system SHALL read its `manifest.ts` and register its declared contributions (commands, keybindings, views, configuration, languages, themes) without executing the extension's implementation code.
3. THE manifest SHALL declare at minimum: `id`, `version`, `activationEvents`, and `contributes`, and SHALL conform to the published `Manifest` type.
4. WHEN a manifest fails validation, THE system SHALL skip that extension, report the error in the UI (status bar or notification), and SHALL continue starting up.
5. THE system SHALL activate an extension only when one of its `activationEvents` fires; the MVP SHALL support `onStartup`, `onCommand:<id>`, and `onLanguage:<id>`.
6. WHEN an extension is activated, THE system SHALL call its exported `activate(ctx)` with an extension context providing a `subscriptions` disposable collection, and SHALL call `deactivate()` (if exported) on shutdown.
7. THE manifest SHALL declare the API version it targets, and THE system SHALL refuse to activate an extension whose required API version is incompatible, reporting the mismatch without crashing.
8. WHEN the `extensions.reload` command is executed, THE system SHALL reload extensions; in the MVP a full application restart is an acceptable implementation.

### Requirement 3: Command Registry

**User Story:** As an extension author, I want to register and execute named commands, so that all behavior is addressable by string ID from keybindings, the palette, and other extensions.

#### Acceptance Criteria

1. THE system SHALL provide `tecode.commands.register(id, handler, meta?)`, `tecode.commands.execute(id, ...args)`, and `tecode.commands.list()`.
2. Command IDs SHALL follow the `namespace.verb` convention (e.g. `editor.action.deleteLine`, `explorer.reveal`).
3. Command metadata SHALL support `title` (palette display name), `category`, and `when` (visibility condition).
4. WHEN `execute` is called with an unknown command ID, THE system SHALL display an error in the status bar and SHALL NOT throw an exception to the caller.
5. WHEN a registered command's handler throws, THE system SHALL catch the error, surface it in the UI, and keep the editor responsive.
6. WHEN an extension attempts to register a command ID that core has already reserved, THE system SHALL reject the registration — keeping the core handler in place — and SHALL report the rejection through the host log and status bar rather than throwing (built-in extensions are rejected the same way as third-party ones; see Requirement 1.4).

### Requirement 4: Keybindings

**User Story:** As a user, I want VS Code-compatible, user-overridable keybindings including two-stroke chords, so that my muscle memory and customizations carry over to the terminal.

#### Acceptance Criteria

1. THE system SHALL resolve keybindings with this precedence: user `keybindings.json` first, then extension manifest keybindings, then core defaults.
2. THE `keybindings.json` format SHALL be VS Code-compatible: an array of `{ "key", "command", "when"? }` entries.
3. WHEN an entry's command is prefixed with `-` (e.g. `"-editor.action.foo"`), THE system SHALL remove the matching default binding.
4. THE system SHALL support two-stroke chord sequences (e.g. `ctrl+k ctrl+s`) using the `@opentui/keymap` sequence engine.
5. THE system SHALL evaluate `when` clauses supporting: the context keys `editorFocus`, `editorTextFocus`, `terminalFocus`, `explorerFocus`; equality tests such as `editorLangId == 'ts'`; and the operators `&&`, `||`, `!`. No other expression syntax is required in the MVP.
6. THE system SHALL provide `tecode.context.set(key, value)` and `tecode.context.get(key)` so extensions can define context keys used in `when` clauses.
7. WHEN tecode starts on a terminal that does not support the Kitty Keyboard Protocol, THE system SHALL detect this and overlay the fallback keymap from `keybindings.fallback.json` so that otherwise-indistinguishable combinations (e.g. `ctrl+shift+*`) remain usable.

### Requirement 5: Documents and Text Buffer

**User Story:** As a user and as an extension author, I want a single consistent document model with unified editing, undo/redo, and change events, so that every edit path behaves identically.

#### Acceptance Criteria

1. THE system SHALL represent each open file as a `Document` with: URI, language ID, text content held in a TypeScript-side line-based buffer, dirty flag, EOL style, and encoding (fixed to UTF-8 in the MVP).
2. ALL document modifications SHALL go through `applyEdits(edits: TextEdit[])`; no other mutation API SHALL exist, so that undo/redo and change notification are centralized.
3. THE system SHALL emit `onDidChange`, `onDidSave`, `onDidOpen`, and `onDidClose` events for documents.
4. THE core SHALL implement undo/redo, and SHALL provide `document.transaction(fn)` so extensions can group multiple edits into a single undo step.
5. WHEN a file larger than 10 MB is opened, THE system SHALL open it read-only.

### Requirement 6: UI Shell and Slots

**User Story:** As a user, I want a familiar VS Code-style layout whose regions are populated by extensions, so that the interface is predictable and extensible.

#### Acceptance Criteria

1. THE UI shell SHALL provide the VS Code arrangement: activity bar, sidebar, editor group with tabs, bottom panel, and status bar.
2. THE system SHALL expose these extension-fillable slots: `activityBar.item` paired 1:1 with a `sidebar.view`; `panel.tab`; `statusBar.item` with side (left/right) and priority; and `editor.viewType` (reserved; unused in the MVP).
3. Extensions SHALL register slot content as React components via `tecode.ui.registerView(slot, id, Component)`.
4. THE core SHALL persist layout state (sidebar width, visibility) across sessions.
5. THE MVP SHALL support exactly one editor group (no split editing) with multiple tabs.
6. THE editor view SHALL be a custom component with an editor-owned cursor/selection overlay supporting multiple cursors and a line-number gutter.

### Requirement 7: Theming

**User Story:** As a user, I want switchable color themes contributed by extensions, so that the editor looks right in my terminal.

#### Acceptance Criteria

1. Themes SHALL be contributed via `contributes.themes` as JSON files using a subset of the VS Code color theme format.
2. THE theme format SHALL support UI color keys reusing VS Code names (approximately 40 keys in the MVP, including `editor.background`, `editor.foreground`, `sideBar.background`, `statusBar.background`, `tab.activeBackground`, `list.activeSelectionBackground`), and `tokenColors` keyed by tree-sitter capture names (`keyword`, `string`, `comment`, `function`, `type`, `variable`, `number`, `operator`, `punctuation`).
3. THE core SHALL provide a `useTheme()` hook, and UI components SHALL obtain all colors from it; no component SHALL hard-code color literals.
4. WHEN running on a terminal, THE system SHALL detect the color depth (truecolor vs 256 colors) and SHALL automatically quantize theme colors on 256-color terminals.
5. THE active theme SHALL be selected by the `workbench.colorTheme` setting, and the `theme.select` command SHALL offer theme switching with live preview from the command palette.

### Requirement 8: Syntax Highlighting and Languages

**User Story:** As a user, I want syntax highlighting for common languages out of the box, and as an extension author I want to add languages declaratively.

#### Acceptance Criteria

1. THE system SHALL use OpenTUI's web-tree-sitter integration; the core's responsibility SHALL be limited to loading grammars and applying `tokenColors` to captures.
2. Languages SHALL be declared via `contributes.languages` with: `id`, `extensions`, `grammar` (path to a tree-sitter WASM grammar), `highlights` (query file), `comments` (line/block markers), and `brackets` pairs.
3. WHEN a file's extension matches no declared language, THE system SHALL treat the file as `plaintext` (no highlighting).
4. THE MVP SHALL bundle language support for: TypeScript/JavaScript, JSON, Markdown, Python, Rust, Go, HTML, CSS, YAML, TOML, and Bash, via the `languages-basic` built-in extension.
5. WHEN building the distributable binary, THE build SHALL embed the WASM grammars so highlighting works without external files.

### Requirement 9: Configuration

**User Story:** As a user, I want human-editable JSON settings with workspace overrides and live reload, so that configuring tecode feels like configuring VS Code.

#### Acceptance Criteria

1. THE system SHALL read `~/.config/tecode/settings.json` and `~/.config/tecode/keybindings.json`, accepting JSONC (comments and trailing commas).
2. WHEN a workspace contains `.tecode/settings.json`, THE system SHALL overlay it over user settings for that workspace.
3. Extensions SHALL declare their settings schema via `contributes.configuration`, and SHALL read values via `tecode.config.get(key)`.
4. WHEN a settings file is saved, THE system SHALL apply the changes immediately and fire `onDidChangeConfiguration`.
5. THE MVP settings SHALL include at least: `workbench.colorTheme`, `editor.tabSize`, `editor.insertSpaces`, `editor.wordWrap`, `editor.lineNumbers`, `explorer.showHidden`, and `files.autoSave`.

### Requirement 10: Public Extension API

**User Story:** As an extension author, I want a typed, versioned `tecode.*` API with full Bun runtime access, so that I can build real features with only the public API.

#### Acceptance Criteria

1. THE system SHALL expose these namespaces to extensions:
   - `tecode.commands`: `register`, `execute`, `list`
   - `tecode.workspace`: `rootUri`, `openDocument`, `documents`, `fs` (`read`/`write`/`stat`/`readdir`/`watch`), `onDidOpen`/`onDidClose`/`onDidSave`
   - `tecode.window`: `activeEditor`, `showMessage`, `showQuickPick`, `showInputBox`, `setStatusBarItem`
   - `tecode.editor`: `selection(s)`, `cursor`, `revealLine`, `insertSnippet`, `applyEdits`
   - `tecode.ui`: `registerView`, `useTheme`, and common components (`List`, `Tree`, `Input`, `Tabs`)
   - `tecode.config`: `get`, `onDidChange`
   - `tecode.context`: `set`, `get`
   - `tecode.languages`: `register`, `getLanguageId`
   - `tecode.themes`: `register`, `current`
2. Extensions SHALL run in the Bun runtime with unrestricted access to `node:*` modules, `Bun` APIs, and npm packages; sandboxing is explicitly out of scope for the MVP.
3. An extension SHALL consist of a directory with `manifest.ts` and `index.ts` (optionally `package.json` and `node_modules`).
4. WHEN running from the compiled binary, THE system SHALL load extension TypeScript/TSX source via OpenTUI's runtime loading; extensions with external npm dependencies SHALL be supported by placing a single-file `index.js` bundled with `bun build`.

### Requirement 11: Built-in Extensions

**User Story:** As a user, I want a working editor out of the box — editing, file navigation, palette, themes, and status — all shipped as built-in extensions.

#### Acceptance Criteria

1. **editor-core** SHALL provide: cursor movement, selection, insert/delete, line operations (duplicate, move, delete, toggle comment), undo/redo, in-buffer find/replace, indentation, bracket auto-closing, multi-cursor via `ctrl+d` (add selection to next find match), and save.
2. **explorer** SHALL provide: a directory tree, opening files, create/rename/delete, and `.gitignore`-aware visibility that degrades gracefully depending on whether the `git` CLI is available.
3. **command-palette** SHALL provide: command search on `ctrl+shift+p` and fuzzy file quick-open on `ctrl+p`.
4. **themes-default** SHALL provide two themes equivalent to VS Code's Dark Modern and Light Modern.
5. **languages-basic** SHALL provide the language set of Requirement 8.
6. **statusbar** SHALL display: cursor line/column, language ID, EOL style, dirty state, and the active theme name.
7. **keybindings-editor** SHALL provide commands to open `keybindings.json` and to show the currently resolved bindings in a quick pick.
8. The following SHALL be explicitly out of scope for the MVP: LSP, integrated terminal (PTY), Git integration, workspace-wide search, editor splitting, an extension marketplace, and extension sandboxing.

### Requirement 12: Startup Sequence

**User Story:** As a user, I want tecode to start fast and predictably, so that opening a file feels instant.

#### Acceptance Criteria

1. WHEN tecode is launched, THE system SHALL proceed in this order: load configuration; discover extensions; register manifest declarations without executing extension code; activate extensions lazily per their activation events; render the UI shell; then open the initial file or directory given on the command line.
2. THE UI shell SHALL render within 100 ms of launch, with extension loading deferred so it does not block first paint.

### Requirement 13: Non-Functional Requirements

**User Story:** As a user, I want tecode to be fast, portable, and well-tested, so that it is dependable as a daily editor.

#### Acceptance Criteria

1. WHILE editing a 10,000-line file, THE system SHALL keep key-input-to-render latency within 16 ms.
2. THE distributable SHALL be a single self-contained binary produced by `bun build --compile` for darwin/linux/windows × x64/arm64, and each binary SHALL be no larger than 120 MB.
3. THE system SHALL support these terminals: Ghostty, Kitty, WezTerm, iTerm2, Windows Terminal, and running inside tmux, using the fallback keymap where the Kitty Keyboard Protocol is unavailable (per Requirement 4.7).
4. Each core module SHALL have `bun test` unit tests; the extension API SHALL be covered by contract tests; UI components SHALL be covered by snapshot tests using OpenTUI's headless renderer.

---

## Milestones (traceability)

1. **Core skeleton** — Requirements 1, 2, 3, 4, 5, 9, and the empty-slot UI shell of Requirement 6.
2. **Single-file editing** — Requirements 7, 8, and 11.1/11.4/11.5.
3. **Directory workflow** — Requirements 11.2, 11.3, 11.6.
4. **Distribution & external extensions** — Requirements 10.3/10.4, 11.7, 13.2.
5. **Documentation & release** — extension authoring guide and publication (out of scope of this requirements document's acceptance criteria).
