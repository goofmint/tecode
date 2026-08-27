# Implementation Plan — tecode (TUI Programming Editor, MVP)

Task breakdown derived from `requirements.md` (*Req N.M* references) and `design.md` (*§N* references). Tasks are ordered so each one builds on completed work, is verifiable by tests, and ends with something runnable. Top-level phases match the milestones in `requirements.md`.

Conventions for every task:
- Write `bun test` unit tests alongside the implementation (test file next to source).
- No task is done until `bun test` passes for the whole workspace and lint passes (including the `no-restricted-imports` layering rule once Task 1.2 lands).

---

## Phase 1 — Core skeleton (Milestone 1)

- [ ] **1.1 Scaffold the monorepo**
  - Initialize the Bun workspace with `packages/api`, `packages/core`, `packages/builtin`, `packages/cli`; shared `tsconfig` (strict), ESLint, `bun test` wiring; a `cli` entry that prints a version and exits.
  - _Req 1.2; Design §2_

- [ ] **1.2 Define the `@tecode/api` type surface**
  - Author all public types: `Manifest`, `ExtensionContext`, `Disposable`, `Uri`, `Position`/`Range`/`TextEdit`/`Selection`, `Document` interface, events, the namespace interfaces (`commands`, `workspace`, `window`, `editor`, `ui`, `config`, `context`, `languages`, `themes`), `UiColorKey` union, `CaptureName` union, and `API_VERSION`.
  - Add the ESLint `no-restricted-imports` rule forbidding `@tecode/core` outside `cli`.
  - _Req 1.3, 3.2, 3.3, 7.2, 10.1; Design §2, §12_

- [ ] **1.3 Implement the command registry**
  - `register`/`execute`/`list` with last-wins re-registration, never-throwing `execute` (unknown ID and handler exceptions surface as `HostError`s, routed to a status sink stub for now), and `Disposable` return.
  - Tests: unknown ID, throwing handler, dispose semantics, `list` metadata.
  - _Req 3.1–3.5; Design §5_

- [ ] **1.4 Implement the context service and when-clause evaluator**
  - Flat context map with `set`/`get` and change event; recursive-descent parser for the MVP grammar (`&&`, `||`, `!`, `==`, parentheses, bare keys) producing a cached AST; evaluation with unknown-keys-falsy.
  - Tests: table-driven parse/eval cases including precedence, `editorLangId == 'ts'`, malformed clauses.
  - _Req 4.5, 4.6; Design §6.4_

- [ ] **1.5 Implement key normalization and the binding table**
  - Canonical key-string normalization (modifier order, lowercase); layered table build (core defaults → fallback layer slot → extension → user) with `-command` removal records; lookup returning the winning binding after when-filtering.
  - Tests: precedence across layers, removal records, normalization equivalence.
  - _Req 4.1–4.3; Design §6.2_

- [ ] **1.6 Implement the chord state machine**
  - Two-stroke sequences on `@opentui/keymap`; pending state with timeout and Escape cancel; discard on no-match (VS Code behavior); pending indicator hook for the status bar.
  - Tests: chord completion, timeout, prefix-then-miss.
  - _Req 4.4; Design §6.3_

- [ ] **1.7 Implement LineBuffer and Document**
  - `LineBuffer` with `applyEdits` (validate, sort bottom-up, atomic apply), `offsetAt`/`positionAt`; `Document` with version, dirty, EOL detection, UTF-8, readonly flag; `onDidChange` carrying dirty line ranges and inverse edits.
  - Tests: property-based edit/inverse round-trips, multi-edit ordering, position↔offset mapping, EOL detection.
  - _Req 5.1–5.3; Design §7.1_

- [ ] **1.8 Implement undo/redo and transactions**
  - `UndoStack` with group IDs, `transaction(fn)` grouping, 750 ms typing coalescing, selection restore payloads, redo-clear on new edits.
  - Tests: grouping, coalescing boundaries, undo→redo→undo cycles.
  - _Req 5.4; Design §7.1_

- [ ] **1.9 Implement DocumentManager**
  - Open/close/save over `node:fs/promises` with atomic save (temp + rename), the 10 MB readonly threshold, language-ID resolution stub, `onDidOpen`/`onDidClose`/`onDidSave`.
  - Tests: large-file readonly, save clears dirty, event ordering.
  - _Req 5.5; Design §7.2_

- [ ] **1.10 Implement the config service**
  - Tolerant JSONC parser; defaults ← user ← workspace layering; schema registry fed by `contributes.configuration`; `fs.watch`-driven reload with `onDidChangeConfiguration` and keep-last-good on parse errors.
  - Tests: JSONC edge cases, layering, watch-triggered diff events, broken-file resilience.
  - _Req 9.1–9.4; Design §11_

- [ ] **1.11 Implement manifest validation and extension discovery**
  - Hand-rolled `Manifest` validator with precise error messages; three-location discovery in order; duplicate-ID shadowing (later wins, warning); contribution registration into all registries **without importing `index.ts`**; API-version compatibility check.
  - Tests: invalid manifests skipped without aborting, shadowing order, spy asserting no extension code execution at registration.
  - _Req 2.1–2.4, 2.7; Design §4.1, §4.3_

- [ ] **1.12 Implement activation and the extension context**
  - `onStartup` / `onCommand:*` / `onLanguage:*` triggers; lazy commands re-dispatch after activation; `ExtensionContext` with `subscriptions` disposal in reverse order and `deactivate()` on shutdown; failed-activation quarantine.
  - Tests: fixture extensions for each activation event, dispose order, throwing `activate`.
  - _Req 2.5, 2.6; Design §4.2_

- [ ] **1.13 Assemble the `tecode` API object**
  - `create.ts` wiring every namespace to the services; shallow freeze per namespace; Bun module alias registration so `import ... from "tecode"` resolves; no-active-editor no-ops for `tecode.editor`.
  - Contract tests: fixture extension exercising every namespace (register/dispose symmetry, event order, frozenness) — this suite becomes the `API_VERSION` gate.
  - _Req 10.1, 10.2; Design §12, §16_

- [ ] **1.14 Build the UI shell with empty slots**
  - `ThemeProvider` (hardcoded base palette for now), `Shell` layout (activity bar, sidebar, editor area with tab bar, panel, status bar), slot registry with `registerView`, status-bar item sides/priorities, focus tracking → context keys, layout-state persistence to `state.json`.
  - Snapshot tests on OpenTUI's headless renderer: empty shell, slot registration re-render.
  - _Req 6.1–6.4; Design §8.1, §8.2_

- [ ] **1.15 Wire the startup sequence in `cli`**
  - Argv parsing (file/directory), the sync-before-first-frame phase (config, terminal capability detection stub, shell render), deferred discovery/activation, initial open; startup-to-first-frame timing instrumentation.
  - Integration test: startup renders before any extension activates; timing check with headroom over 100 ms.
  - _Req 12.1, 12.2; Design §3, §15_

**Phase 1 exit:** `bun run cli` opens the empty shell with working command registry, keymap, documents (headless), and config — no visible editing yet.

---

## Phase 2 — Single-file editing (Milestone 2)

- [ ] **2.1 Implement the EditorView component**
  - Four layers (gutter, virtualized text window, selection spans, block cursors); `EditorState` per tab (`selections[]`, `scrollTop`); dirty-line-range re-render from `onDidChange`; wide-character cell-width handling; scroll/reveal logic.
  - Snapshot tests: file with selections, multi-cursor render, CJK lines; unit tests for the viewport window math.
  - _Req 6.5, 6.6; Design §8.3_

- [ ] **2.2 Route key input into editing**
  - Keymap fall-through to the focused editor becomes insert/delete `applyEdits` at all cursors; `editorFocus`/`editorTextFocus`/`editorLangId` context maintenance.
  - Integration test: type → buffer content and cursor positions correct with two cursors.
  - _Req 4.6, 6.6; Design §6.1, §8.3_

- [ ] **2.3 Build editor-core: movement, selection, editing commands**
  - Cursor movement (char/word/line/document, with selection variants), insert/delete/newline with auto-indent, tab/shift-tab indentation honoring `editor.tabSize`/`insertSpaces`, save command; all handlers map over `selections` and merge overlaps.
  - _Req 11.1; Design §13_

- [ ] **2.4 Build editor-core: line operations, undo/redo, brackets, multi-cursor**
  - Duplicate/move/delete line, toggle comment (from language `comments` declaration), undo/redo commands over the core stack, bracket auto-close from language `brackets`, `ctrl+d` add-selection-to-next-find-match with wraparound.
  - _Req 11.1; Design §13_

- [ ] **2.5 Build editor-core: in-buffer find/replace**
  - Per-editor find state, inline widget on the editor overlay, find next/prev, replace one/all (single undo group), match highlighting layer.
  - _Req 11.1; Design §13_

- [ ] **2.6 Implement the theme service**
  - `ThemeRegistry` from `contributes.themes`; JSON loading with base-palette fill; truecolor/256 detection and build-time quantization; `useTheme()` context swap; `theme.select` command with preview/commit/revert; `workbench.colorTheme` binding.
  - Tests: quantization mapping, partial-theme fallback, preview/revert; snapshot in 256-color mode.
  - _Req 7.1–7.5; Design §9_

- [ ] **2.7 Build themes-default**
  - Dark Modern and Light Modern equivalents covering all ~40 UI keys and all capture names; pure-contribution manifest; embedded-asset wiring for the pre-first-frame theme load.
  - _Req 11.4; Design §3, §13_

- [ ] **2.8 Implement the language registry and highlight service**
  - Extension→language mapping with `plaintext` fallback; grammar WASM + `highlights.scm` loading through the asset-URI indirection; per-document incremental parse on change; per-line capture spans consumed by EditorView; capture→style resolution with longest-prefix fallback; grammar-load failure degrades to plaintext with one warning.
  - Tests: extension mapping, incremental edit reparse correctness, prefix fallback.
  - _Req 8.1–8.3; Design §10_

- [ ] **2.9 Build languages-basic**
  - Declarations, grammars, and highlight queries for TypeScript/JavaScript, JSON, Markdown, Python, Rust, Go, HTML, CSS, YAML, TOML, Bash; comments/brackets metadata for each; `onLanguage` activation checks.
  - _Req 8.4; Design §13_

- [ ] **2.10 End-to-end editing scenario test**
  - Headless: open a TS file → highlighted render → type at two cursors → undo → redo → save → dirty flag lifecycle. Add the scripted 10k-line typing benchmark with a threshold above the 16 ms target.
  - _Req 13.1; Design §15, §16_

**Phase 2 exit:** editing a single file with highlighting, themes, undo, find/replace, and multi-cursor works end to end.

---

## Phase 3 — Directory workflow (Milestone 3)

- [ ] **3.1 Implement quick pick and input box**
  - Core modal overlay layer; `showQuickPick` (list, filter-as-you-type, keyboard navigation) and `showInputBox`; `showMessage` routed to the status bar.
  - Snapshot + interaction tests.
  - _Req 10.1 (`tecode.window`); Design §12_

- [ ] **3.2 Build command-palette**
  - `ctrl+shift+p` over `commands.list()` with when-filtering and category prefixes; subsequence fuzzy matcher with consecutive-run and word-boundary bonuses (shared utility); `ctrl+p` file quick-open over an ignore-aware workspace file walk.
  - Tests: matcher scoring table, when-filtered listing.
  - _Req 11.3; Design §13_

- [ ] **3.3 Build explorer**
  - Tree view on `tecode.ui` Tree component over `workspace.fs.readdir` + `watch`; open on enter; create/rename/delete with input-box prompts and error surfacing; `.gitignore` visibility via batched `git check-ignore` when `git` exists, minimal glob matcher otherwise; `explorer.showHidden` setting; `explorerFocus` context key and `ctrl+shift+e` focus binding.
  - Tests: glob matcher cases, git/no-git switch, tree ops against a temp dir.
  - _Req 11.2; Design §13_

- [ ] **3.4 Build statusbar**
  - Left: language ID, EOL, dirty indicator; right: line/column, theme name; subscriptions to selection/document/theme changes; also renders host errors and the chord-pending indicator from Phase 1 sinks.
  - _Req 11.6; Design §13_

- [ ] **3.5 Multi-tab management**
  - Tab open/switch/close commands with dirty-close confirmation prompt, tab bar interaction, per-tab `EditorState` retention, `onLanguage` firing per newly opened document.
  - _Req 6.5; Design §8_

**Phase 3 exit:** open a directory, navigate/manage files in the explorer, jump via `ctrl+p`, run anything via the palette, with live status.

---

## Phase 4 — Distribution & external extensions (Milestone 4)

- [ ] **4.1 External extension loading**
  - User (`~/.config/tecode/extensions/`) and workspace (`.tecode/extensions/`) loading with runtime TS/TSX import; `index.js`-over-`index.ts` preference for bundled extensions; `extensions.reload` via re-exec after state persistence; failure isolation verified with a deliberately broken fixture.
  - _Req 2.1, 2.8, 10.3, 10.4; Design §4.4_

- [ ] **4.2 Terminal capability detection and fallback keymap**
  - Kitty Keyboard Protocol detection (query + `$TERM`/tmux heuristics); `keybindings.fallback.json` shipped and overlaid in its dedicated layer; verify precedence (user bindings still win); manual test checklist for Ghostty, Kitty, WezTerm, iTerm2, Windows Terminal, tmux.
  - _Req 4.7, 13.3; Design §6.5_

- [ ] **4.3 Build keybindings-editor**
  - `keybindings.open` (create-with-template when absent, open as document) and `keybindings.showResolved` quick pick over the resolved binding table including source layer per binding.
  - _Req 11.7; Design §13_

- [ ] **4.4 Compiled binary builds**
  - `bun build --compile` from `cli` with embedded assets (theme JSON, grammar WASMs, `.scm` queries, fallback keymap); asset-URI indirection verified in compiled mode; `scripts/release.ts` for the published 4-target matrix (`bun-darwin-arm64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64` — `bun-darwin-x64`/`bun-windows-arm64` dropped for lack of a CI runner of either architecture); Windows `%APPDATA%\tecode\` path handling behind the `paths` module.
  - _Req 8.5, 13.2; Design §17_

- [ ] **4.5 CI pipeline**
  - Lint (incl. layering rule), full `bun test`, contract suite, snapshot suite, startup-time and typing-latency checks, binary-size assertion (≤ 120 MB per target) on the release matrix.
  - _Req 13.1, 13.2, 13.4; Design §15, §16_

**Phase 4 exit:** a downloaded single binary runs on a clean machine, loads a third-party extension from `~/.config/tecode/extensions/`, and passes the fallback keymap check in tmux.

---

## Phase 5 — Documentation & release (Milestone 5)

- [ ] **5.1 Extension authoring guide**
  - Walkthrough building a real extension (manifest, activation, commands, a sidebar view, configuration, a keybinding), the `tecode.*` API reference generated or written from `@tecode/api`, bundling instructions for npm-dependent extensions, and API-version policy.
  - _Req 2.3, 2.7, 10; Design §4, §12_

- [ ] **5.2 User documentation and release**
  - README (install, keybindings table, settings reference, terminal support matrix, fallback-keymap notes), sample `settings.json`/`keybindings.json`, versioned release publishing of the 4 binaries: `bun-darwin-arm64` built locally by `bun run tag <version>` (`scripts/tagRelease.ts`, run on the project owner's own Apple Silicon Mac), the other three via the tag-triggered CircleCI pipeline (`.circleci/config.yml`), which `publish`es by finding the draft release `bun run tag` already created rather than creating one itself. Pushing a `v*` tag by hand instead of running `bun run tag` produces a stuck pipeline, not a release.
  - _Req 9.5, 13.2, 13.3_

---

## Dependency notes

- 1.3–1.10 are parallelizable after 1.2; 1.11–1.13 need 1.3/1.4/1.10; 1.14 needs 1.13; 1.15 closes the phase.
- 2.6/2.7 (themes) and 2.8/2.9 (languages) can proceed in parallel with 2.3–2.5 (editor-core) once 2.1/2.2 land.
- 3.1 blocks 3.2 and parts of 3.3; 3.4/3.5 are independent of each other.
- 4.2 and 4.3 are independent; 4.4 blocks 4.5's matrix jobs.
