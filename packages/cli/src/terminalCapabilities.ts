/**
 * Terminal-capability detection stub (Req 4.7, design.md §3, §6.5;
 * tasks.md's Task 1.15: "terminal capability detection stub"). Real
 * detection — querying the Kitty Keyboard Protocol, sniffing
 * `COLORTERM`/terminfo for color depth — is Task 4.2's job. This stub
 * returns fixed, conservative defaults so the sync phase has something to
 * call here without adding real I/O: a genuine terminal query is a
 * request/response round-trip that cannot be awaited synchronously inside
 * the sync phase's <100ms first-frame budget (design.md §15), so it is
 * deliberately deferred rather than half-implemented here.
 *
 * Nothing downstream consumes the result yet: the keymap fallback layer
 * (`@tecode/core`'s `KeymapLayers.fallback`, Req 4.7) stays empty until
 * Task 4.2 wires real detection into it (`packages/cli/src/keymapState.ts`
 * documents the same deferral). This function exists now so that wiring is
 * "populate `fallback` from this result," not "add a new call site to the
 * startup sequence."
 */

/** What the sync phase can currently learn about the host terminal — see
 * this module's TSDoc for why every value here is a fixed placeholder. */
export interface TerminalCapabilities {
  /** Whether the Kitty Keyboard Protocol is assumed available (Req 4.7).
   * Always `false` until Task 4.2's real probe lands — the conservative
   * assumption, since treating an unsupported terminal as Kitty-capable
   * would silently break otherwise-indistinguishable combinations (e.g.
   * `ctrl+shift+*`) that Req 4.7's fallback keymap exists to cover. */
  kittyKeyboardProtocol: boolean;
  /** Assumed terminal color depth. Always `"truecolor"` until Task 4.2's
   * real probe lands and Task 2.6's theme quantization can react to a
   * downgraded value. */
  colorDepth: "truecolor" | "256" | "16";
}

/** Detect the host terminal's capabilities (Req 4.7). See this module's
 * TSDoc: returns fixed defaults today; never throws. */
export function detectTerminalCapabilities(): TerminalCapabilities {
  return { kittyKeyboardProtocol: false, colorDepth: "truecolor" };
}
