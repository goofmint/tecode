# tecode

## CI

Issue #36 "4.5 CI pipeline" (Req 13.1, 13.2, 13.4; design.md §15, §16).
`.github/workflows/ci.yml` runs five independent jobs on every push to
`main` and every pull request; `.github/workflows/release.yml` runs a
sixth, tag-triggered job (see the "Release" section below). Each CI job
is reproducible locally with one `bun run` script:

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

Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds all
six `RELEASE_TARGETS` in parallel — one matched-architecture runner per
target (see that workflow's own top-of-file comment for the full "why six
runners, not three" explanation and the exact target→runner table), each
invoking `bun run release <its-own-target>` so it only ever builds the one
target its own `@opentui/core` native optional dependency can actually
link for. Every target uploads its binary as its own artifact
(`tecode-<target>`) and a small size-report JSON; a final `summary` job
(`if: always()`, so it still runs and reports even if one leg failed)
collects those into a target × size Markdown table written to the run's
job summary, checked against `scripts/release.ts`'s own
`SIZE_LIMIT_BYTES` (120,000,000 bytes, the decimal — stricter — reading of
"≤ 120 MB").

Issue #38 "5.2 User documentation and release" adds a SHA-256 checksum
next to every binary (`scripts/release.ts`'s `writeChecksumFile`, run as
part of the same `bun run release <target>` invocation — see that
script's TSDoc) and a `publish` job that runs only once all six matrix
legs succeed: it downloads every binary and checksum, refuses to proceed
unless exactly six of each are present, and runs `gh release create`
against the pushed tag with `docs/release-notes-template.md` as the
release body. `publish` is the only job in this workflow with
`contents: write`, scoped to itself in its own `permissions:` block —
`build` and `summary` stay read-only (`.github/workflows/release.yml`'s
top-of-file comment).

## Install

tecode ships as six self-contained, single-file compiled binaries — one
per `darwin`/`linux`/`windows` × `x64`/`arm64` combination (Req 13.2) —
built by `scripts/release.ts` and published as GitHub Release assets by
`.github/workflows/release.yml`'s tag-triggered `publish` job (see
"Release" above). No separate runtime install is required to RUN a
downloaded binary; all packages in this monorepo are `"private": true`, so
there is no `npm install -g tecode` — a compiled binary or a source
checkout are the only two ways to run it.

### From a published release (once one exists)

1. Download the binary matching your platform from the release's assets:

   | Platform | Architecture | Asset |
   |---|---|---|
   | macOS | Apple Silicon | `tecode-darwin-arm64` |
   | macOS | Intel | `tecode-darwin-x64` |
   | Linux | x64 | `tecode-linux-x64` |
   | Linux | arm64 | `tecode-linux-arm64` |
   | Windows | x64 | `tecode-windows-x64.exe` |
   | Windows | arm64 | `tecode-windows-arm64.exe` |

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
   build ITS OWN host target, not the other five.

## Keybindings reference

Default keybindings, VS Code-compatible (`{ key, command, when? }`, Req
4.1-4.2) and resolved in this precedence, lowest to highest (Req 4.1,
`packages/core/src/keymap/bindingTable.ts`): **core defaults** → the
**terminal-capability fallback keymap** (see "Fallback keymap" below) →
**extension-contributed** bindings → the **user's own `keybindings.json`**,
which always wins. Every key string below is already in this codebase's
canonical lowercase `mod+...+key` form (`keymap/normalize.ts`); `return`
is Enter's real key name, not `enter`.

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
