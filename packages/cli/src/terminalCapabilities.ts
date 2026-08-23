/**
 * Terminal-capability detection (Req 4.7, 7.4; design.md §3, §6.5, §9;
 * tasks.md's Task 1.15 stub, extended by Task 2.6 for color depth).
 *
 * **Kitty Keyboard Protocol**: still a fixed, conservative `false` — real
 * detection (querying the protocol, sniffing `$TERM`/`$TERM_PROGRAM` for
 * tmux passthrough) is Task 4.2's job, out of this task's scope. A genuine
 * protocol query is a request/response round-trip that cannot be awaited
 * synchronously inside the sync phase's <100ms first-frame budget
 * (design.md §15), so it stays deliberately deferred here; the keymap
 * fallback layer (`@tecode/core`'s `KeymapLayers.fallback`) stays empty
 * until Task 4.2 wires real detection into it.
 *
 * **Color depth** (Req 7.4, design.md §9), THIS task's addition — and,
 * unlike the Kitty protocol, entirely synchronous env-var sniffing, so
 * nothing here risks the first-frame budget:
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
 */

/** What the sync phase can currently learn about the host terminal (this
 * module's TSDoc). */
export interface TerminalCapabilities {
  /** Whether the Kitty Keyboard Protocol is assumed available (Req 4.7).
   * Always `false` until Task 4.2's real probe lands — the conservative
   * assumption, since treating an unsupported terminal as Kitty-capable
   * would silently break otherwise-indistinguishable combinations (e.g.
   * `ctrl+shift+*`) that Req 4.7's fallback keymap exists to cover. */
  kittyKeyboardProtocol: boolean;
  /** Detected terminal color depth (Req 7.4) — see this module's TSDoc for
   * the detection rule. Feeds `@tecode/core`'s `ThemeRegistry`'s
   * `colorDepth` (Req 7.4, `main.ts`'s `buildAssemblyRoot`), which
   * quantizes every theme once at build time for anything less than
   * `"truecolor"`. */
  colorDepth: "truecolor" | "256" | "16";
}

/** Detect the host terminal's capabilities (Req 4.7, 7.4). See this
 * module's TSDoc for the color-depth detection rule and the Kitty
 * protocol's still-fixed placeholder. Reads only `process.env`, does no
 * I/O, and never throws. */
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

  return { kittyKeyboardProtocol: false, colorDepth };
}
