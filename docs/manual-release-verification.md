# Manual release verification (Issue #35 "4.4 Compiled binary builds")

Req 8.5, 13.2; design.md §17. `scripts/release.ts` and
`packages/cli/src/compiledBinary.smoke.test.ts` automate everything this
repo's tooling *can* automate on a single Linux CI/dev machine. Three of
Issue #35's completion requirements genuinely cannot be — they need a
platform this environment does not have (a native macOS/Windows machine to
compile on) or a real TTY (an interactive terminal session). This document
is the procedure a human runs to close each of them, and — separately —
what's already covered automatically, so nobody re-verifies work that's
already proven.

**Why this file, and not just a TSDoc comment or the README**: each of the
three procedures below has multiple ordered steps and expected outputs that
read far more clearly as a runbook than folded into `scripts/release.ts`'s
already-long embedding-story TSDoc. `README.md` is currently just a title
with no other content — turning a release-verification runbook into the
project's first real README content would misrepresent it as general
project documentation rather than what it is. A dedicated `docs/` file
matches this repo's own precedent for this kind of record
(`packages/builtin/languages-basic/NOTICE.md` — "vendored asset provenance
... records where each came from ... every trade-off made"): a durable,
specifically-named document a reader can find and update independently of
any one source file. `scripts/release.ts`'s own TSDoc points here, and so
does `README.md`, so either entry point reaches it.

## 1. The three non-Linux-x64 targets

**Why this can't run here**: `@opentui/core` ships six platform-specific
optional dependencies (`@opentui/core-{darwin,linux,win32}-{x64,arm64}`),
each carrying `os`/`cpu` `package.json` fields — `bun install` links only
the one matching the host. `@opentui/core`'s own runtime code resolves its
native half with a template-string dynamic import
(`` import(`@opentui/core-${process.platform}-${process.arch}/index.ts`) ``)
that Bun's bundler cannot statically resolve for any platform other than
the host's, so `bun build --compile --target=<non-host>` fails with `error:
Could not resolve: "@opentui/core-<platform>-<arch>/index.ts"` — verified
for this task on this machine for both `bun-darwin-arm64` and
`bun-windows-x64`. This is a property of `@opentui/core`'s packaging, not a
bug in this codebase or in `scripts/release.ts`; `classifyBuildFailure` in
that script recognizes this exact signature and labels it as a known
limitation rather than a generic build failure, but it does not — and
cannot — work around it.

**Only four targets are published at all**: `scripts/release.ts`'s
`RELEASE_TARGETS` is `bun-darwin-arm64`, `bun-linux-x64`,
`bun-linux-arm64`, and `bun-windows-x64` — NOT the full six-way
`darwin`/`linux`/`windows` × `x64`/`arm64` cross-product. `bun-darwin-x64`
(Intel macOS) and `bun-windows-arm64` (Windows on Arm) are gone from the
matrix entirely: the release pipeline's CI provider has no runner of
either architecture (no Intel-macOS resource class since June 2024, no
Windows-arm64 resource class at all), and the project has no such hardware
to self-host either one. There is nothing to manually verify for those two
— they are not built anywhere, by anyone, as a deliberate decision, not an
oversight (`scripts/release.ts`'s TSDoc, "Two targets were dropped, not
just left off this machine"). This section's procedure therefore covers
the three remaining non-host targets only.

**Procedure** (run once per platform, on a real machine or CI runner of
that platform — this is exactly what happens automatically for
`bun-linux-arm64`/`bun-windows-x64` in the tag-triggered CircleCI release
pipeline (`.circleci/config.yml`), and for `bun-darwin-arm64` in `bun run
tag` (`scripts/tagRelease.ts`, run by hand on the project owner's own
Apple Silicon Mac — see the README's "Release" section for why that one
target is built locally instead of by CircleCI)):

1. On a `darwin`/`arm64`, `linux`/`arm64`, or `windows`/`x64` machine with
   Bun installed, clone the repo and run `bun install` — this links that
   host's OWN `@opentui/core-<platform>-<arch>` package, which is what
   makes the build possible at all.
2. Run `bun run release bun-<platform>-<arch>` (the exact target name from
   `scripts/release.ts`'s `RELEASE_TARGETS`, e.g. `bun run release
   bun-darwin-arm64`).
3. Confirm the script prints `<target>: ok (<size> MB)` and exits 0. A
   `build-failed` outcome whose reason does NOT mention "known limitation"
   is a real regression — investigate it as such, not as this document's
   limitation. Record the exact byte size reported (not just the rounded MB
   the script prints) in the PR — the exact command depends on the
   platform, since `scripts/release.ts`'s `binaryFileName` produces a
   `.exe` suffix on Windows and nothing else does:
   - **macOS/Linux** (`bun-darwin-arm64`, `bun-linux-arm64`):
     `ls -la dist/tecode-<platform>-<arch>`, e.g. `ls -la
     dist/tecode-darwin-arm64`.
   - **Windows** (`bun-windows-x64`) — `ls -la` is not a PowerShell
     command; use PowerShell's own `Get-Item` instead, and don't forget
     the `.exe` suffix `binaryFileName` actually generates for this
     target: `(Get-Item .\dist\tecode-windows-x64.exe).Length`
4. Repeat for each of the remaining two targets.

## 2. Windows `%APPDATA%\tecode\` resolution on real Windows

**What's already covered automatically, without a real Windows machine**:
`packages/core/src/host/paths.ts` is the ONE module in this codebase that
branches on `process.platform` (verified for this task: `grep -rn
"process\.platform" packages` outside `node_modules` returns only
`paths.ts` and its own test — `scripts/release.ts`'s own references to
`process.platform` are quoted strings describing `@opentui/core`'s
unrelated dynamic-import code, not a branch on the running host).
`packages/core/src/host/paths.test.ts` covers `getUserConfigDir`'s Windows
branch with `process.platform` mocked to `"win32"` and `APPDATA` both set
and unset, proving the `%APPDATA%\tecode` / `~/AppData/Roaming/tecode`
fallback logic itself is correct. What that test CANNOT prove, because it
runs on this Linux machine, is that `%APPDATA%` is what Windows itself
actually sets it to in practice, and that a real Windows process reads the
same value this repo assumes.

**Procedure** (real Windows machine, or a Windows CI runner):

1. Build (per §1 above) or obtain a `tecode-windows-<arch>.exe`.
2. Open PowerShell and confirm the environment: `echo $env:APPDATA` should
   print something like `C:\Users\<you>\AppData\Roaming`.
3. Run the binary against a scratch directory: `.\tecode-windows-x64.exe
   C:\path\to\some\folder` with `TECODE_HEADLESS=1` set
   (`$env:TECODE_HEADLESS = "1"`) so it exits on its own.
4. Confirm `%APPDATA%\tecode\` was created and populated (`state.json` at
   minimum, from `layoutState.flush()` — Req 6.4) — `dir
   $env:APPDATA\tecode`.
5. Optionally, unset `APPDATA` (`Remove-Item Env:APPDATA`) and re-run to
   confirm the `~/AppData/Roaming/tecode` fallback path activates instead
   (this is the rare-but-documented branch `getUserConfigDir`'s TSDoc
   calls out).
6. Record the PowerShell transcript (or a screenshot) in the PR.

## 3. Interactive clean-machine check

**Why this can't run here**: there is no TTY in this environment —
`renderShellToTerminal` never gets a real terminal to draw into, and
`process.stdout.isTTY` is `false`, which is exactly what makes
`TECODE_HEADLESS=1` (or its own auto-detection) kick in for every other
check in this task. Rendering, theme switching, and live syntax
highlighting as a human actually SEES them cannot be captured by a
headless subprocess test.

**What's already covered automatically, in-process, against the same
production code the binary contains**:
`packages/cli/src/highlightIncremental.e2e.test.ts` exercises the real
highlight pipeline end to end against `languages-basic`'s embedded
grammars; `packages/cli/src/themeSelectDefaultThemes.test.ts` and
`themesVisual.test.tsx` exercise `theme.select` and the rendered theme
output against
the real `themes-default` built-in, using OpenTUI's headless renderer (Req
13.4's own "UI components SHALL be covered by snapshot tests using
OpenTUI's headless renderer"). Both run against the exact same
`buildAssemblyRoot`/`runDeferredPhase` composition root a compiled binary
uses — this procedure exists only to confirm a human, on a real terminal,
sees the same thing.

**Procedure** (any machine matching a built target, in one of Req 13.3's
supported terminals — Ghostty, Kitty, WezTerm, iTerm2, Windows Terminal, or
inside tmux):

1. Obtain a compiled binary for that platform (§1 above, or the native
   `bun-linux-x64` build from this machine if testing on Linux).
2. Copy it to a directory with NO existing `~/.config/tecode/` (or
   `%APPDATA%\tecode\` on Windows) — a genuinely clean profile, so nothing
   the binary reads was left over from a dev checkout.
3. Open a real terminal session in one of the supported terminals above.
4. Run
   `./tecode-<platform>-<arch> <path-to-a-directory-containing-a-.ts-file>`
   with NO `TECODE_HEADLESS` set, so it renders to the real terminal.
5. Confirm: the shell renders (sidebar, editor area, status bar) within
   about 100 ms of launch — no visible flash-of-unstyled or blank frame.
6. Open the `.ts` file (via the explorer or `ctrl+p` quick-open) and
   confirm TypeScript syntax highlighting renders correctly — keywords,
   strings, types in distinct colors — with NO external grammar/theme
   files present anywhere on the machine (this is the point: Req 8.5's
   embedding means this must work with nothing but the one binary file).
7. Open the command palette (`ctrl+shift+p`), run `theme.select`, and
   switch from the default theme to the other bundled theme (Dark
   Modern ↔ Light Modern). Confirm the whole UI repaints with the new
   palette immediately.
8. **Long modals (issue #93 — "the display does not update when scrolling
   within the modal")**: `modalOverlay.test.tsx`'s headless regression test
   already proves the underlying layout math (a bounded `<select>` that
   fits the terminal and keeps the active item inside its visible window,
   `modalOverlay.tsx`'s TSDoc's "Vertical bound"); what a headless test
   canNOT prove is that a REAL terminal's live redraw actually shows the
   scrolled window changing as you move the selection — resize this test
   for, and the whole reason this bug shipped in the first place. In a
   directory/project with enough files and commands to overflow the
   terminal's height (or simply shrink the terminal window first):
   1. Open `workbench.action.quickOpen` (`ctrl+p`). Confirm the picker's
      box stops well short of the terminal's bottom edge — no filenames
      spill past it or get cut off mid-row — and that holding `down`
      through every item visibly SCROLLS the list (the window of visible
      rows moves) with the highlighted row always on screen, all the way
      to the last item.
   2. Open `workbench.action.showCommands` (`ctrl+shift+p`) and repeat the
      same check against the command list.
   3. Run `keybindings.showResolved` (via the command palette — Req
      11.7/design.md §13, it has no keybinding of its own) against a
      keymap with enough bindings to exceed the terminal's height; repeat
      the same check.
   4. Shrink the terminal window to a noticeably smaller size WHILE one of
      the pickers above is still open, and confirm the picker re-bounds
      itself to the new size on the next redraw rather than staying
      pinned to the old (now possibly too-large) box.
9. Exit cleanly (`ctrl+c` or the equivalent) and confirm the terminal is
   restored to its normal (non-raw, non-alternate-screen) state.
10. Record which terminal emulator and OS/arch combination was used, plus a
    screenshot or terminal recording, in the PR.
