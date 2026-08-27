# tecode

## CI

Issue #36 "4.5 CI pipeline" (Req 13.1, 13.2, 13.4; design.md §15, §16).
`.github/workflows/ci.yml` runs five independent jobs on every push to
`main` and every pull request; a separate, tag-triggered CircleCI pipeline
(`.circleci/config.yml`) handles releases (see the "Release" section
below). Each CI job is reproducible locally with one `bun run` script:

| CI job        | Local command         | What it checks |
|---------------|------------------------|-----------------|
| `lint`        | `bun run lint`         | ESLint, including the `no-restricted-imports`/`no-restricted-syntax` layering rule (`eslint.config.mjs`) that keeps `@tecode/core` importable only from `packages/cli`. |
| `test`        | `bun test`              | The full workspace `bun test` suite. |
| `contract`    | `bun run test:contract` | The `API_VERSION` gate — the extension-API contract suite (`packages/core/src/api/create.contract.test.ts`) plus the constant's own assertions (`packages/api/src/index.test.ts`). |
| `snapshot`    | `bun run test:snapshot` | The headless-renderer cell-grid suite: every `*.snapshot.test.tsx` file, rendered via `@opentui/react/test-utils`'s `testRender` (design.md §16, "snapshots the cell grid" — no `toMatchSnapshot`, every assertion reads real rendered output). |
| `performance` | `bun run test:perf`     | Startup-to-first-frame timing (`packages/cli/src/main.integration.test.ts`) and the scripted 10,000-line typing benchmark (`packages/cli/src/typingBenchmark.test.ts`) — thresholds live as named constants in each test file, not in the workflow. |

`bunx tsc --noEmit` is also worth running locally before pushing (not its
own CI job — `bun test`'s own module resolution already fails loudly on a
real type error in a file any test imports, and `lint`'s
`typescript-eslint` rules catch most of the rest — but a standalone
typecheck is the fastest way to confirm a change is clean before opening
a PR).

**Branch protection** (repo configuration, not something a commit can set):
for pull requests to actually be blocked on `lint`/`test`/`contract`/
`snapshot` failures per this issue's completion requirements, a repo admin
must add each job as a required status check under Settings → Branches →
branch protection rule for `main` ("Require status checks to pass before
merging", then select `Lint (ESLint incl. layering rule)`,
`Test (full bun test suite)`, `Contract suite (API_VERSION gate)`, and
`Snapshot (headless-renderer cell-grid suite)` by name — they only appear
in that picker after each has run at least once on a branch or PR). `performance` is
deliberately left out of that required list: Req 13.1's thresholds already
carry generous headroom specifically to avoid CI flakiness, but a shared
runner's noise floor is still less predictable run-to-run than the other
four gates, so it is left informational (visible on every PR, blocking
`main`'s own push trigger, but not a hard merge gate) rather than risking
blocking merges on infrastructure noise rather than a real regression.

## Release

`bun run release [target ...]` builds the compiled-binary release matrix
(see `scripts/release.ts`'s TSDoc for the full embedding story and why
cross-compilation is not possible from a single machine). Three of the
completion requirements from Issue #35 need a platform or a real terminal
this repo's own CI/dev environment doesn't have — see
[`docs/manual-release-verification.md`](docs/manual-release-verification.md)
for the exact procedure.

Pushing a `v*` tag runs the CircleCI pipeline in `.circleci/config.yml`,
which builds all four `RELEASE_TARGETS` in parallel — one runner per
target, two of them CircleCI-hosted and two self-hosted on the project
owner's own machines (see that config's own top-of-file comment for the
full explanation and the exact target→runner table), each invoking
`bun run release <its-own-target>` so it only ever builds the one target
its own `@opentui/core` native optional dependency can actually link for.
Every target persists its binary and checksum to a shared workspace for
the `publish` job.

Only four of the six theoretically possible `darwin`/`linux`/`windows` ×
`x64`/`arm64` combinations are published: `bun-darwin-x64` (Intel macOS)
and `bun-windows-arm64` (Windows on Arm) are dropped, not deferred — no CI
runner of either architecture exists (the release provider removed its
Intel-macOS resource class in June 2024 and offers no Windows-arm64 one at
all), and the project owner has neither an Intel Mac nor a Windows-on-Arm
machine to self-host either on. Cross-compiling either from another
platform is impossible for the same `@opentui/core` reason no target can
be cross-compiled at all (`scripts/release.ts`'s TSDoc, "Why this machine
cannot produce even the four remaining binaries"). If you're on one of
the two dropped platforms, see "From source" below — running from source
works today, no release required.

Issue #38 "5.2 User documentation and release" adds a SHA-256 checksum
next to every binary (`scripts/release.ts`'s `writeChecksumFile`, run as
part of the same `bun run release <target>` invocation — see that
script's TSDoc) and a `publish` job that runs only once all four build
jobs succeed: it refuses to proceed unless exactly four binaries and four
checksums are present (`PUBLISH_EXPECTED_BINARIES`, kept equal to
`RELEASE_TARGETS.length` by `scripts/release.test.ts`), then creates the
GitHub Release directly against the GitHub API using a `GITHUB_TOKEN`
configured in CircleCI project settings (CircleCI has no ambient
equivalent of GitHub Actions' `github.token`).

## Install

tecode ships as four self-contained, single-file compiled binaries — one
per published target in `scripts/release.ts`'s `RELEASE_TARGETS` (Req
13.2) — built and published as GitHub Release assets by the CircleCI
pipeline's tag-triggered `publish` job (see "Release" above). No separate
runtime install is required to RUN a downloaded binary; all packages in
this monorepo are `"private": true`, so there is no `npm install -g
tecode` — a compiled binary or a source checkout are the only two ways to
run it.

### From a published release (once one exists)

1. Download the binary matching your platform from the release's assets:

   | Platform | Architecture | Asset |
   |---|---|---|
   | macOS | Apple Silicon | `tecode-darwin-arm64` |
   | Linux | x64 | `tecode-linux-x64` |
   | Linux | arm64 | `tecode-linux-arm64` |
   | Windows | x64 | `tecode-windows-x64.exe` |

   **No binary is published for Intel macOS or Windows on Arm** — see
   "Release" above for why. If you're on either platform, use "From
   source" below (`bun packages/cli/src/main.ts`): it works on any
   platform Bun itself supports, release or no release.

2. Verify the checksum (each binary ships with a `<binary>.sha256`
   sibling asset — `scripts/release.ts`'s `writeChecksumFile`):
   - macOS/Linux: `shasum -a 256 -c tecode-<platform>-<arch>.sha256`
   - Windows (PowerShell): compare
     `(Get-FileHash .\tecode-windows-<arch>.exe -Algorithm SHA256).Hash`
     against the hex digest inside the matching `.sha256` file
     (case-insensitive).
3. macOS/Linux only: `chmod +x tecode-<platform>-<arch>`.
4. Run it against a file or a directory:
   `./tecode-<platform>-<arch> <path>`
   (`.\tecode-windows-<arch>.exe <path>` on Windows). First frame
   renders within ~100 ms (Req 12.2); everything past that — grammars,
   themes, `keybindings.fallback.json` — is embedded in the single binary
   (`scripts/release.ts`'s TSDoc, "Why there is no extra bundler config for
   embedding"), so nothing else needs to be on the machine.

`<path>` does not need to exist yet: a file argument that isn't there on
disk opens as a new, empty, editable buffer, and saving it (`ctrl+s`)
creates the file — `tecode README2.md` on a fresh checkout opens an
empty `README2.md` you can start typing into immediately (Req 5.6, Req
12.4, Issue #88). This only applies when the path's parent directory
already exists and the argument doesn't end in a trailing `/` or `\`
(which always means "directory", never "file"); a typo'd deep path
(`notes/nested/todo.md` with no `notes/nested` directory) still warns
and starts with no file open, exactly as it always has.

macOS Gatekeeper will likely quarantine an unsigned downloaded binary on
first run (`xattr -d com.apple.quarantine tecode-darwin-<arch>` clears
it, or use the Finder's "Open" right-click override) — this repo does not
currently code-sign or notarize release binaries.

### From source (works today, no release required)

1. Install [Bun](https://bun.sh) (this repo pins no specific version
   beyond `bun install`/`bun test` working — CI uses `bun-version: latest`,
   `.github/workflows/ci.yml`).
2. `git clone` this repository, then `bun install` from the repo root
   (installs all workspace packages — `packages/*` — per `package.json`'s
   `workspaces`).
3. Run directly, no compile step: `bun packages/cli/src/main.ts <path>`
   (or `bun run cli <path>`, the equivalent `package.json` script).
4. To produce your own compiled binary for your own machine's platform:
   `bun run release <target>` (e.g. `bun run release bun-linux-x64`) —
   see the "Release" section above for why this machine can only ever
   build ITS OWN host target, not the other three. This does NOT cover
   Intel macOS or Windows on Arm: `RELEASE_TARGETS` no longer names
   `bun-darwin-x64`/`bun-windows-arm64` at all (the "Release" section's
   dropped-platforms note), so `bun run release` on those two rejects the
   target name outright rather than attempting a build — running from
   source (step 3 above) is genuinely the only option there, not just the
   convenient one.

## Keybindings reference

Default keybindings, VS Code-compatible (`{ key, command, when? }`, Req
4.1-4.2) and resolved in this precedence, lowest to highest (Req 4.1, 4.8,
`packages/core/src/keymap/bindingTable.ts`): **core defaults** → the
**terminal-capability fallback keymap** (see "Fallback keymap" below) →
**extension-contributed** bindings → the active **bundled keybinding
preset** (see "Bundled keybinding presets" below) → the **user's own
`keybindings.json`**, which always wins. Every key string below is
already in this codebase's canonical lowercase `mod+...+key` form
(`keymap/normalize.ts`); `return` is Enter's real key name, not `enter`.

This table includes two default-binding sources beyond the four built-in
extension manifests: `MODAL_DEFAULT_KEYBINDINGS` and
`TAB_DEFAULT_KEYBINDINGS` (`packages/core/src/ui/modalCommands.ts` and
`tabCommands.ts`). Both are registered directly against the core command
registry rather than through a `contributes.keybindings` manifest — the
modal overlay (quick pick / input box) and tab switching are core-owned
infrastructure other built-ins depend on already existing (see each
module's own TSDoc) — but they are genuine default KEYBOARD BINDINGS a
user presses every time they use the command palette, quick-open, or
multiple open tabs, so they belong in a user-facing reference table just
as much as any manifest-contributed one. Leaving them out would silently
under-document exactly the keys most used day to day.

### Cursor movement and selection (editor-core, when editor text is focused)

| Key | Command |
|---|---|
| `left` / `right` / `up` / `down` | Cursor left / right / up / down |
| `ctrl+left` / `ctrl+right` | Cursor word left / right |
| `home` / `end` | Cursor to line start / end |
| `ctrl+home` / `ctrl+end` | Cursor to document start / end |
| `shift+left` / `shift+right` / `shift+up` / `shift+down` | Select left / right / up / down |
| `ctrl+shift+left` / `ctrl+shift+right` | Select word left / right |
| `shift+home` / `shift+end` | Select to line start / end |
| `ctrl+shift+home` / `ctrl+shift+end` | Select to document start / end |

### Editing (editor-core, when editor text is focused)

| Key | Command |
|---|---|
| `return` | Insert line break |
| `tab` / `shift+tab` | Indent / outdent |
| `ctrl+s` | Save file |
| `shift+alt+meta+down` | Duplicate line |
| `alt+meta+up` / `alt+meta+down` | Move line up / down |
| `ctrl+shift+k` | Delete line |
| `ctrl+/` (or `ctrl+_` on a non-Kitty terminal) | Toggle line comment |
| `ctrl+z` | Undo |
| `ctrl+shift+z` (or `ctrl+y`) | Redo |
| `ctrl+d` | Add selection to next find match |
| `(` `)` `[` `]` `{` `}` `"` `'` | Bracket/quote auto-close (insert-pair, type-over, or wrap a selection) |

### Find and replace (editor-core)

| Key | When | Command |
|---|---|---|
| `ctrl+f` | editor text focused | Open find |
| `return` | find widget focused | Find next |
| `shift+return` | find widget focused | Find previous |
| `escape` | find widget focused | Close find |

Replace ("Replace" / "Replace All") has no default keybinding in this
MVP — reachable via the command palette only (`editor-core/manifest.ts`'s
own TSDoc explains why: the widget's two inputs don't yet report
distinguishable focus states to bind a shortcut against).

### Tabs (core `TAB_DEFAULT_KEYBINDINGS`, no `when` — always active)

| Key | Command |
|---|---|
| `ctrl+tab` (or `ctrl+pagedown`) | Next tab |
| `ctrl+shift+tab` (or `ctrl+pageup`) | Previous tab |
| `ctrl+w` | Close tab |

### Navigation and command palette (command-palette, no `when`)

| Key | Command |
|---|---|
| `ctrl+shift+p` | Show all commands (the command palette) |
| `ctrl+p` | Go to file (fuzzy quick-open) |

### Explorer

| Key | When | Command |
|---|---|---|
| `ctrl+shift+e` | — | Focus the explorer sidebar |

Create/rename/delete have no default keybinding — reachable via the
command palette only (`explorer/manifest.ts`'s own TSDoc: Req 11.2 asks
for the capability, not a specific shortcut per action).

### Keybindings editor

| Key | Command |
|---|---|
| `ctrl+k ctrl+s` | Open Keyboard Shortcuts (JSON) — a two-stroke chord (Req 4.4) |

### Bundled keybinding presets (Req 4.8)

Set `keybindings.preset` in `settings.json` to layer a bundled keybinding
scheme over the defaults above, without hand-editing `keybindings.json`
yourself. Valid values: `"default"` (none — the schema default), `"emacs"`,
`"windows"`. Changing the setting takes effect immediately, no restart.
There is deliberately no `"vim"` preset: every `when` context in this
codebase (`editorTextFocus`, `editorFocus`, `quickPickFocus`,
`inputBoxFocus`, `findWidgetFocus`, `explorerFocus`, `editorLangId`) is
purely focus-based, with no mode concept a non-modal `"vim"` preset could
honestly model.

**`"emacs"`** (`packages/core/src/keymap/presets/emacs.json`), while an
editor text buffer is focused:

| Key | Command | Note |
|---|---|---|
| `ctrl+a` / `ctrl+e` | Cursor to line start / end | |
| `ctrl+f` / `ctrl+b` | Cursor right / left | Overrides the default `ctrl+f` (open find) |
| `ctrl+n` / `ctrl+p` | Cursor down / up | Overrides the default `ctrl+p` (quick-open) while editor text is focused |
| `alt+f` / `alt+b` | Cursor word right / left | |
| `ctrl+k` | Delete line (kill-line) | |
| `ctrl+s` | Open find (isearch-forward) | Overrides the default `ctrl+s` (save) |
| `ctrl+x ctrl+s` | Save file | Emacs's own save-buffer chord, replacing `ctrl+s` above |

Pressing plain `ctrl+k` under this preset deletes the line directly — it
does **not** wait for a second stroke. Making that true takes one more
entry the table above doesn't show: `keybindings-editor`'s own
`ctrl+k ctrl+s` chord (see "Keybindings editor" above) is removed via
`{ "key": "ctrl+k ctrl+s", "command": "-keybindings.open" }`, because a
chord's prefix always wins over a same-key exact match
(`packages/core/src/keymap/chords.ts`) — left in place, it would make
every `ctrl+k` press sit in a pending state waiting for `ctrl+s` instead
of ever reaching this preset's own kill-line binding.

**`"windows"`** (`packages/core/src/keymap/presets/windows.json`) is
intentionally small: this codebase's defaults are already
VS-Code-on-Windows/Linux-shaped throughout, so there is little left to
change. The one real difference is that the default line-move/duplicate
bindings above (`alt+meta+up` / `alt+meta+down` / `shift+alt+meta+down`)
carry a macOS-only `meta` (Cmd) modifier; this preset adds the
Windows/Linux-native equivalents alongside them:

| Key | Command |
|---|---|
| `alt+up` / `alt+down` | Move line up / down |
| `shift+alt+down` | Duplicate line |

### Quick pick / input box navigation (core `MODAL_DEFAULT_KEYBINDINGS`)

Active only while the command palette, quick-open, or an input box (e.g.
"New File") is open:

| Key | When | Command |
|---|---|---|
| `down` | quick pick focused | Select next item |
| `up` | quick pick focused | Select previous item |
| `return` | quick pick or input box focused | Accept |
| `escape` | quick pick or input box focused | Close |

Rebind or remove any of the above in your own `keybindings.json` —
`samples/keybindings.json` (in this repository) is a working, commented
starting point, and `packages/core/src/ui/keybindingsCommands.ts`'s
`KEYBINDINGS_TEMPLATE` is what a running tecode writes to
`~/.config/tecode/keybindings.json` the first time you run "Open Keyboard
Shortcuts (JSON)" (`ctrl+k ctrl+s`) if that file doesn't exist yet.

## Settings reference

Settings live in `~/.config/tecode/settings.json`
(`%APPDATA%\tecode\settings.json` on Windows —
`packages/core/src/host/paths.ts`'s `getUserSettingsPath`), JSONC
(comments and trailing commas accepted, Req 9.1), watched and applied
live with no restart (Req 9.4). A workspace's own
`.tecode/settings.json` overlays on top (Req 9.2).
`samples/settings.json` (in this repository) is a working, commented
starting point covering every key below.

Pass `--config <dir>` at startup (e.g.
`tecode --config /path/to/cfg ./my-project`) to read the user settings
and user keybindings layers from `<dir>/settings.json` and
`<dir>/keybindings.json` instead (Req 9.6) — useful for an isolated
profile or a CI sandbox. Only the user layer moves; a workspace's own
`.tecode/settings.json` still overlays on top exactly as above. A
missing `<dir>` (or a missing file inside it) is treated the same as a
missing home-directory file: an empty layer, not an error. A relative
`<dir>` resolves against the current working directory. `--config` with
no directory argument after it is ignored (no override applied), and it
never consumes the directory/file argument that opens a workspace —
`tecode --config /path/to/cfg ./my-project` still opens `./my-project`.

Req 9.5 names six MVP settings; the table marks which of them a real
`contributes.configuration` schema registers today, and which do not
exist yet:

| Key | Type | Default | Source | Description |
|---|---|---|---|---|
| `workbench.colorTheme` | string | `"tecode.dark-modern"` | core (`config/coreDefaults.ts`) | The active color theme's id (Req 7.5, 11.4). |
| `editor.lineNumbers` | boolean | `true` | core | Show line numbers in the editor gutter. |
| `editor.tabSize` | number | `4` | core | The number of spaces a tab is equal to. |
| `editor.insertSpaces` | boolean | `true` | core | Insert spaces (up to the next tab stop) instead of a literal tab when pressing Tab. |
| `explorer.showHidden` | boolean | `false` | `explorer` built-in extension (`builtin/explorer/manifest.ts`) | Show hidden (dot-prefixed) and `.gitignore`-ignored files in the explorer sidebar. |
| `keybindings.preset` | string | `"default"` | core (`config/coreDefaults.ts`) | A bundled keybinding scheme layered over the defaults — `"default"` (none), `"emacs"`, or `"windows"` (Req 4.8). See "Bundled keybinding presets" above. |
| `editor.wordWrap` | — | — | **not implemented** | Named by Req 9.5. No `contributes.configuration` schema registers this key, and nothing in `packages/` reads `config.get("editor.wordWrap")` outside of test fixtures exercising the config-merge machinery in the abstract (`packages/core/src/config/service.test.ts`, `themeSettingsWriter.test.ts`) — those tests use the string purely as a generic example key, not as evidence of a real word-wrap feature. Verified by grepping the whole `packages/` tree for both the key string and any wrap-related rendering logic in `EditorView`; there is none. |
| `files.autoSave` | — | — | **not implemented** | Named by Req 9.5. No schema registers it, and no reader ever calls `config.get("files.autoSave")` anywhere in `packages/` (verified the same way as `editor.wordWrap` above — a plain grep for the key string found zero matches at all, not even in a test fixture). |

Extensions declare their own settings via a manifest's
`contributes.configuration` (Req 9.3) and read them back with
`tecode.config.get(key)`; `explorer.showHidden` above is the one example
shipped today. A third-party extension's own settings would be documented
by that extension, not here.

## Terminal support

Req 13.3 names six terminal targets. tecode detects, at startup, whether
the attached terminal answers the Kitty Keyboard Protocol capability query
(`packages/cli/src/terminalCapabilities.ts`'s `resolveKittyKeyboardSupport`)
and, when it does not, overlays the fallback keymap described below so
that otherwise-indistinguishable combinations like `ctrl+shift+p` stay
reachable.

**Read this table's "Verified how" column carefully — it is not a claim
that every row was manually tested.** Only the automated, machine-checked
parts of this detection logic (`terminalCapabilities.test.ts`'s mocked-
response matrix; a real `tmux 3.4`'s own `$TERM`/`$TERM_PROGRAM` values,
captured directly in a headless dev sandbox with no real TTY) have
actually run against something real; the other five terminals are an
**unexecuted manual checklist** (`terminalCapabilities.ts`'s own TSDoc,
"Manual test checklist — Req 13.3's six-terminal matrix") that a human
with access to each real terminal program still needs to run and record.

| Terminal | Verified how | Kitty-capable? |
|---|---|---|
| Ghostty | Unexecuted — manual checklist only | Not run |
| Kitty | Unexecuted — manual checklist only | Not run |
| WezTerm | Unexecuted — manual checklist only | Not run |
| iTerm2 | Unexecuted — manual checklist only | Not run |
| Windows Terminal | Unexecuted — manual checklist only | Not run |
| tmux (any outer terminal) | **Partially verified**: a real `tmux 3.4` binary's `$TERM`/`$TERM_PROGRAM` (`tmux-256color` / `tmux`) were captured directly and confirmed to trigger `resolveKittyKeyboardSupport`'s tmux-passthrough correction — this validates the ENV-VAR ASSUMPTION the tmux branch relies on, not the full keyboard-interaction procedure (no real TTY in that sandbox either, so a `CliRenderer` was never actually exercised against tmux) | Forced `false` regardless of the capability query's own answer (deliberate — tmux's forwarding of Kitty's enable sequence is inconsistent across versions) |

The procedure a human runs to fill in the first five rows — launch inside
each terminal, press `ctrl+shift+p`/`ctrl+g`/`ctrl+shift+e`/`ctrl+shift+k`,
record pass/fail — is written out in full in
`packages/cli/src/terminalCapabilities.ts`'s own TSDoc ("Manual test
checklist") and in `docs/manual-release-verification.md` §3 (the
interactive clean-machine check, which folds the same six-terminal
requirement into its own procedure).

## Fallback keymap

When the attached terminal does not answer the Kitty Keyboard Protocol
capability query (or answers it unreliably — see "Terminal support"
above), tecode overlays a small fallback keymap that remaps the handful
of default bindings whose modifier a legacy terminal cannot disambiguate
(Req 4.7; design.md §6.5). This is a distinct LAYER, not a special case of
any other layer: the full precedence is core defaults → **fallback** →
extension-contributed bindings → the user's `keybindings.json`
(`packages/core/src/keymap/bindingTable.ts`'s `KeymapLayers`) — sitting
directly above core defaults means a fallback entry can safely remap
something a default binds, while still sitting below EVERY extension and
user binding means the user's own `keybindings.json` always wins, with no
special-casing needed to override a fallback entry.

The bundled fallback keymap
(`packages/core/src/keymap/keybindings.fallback.json`) ships three
entries today:

| Key | Command | When |
|---|---|---|
| `ctrl+g` | `workbench.action.showCommands` | — |
| `ctrl+e` | `explorer.focus` | — |
| `ctrl+l` | `editor.action.deleteLine` | `editorTextFocus` |

Each patches a real `ctrl+shift+<letter>` ambiguity that a legacy
terminal collapses to the same raw control byte as its unshifted
counterpart (`ctrl+shift+p`/`ctrl+shift+e`/`ctrl+shift+k` respectively —
`packages/cli/src/fallbackKeybindingsCompleteness.test.ts` enumerates the
full hazard set and proves every one of them has either an unambiguous
alternate binding already, or a fallback entry like these).

This file is user-overridable, separately from `keybindings.json`
(`packages/core/src/host/paths.ts`'s `getUserFallbackKeybindingsPath`): a
`~/.config/tecode/keybindings.fallback.json` (or the Windows equivalent
under `%APPDATA%\tecode\`) ENTIRELY REPLACES the bundled file — not
merged with it — letting you pick your own non-colliding alternates for
your specific legacy terminal without touching your real
`keybindings.json`. This layer is resolved once at startup, alongside the
Kitty-capability verdict it depends on, and is not live-reloaded the way
`settings.json`/`keybindings.json` are
(`packages/core/src/keymap/fallbackKeybindings.ts`'s own TSDoc).

## Documentation

[`docs/extension-authoring-guide.md`](docs/extension-authoring-guide.md)
walks through building a `tecode` extension end to end — manifest,
activation, a command, a sidebar view, a configuration key, a
keybinding — documents every `tecode.*` API namespace, and covers
bundling extensions with npm dependencies and the API-version
compatibility policy.
