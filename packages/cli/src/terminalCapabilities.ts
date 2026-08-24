/**
 * Terminal-capability detection (Req 4.7, 7.4; design.md §3, §6.5, §9;
 * tasks.md's Task 1.15 stub, extended by Task 2.6 for color depth and by
 * Task 4.2 for the real Kitty Keyboard Protocol verdict this module's
 * TSDoc used to describe as "still a fixed, conservative `false`").
 *
 * **Color depth** (Req 7.4, design.md §9) — synchronous env-var sniffing,
 * so nothing here risks the sync phase's <100ms first-frame budget
 * (design.md §15):
 *
 * 1. `$COLORTERM` is `"truecolor"` or `"24bit"` (case-insensitive, matching
 *    the two conventional spellings terminal emulators actually set) ->
 *    `"truecolor"`.
 * 2. Otherwise, `$TERM` containing `"256color"` (e.g. `xterm-256color`,
 *    `screen-256color`) -> `"256"`.
 * 3. Otherwise -> `"256"` — the conservative default (this task's plan):
 *    almost every terminal in active use supports at least the 256-color
 *    palette even when neither env var says so explicitly (a bare
 *    `TERM=xterm` under a misconfigured multiplexer, for instance), and
 *    quantizing truecolor values down to xterm-256 when the terminal
 *    actually *did* support truecolor is a far smaller visual regression
 *    than assuming truecolor on a terminal that only has 16/256 colors and
 *    rendering garbage.
 *
 * **Kitty Keyboard Protocol** (Req 4.7, 13.3; design.md §6.5) — Task 4.2's
 * addition, and, unlike color depth, NOT something {@link
 * detectTerminalCapabilities} can resolve synchronously: real detection is
 * a protocol query/response round-trip (`@opentui/core`'s `CliRenderer`
 * sends a capability query on `setupTerminal()` and either decodes the
 * terminal's answer or gives up after its own internal 5-second timeout
 * with no event at all — see `renderShell.tsx`'s TSDoc for how that
 * round-trip is bridged into this process). {@link resolveKittyKeyboardSupport}
 * is the PURE decision function this module contributes instead: given
 * whatever `@opentui/core`'s `CliRenderer.capabilities` currently holds
 * (synchronously available immediately, and updated again if/when a
 * `"capabilities"` event fires — `renderShell.tsx`) plus `$TERM`/
 * `$TERM_PROGRAM`, it decides whether the fallback keymap
 * (`@tecode/core`'s `keymap/fallbackKeybindings.ts`) is needed. Kept
 * entirely separate from the OpenTUI round-trip itself so it can be unit
 * tested with plain object literals instead of a real terminal
 * (`terminalCapabilities.test.ts`).
 *
 * **`@opentui/core@0.1.107` (the version this repo pins) types
 * `CliRenderer.capabilities` as `any | null`** — a real `TerminalCapabilities`
 * type with a typed `kitty_keyboard: boolean` field only exists in a
 * LATER OpenTUI version also present in the Bun store but NOT the one
 * `packages/cli/package.json` depends on; nothing in this codebase may
 * assume that later shape. {@link resolveKittyKeyboardSupport} therefore
 * takes `unknown` and narrows defensively at runtime via {@link
 * readKittyKeyboardFlag} (a `typeof value?.kitty_keyboard === "boolean"`
 * check, not a cast) — confirmed against the actual vendored
 * `@opentui/core@0.1.107` bundle: `getTerminalCapabilities()` returns a
 * plain object whose `kitty_keyboard` field IS a genuine runtime boolean
 * despite the `any` static type, so this narrowing is correctness, not
 * paranoia.
 *
 * **Conservative default: unknown/absent -> NOT Kitty-capable.** The
 * capability query can time out with no `"capabilities"` event ever
 * firing (`renderShell.tsx`'s TSDoc); `CliRenderer.capabilities` can also
 * be `null` outright (before `setupTerminal()` has run at all — a
 * headless/no-render code path never gets this far in the first place).
 * {@link readKittyKeyboardFlag} returns `undefined` for either case, and
 * {@link resolveKittyKeyboardSupport} treats `undefined` exactly like an
 * explicit `false`: assuming Kitty support on a terminal that lacks it
 * silently breaks otherwise-indistinguishable combinations (e.g.
 * `ctrl+shift+p` colliding with `ctrl+p` — `command-palette/manifest.ts`'s
 * TSDoc), while the reverse (applying the fallback keymap on a terminal
 * that actually WAS Kitty-capable) merely adds a handful of harmless
 * extra low-precedence bindings nothing else claims.
 *
 * **tmux passthrough correction** (Req 4.7, 13.3; design.md §6.5's "also
 * honoring `$TERM`/`$TERM_PROGRAM` heuristics for tmux passthrough"):
 * tmux's own forwarding of Kitty's protocol-enable escape sequence to the
 * OUTER terminal is inconsistent across tmux versions/configurations —
 * a capability query answered `true` while running inside tmux is not
 * trustworthy enough to skip the fallback keymap. `$TERM` starting with
 * (or containing) `"tmux"`/`"screen"` (tmux's own two conventional `TERM`
 * values — `terminalCapabilities.test.ts`'s pre-existing color-depth
 * matrix already treats `screen-256color` as tmux's signature, reused
 * here for the same reason) or `$TERM_PROGRAM === "tmux"` forces the
 * verdict to `false` regardless of what the query itself reported.
 *
 * ## Manual test checklist — Req 13.3's six-terminal matrix
 *
 * Everything above this point is machine-verified
 * (`terminalCapabilities.test.ts`'s mocked-response matrix,
 * `fallbackKeybindingsCompleteness.test.ts`, `keymapState.test.ts`'s
 * precedence tests). Req 13.3 additionally names six real terminal
 * programs the detection/fallback pair must behave correctly against —
 * that can only be confirmed by actually running `bun packages/cli/src/
 * main.ts` inside each one and pressing keys, which no automated test in
 * this repository can do (there is no real TTY in CI or in this sandbox).
 * This is the procedure a human runs once per terminal, and the six-row
 * result table that procedure produces belongs in the PR description, not
 * in this file (this codebase keeps no `docs/` directory or PR template
 * for it to live in instead).
 *
 * **Procedure, per terminal:**
 *
 * 1. Launch `bun packages/cli/src/main.ts <some file>` directly inside
 *    the terminal program under test (a REAL attached terminal, not
 *    `TECODE_HEADLESS=1` — headless mode never opens a `CliRenderer` at
 *    all, so it cannot exercise any of this).
 * 2. Confirm the app starts and paints (first frame appears; no crash).
 * 3. Press `Ctrl+Shift+P` — expect the command palette to open
 *    (`workbench.action.showCommands`). On a terminal WITHOUT Kitty
 *    protocol support, if the fallback keymap did not apply, this would
 *    instead silently trigger quick-open (`ctrl+p`'s command) —
 *    `command-palette/manifest.ts`'s TSDoc documents that exact collision.
 * 4. Press `Ctrl+G` — on a NON-Kitty-capable terminal, expect this to ALSO
 *    open the command palette (`keybindings.fallback.json`'s alternate
 *    binding). On a Kitty-capable terminal, expect it to do nothing (the
 *    fallback layer should be empty, since the direct `Ctrl+Shift+P`
 *    already worked in step 3).
 * 5. Open a file, place the cursor in the editor, press `Ctrl+Shift+E` —
 *    expect the explorer sidebar to focus (`explorer.focus`). On a
 *    non-Kitty terminal without the fallback applied, this would silently
 *    do nothing (`ctrl+e` is otherwise unbound).
 * 6. With the editor focused, press `Ctrl+Shift+K` on a line of text —
 *    expect that line to be deleted (`editor.action.deleteLine`). On a
 *    non-Kitty terminal without the fallback applied, this would silently
 *    do nothing.
 * 7. Record PASS/FAIL for steps 3-6 (steps 1-2 are prerequisites, not
 *    separately scored) against each of the six terminals below, plus
 *    whether the terminal was observed to be Kitty-capable (steps 3
 *    succeeding on its own, with step 4 correctly doing nothing) or not
 *    (step 3 failing, step 4 picking up the slack, steps 5-6 needing their
 *    own fallback keys `ctrl+e`/`ctrl+l` respectively).
 *
 * | Terminal | Kitty-capable? | Step 3 (ctrl+shift+p) | Step 4 (ctrl+g fallback) | Step 5 (ctrl+shift+e) | Step 6 (ctrl+shift+k) |
 * | --- | --- | --- | --- | --- | --- |
 * | Ghostty | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) |
 * | Kitty | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) |
 * | WezTerm | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) |
 * | iTerm2 | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) |
 * | Windows Terminal | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) |
 * | tmux (any outer terminal) | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) | (unexecuted) |
 *
 * **What COULD be, and WAS, checked in a headless dev sandbox (no real
 * TTY, so still not the manual procedure above):** this sandbox has a
 * real `tmux 3.4` binary, so `$TERM`/`$TERM_PROGRAM` inside an actual
 * tmux session were captured directly (`tmux-256color` /
 * `tmux` respectively) and confirmed to trigger {@link
 * resolveKittyKeyboardSupport}'s tmux-passthrough correction — this
 * validates the ENV-VAR ASSUMPTION the tmux branch relies on against a
 * real tmux, even though the full keyboard-interaction procedure above
 * still needs a human on an attached terminal (this sandbox's stdout is
 * not a TTY, so `createCliRenderer()` was never exercised against tmux
 * here). Ghostty/iTerm2/Windows Terminal are not installed in this
 * environment at all, so none of their rows above were run, fabricated,
 * or guessed at — they are unexecuted templates for a human to fill in.
 */

/** What the sync phase can currently learn about the host terminal (this
 * module's TSDoc). */
export interface TerminalCapabilities {
  /** Detected terminal color depth (Req 7.4) — see this module's TSDoc for
   * the detection rule. Feeds `@tecode/core`'s `ThemeRegistry`'s
   * `colorDepth` (Req 7.4, `main.ts`'s `buildAssemblyRoot`), which
   * quantizes every theme once at build time for anything less than
   * `"truecolor"`. */
  colorDepth: "truecolor" | "256" | "16";
}

/** Detect the host terminal's SYNCHRONOUSLY-knowable capabilities (Req
 * 7.4) — just `colorDepth`; see this module's TSDoc for the detection
 * rule. The Kitty Keyboard Protocol verdict is deliberately NOT part of
 * this function's result (this module's TSDoc explains why it cannot be
 * synchronous) — see {@link resolveKittyKeyboardSupport} instead. Reads
 * only `process.env`, does no I/O, and never throws. */
export function detectTerminalCapabilities(): TerminalCapabilities {
  const colorTerm = (process.env["COLORTERM"] ?? "").toLowerCase();
  const term = (process.env["TERM"] ?? "").toLowerCase();

  let colorDepth: TerminalCapabilities["colorDepth"];
  if (colorTerm === "truecolor" || colorTerm === "24bit") {
    colorDepth = "truecolor";
  } else if (term.includes("256color")) {
    colorDepth = "256";
  } else {
    colorDepth = "256";
  }

  return { colorDepth };
}

/**
 * Defensively read `kitty_keyboard` off whatever `@opentui/core`'s
 * `CliRenderer.capabilities` currently holds (this module's TSDoc's
 * "`@opentui/core@0.1.107`..." paragraph) — `value` is `unknown`
 * (mirroring that getter's actual `any | null` static type, which this
 * module refuses to trust blindly), and the result is `undefined` for
 * anything that doesn't shape up as `{ kitty_keyboard: boolean }`
 * (`null`, not-an-object, a missing field, or a field that is present but
 * not actually a `boolean`), never a thrown error.
 */
function readKittyKeyboardFlag(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kittyKeyboard = (value as { kitty_keyboard?: unknown }).kitty_keyboard;
  return typeof kittyKeyboard === "boolean" ? kittyKeyboard : undefined;
}

/** The `$TERM`/`$TERM_PROGRAM` slice {@link resolveKittyKeyboardSupport}
 * needs — narrowed to exactly these two keys (rather than all of
 * `process.env`) so the function stays a plain, pure, trivially-testable
 * value-in/value-out call (this module's TSDoc). */
export interface KittyKeyboardEnv {
  TERM?: string;
  TERM_PROGRAM?: string;
}

/**
 * Decide whether the fallback keymap (`@tecode/core`'s `keymap/
 * fallbackKeybindings.ts`, Req 4.7) is needed: `false` means "apply the
 * fallback layer", `true` means "the terminal disambiguates the
 * bindings the fallback layer exists to patch — leave `KeymapState`'s
 * `fallback` layer empty."
 *
 * Pure and argument-driven (this module's TSDoc) — `capabilitiesValue` is
 * whatever `@opentui/core`'s `CliRenderer.capabilities` held at the
 * moment of the call (or a `"capabilities"` event payload —
 * `renderShell.tsx`), `env` is the process environment's `$TERM`/
 * `$TERM_PROGRAM` slice. Never throws.
 *
 * See this module's TSDoc for the conservative-default and
 * tmux-passthrough-correction rules this implements.
 */
export function resolveKittyKeyboardSupport(
  capabilitiesValue: unknown,
  env: KittyKeyboardEnv,
): boolean {
  const kittyKeyboard = readKittyKeyboardFlag(capabilitiesValue);
  if (kittyKeyboard !== true) return false;

  const term = (env.TERM ?? "").toLowerCase();
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (term.includes("tmux") || term.includes("screen") || termProgram === "tmux") {
    return false;
  }

  return true;
}
