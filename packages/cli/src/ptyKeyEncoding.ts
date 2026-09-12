/**
 * Encodes one `RoutableKeyEvent` (`keyRouting.ts`) into the exact bytes the
 * integrated terminal's pty should receive (Issue #145).
 *
 * **The bug this fixes**: `handleKeyEvent`'s terminal-focused branch used
 * to forward `event.raw ?? event.sequence ?? ""` verbatim
 * (`keyRouting.ts`'s previous `deps.terminal.write` call) — the exact raw
 * terminal bytes `@opentui/core`'s `KeyHandler` decoded this keystroke
 * from. On a Kitty Keyboard Protocol-capable terminal (`RoutableKeyEvent.raw`'s
 * own TSDoc), `Ctrl+G` arrives as the CSI-u sequence `ESC [ 103 ; 5 u`, not
 * as the legacy control byte `0x07`. The pty's own child shell never
 * enabled the Kitty protocol itself, so it cannot decode CSI-u: it
 * consumes the leading `ESC [` as an unrecognized sequence and prints the
 * remainder (`"03;5u"`) literally — exactly the garbage Issue #145 reports.
 *
 * **The fix**: re-derive the legacy control byte from the event's already-
 * decoded SEMANTIC fields (`name`/`ctrl`/`option`) instead of replaying
 * `event.raw` unmodified. `@opentui/core` decodes CSI-u into these semantic
 * fields correctly regardless of protocol — `{ name: "g", ctrl: true }` is
 * exactly as true for the Kitty CSI-u encoding as for a legacy raw
 * `0x07` byte — so recomputing `code & 0x1f` from `name` produces the
 * SAME one-byte control code either way. On a non-Kitty terminal, `raw` is
 * already that same control byte, so recomputing it changes nothing
 * (no regression); on a Kitty-capable terminal, recomputing it is what
 * makes the child process see a byte it can actually interpret.
 *
 * Every other kind of keystroke (arrows, function keys, IME-committed
 * text, unmodified typing, `option`/`meta`-modified keys outside the plain
 * `ctrl+<letter>` shape) is NOT reshaped here — {@link encodeKeyEventForPty}
 * falls back to `event.raw ?? event.sequence ?? ""`, `keyRouting.ts`'s own
 * previous behavior, verbatim. Re-deriving an escape sequence for those by
 * hand would be reinventing what a real terminal emulator already does
 * correctly by just forwarding what it read (`RoutableKeyEvent.raw`'s own
 * TSDoc) — this module deliberately narrows itself to the one shape that
 * is actually broken.
 */

import type { RoutableKeyEvent } from "./keyRouting";

/** `0x1b`, the `ESC` byte — prefixed onto the control byte when {@link
 * RoutableKeyEvent.option} (Alt) is also held, matching a legacy terminal's
 * own `ESC` + control-byte encoding for `Alt+Ctrl+<letter>`. */
const ESC = "\x1b";

/**
 * Recompute the legacy pty encoding for `event`, or fall back to its raw
 * bytes unchanged (this module's TSDoc).
 *
 * Only reshapes a plain `Ctrl+<letter>` combo: `event.ctrl` true,
 * `event.meta` false, and `event.name` exactly one ASCII letter (`a`-`z`,
 * case-insensitive — `@opentui/core` reports the bare lowercase letter
 * regardless of Shift, `editor-core/manifest.ts`'s own documented decode).
 * `event.meta` is excluded because a `ctrl+meta+<letter>` combo is not the
 * plain shape a single C0 control byte represents. For that shape, the
 * control byte is the letter's char code with the upper three bits
 * cleared (`code & 0x1f`) — `Ctrl+G` (`code` `0x67` or `0x47`) both mask to
 * `0x07`, the ASCII BEL/`^G` byte a legacy terminal (and the child shell
 * reading its pty) already expects. `event.option` (Alt) held at the same
 * time additionally prefixes {@link ESC}, matching a legacy terminal's own
 * `Alt+Ctrl+<letter>` encoding.
 */
export function encodeKeyEventForPty(event: RoutableKeyEvent): string {
  if (event.ctrl && !event.meta && /^[a-zA-Z]$/.test(event.name)) {
    const controlByte = String.fromCharCode(event.name.charCodeAt(0) & 0x1f);
    return event.option ? ESC + controlByte : controlByte;
  }
  return event.raw ?? event.sequence ?? "";
}
