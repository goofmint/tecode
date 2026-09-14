/**
 * Adapts an OpenTUI key event into the canonical stroke string the rest of
 * the keymap pipeline consumes (Req 4.4; design.md §6.1: "terminal bytes →
 * OpenTUI key event → chord state machine → binding lookup → when filter →
 * commands.execute").
 *
 * {@link KeyEventLike} is a deliberately minimal *structural* type rather
 * than an import of `@opentui/core`'s `KeyEvent` class (`lib/KeyHandler.ts`)
 * — only five fields are needed here, so a plain test object satisfies it
 * with no dependency on the concrete class, and the real `KeyEvent` (which
 * has exactly these fields, plus more this module doesn't need) satisfies
 * it structurally with zero adapter code at the real call site
 * (`packages/cli`'s `renderShell.tsx`, Task 2.2). This mirrors
 * `ui/focus.tsx`'s `FocusEmitter` — the same "narrow structural slice of an
 * OpenTUI type" pattern already used elsewhere in `core`.
 */

import { normalizeKey } from "./normalize";

/**
 * The slice of `@opentui/core`'s `KeyEvent` (`lib/KeyHandler.ts`) this
 * module needs. Note the real type names its Option/Alt modifier `option`,
 * not `alt` — {@link keyEventToStroke} is what maps it onto this pipeline's
 * canonical `"alt"` modifier token (`normalize.ts`'s `MODIFIER_ORDER`).
 */
export interface KeyEventLike {
  /** OpenTUI's parsed key name (e.g. `"a"`, `"escape"`, `"backspace"`,
   * `"delete"`, `"left"`) — see `@opentui/core`'s `lib/parse.keypress.ts`. */
  name: string;
  ctrl: boolean;
  shift: boolean;
  /** OpenTUI's Option/Alt modifier flag. */
  option: boolean;
  meta: boolean;
  /** The literal character(s) this keystroke produced, if any (e.g. `"a"`,
   * `"A"`, `" "`, `"😀"`) — unused by stroke normalization itself, but
   * carried here so a single `KeyEventLike` value is enough for both the
   * keymap pipeline (this module) and the editor input router
   * (`editor/inputRouter.ts`, Task 2.2) to each read what they need from
   * the same event. */
  sequence: string;
}

/**
 * The Space key's canonical name in this pipeline (`"space"`), and the
 * literal character `@opentui/core`'s Kitty-protocol branch reports for it
 * in `name` instead (Issue #163).
 *
 * Space is the one key whose parsed `name` is NOT stable across the two
 * parsing paths of `@opentui/core@0.1.107`'s `parseKeypress` — verified by
 * running the vendored parser against real byte sequences (the same
 * methodology `builtin/editor-core/manifest.ts`'s TSDoc documents), with
 * `keyEventToStroke` applied to each result:
 *
 * - legacy Ctrl+Space (the raw NUL byte `0x00`), under
 *   `useKittyKeyboard: false` AND `true` → `{ name: "space", ctrl: true }`
 *   → `"ctrl+space"`.
 * - Kitty's Ctrl+Space (`CSI 32;5u`), `useKittyKeyboard: true` →
 *   `{ name: " ", ctrl: true }` → **`"ctrl++"`** before this mapping.
 * - Kitty's plain Space (`CSI 32u`) → `{ name: " " }` → **`""`** before
 *   this mapping.
 *
 * Both of those wrong answers come from {@link normalizeKey}'s documented
 * (and correct) reading of a trailing `"+"` as naming the literal `+` KEY:
 * `"ctrl+ "` collapses to `"ctrl++"` — which is also the genuine stroke
 * for Ctrl+Plus (`CSI 43;5u`, verified) — and a bare `" "` normalizes to
 * `""`. Mapping the name here, before the raw string is assembled, is
 * therefore the only place the fix belongs: `normalize.ts` must keep
 * treating `"ctrl++"` as Ctrl+Plus, since a hand-written
 * `keybindings.json` entry may legitimately say exactly that.
 */
const SPACE_KEY_NAME = "space";
const LITERAL_SPACE_NAME = " ";

/**
 * Turn `event` into the canonical stroke string
 * {@link normalizeKey}/`BindingTable.lookup`/`ChordStateMachine.handleStroke`
 * expect (Req 4.1-4.4, design.md §6.1, §6.2): assemble a raw
 * `ctrl+shift+alt+meta+name`-shaped string from whichever modifiers are set
 * (skipping absent ones, exactly like a hand-written `keybindings.json`
 * entry would), then run it through {@link normalizeKey} so the result is
 * already in the table's canonical form — order-insensitive modifiers,
 * lowercase key, aliases resolved.
 *
 * A bare key with no modifiers held (e.g. a plain letter while typing)
 * passes through as just `event.name`, normalized.
 *
 * The one name rewritten on the way in is a literal space (Issue #163) —
 * see {@link SPACE_KEY_NAME}'s TSDoc for the measured parser behavior that
 * makes it necessary.
 */
export function keyEventToStroke(event: KeyEventLike): string {
  const name = event.name === LITERAL_SPACE_NAME ? SPACE_KEY_NAME : event.name;
  const modifiers: string[] = [];
  if (event.ctrl) modifiers.push("ctrl");
  if (event.shift) modifiers.push("shift");
  if (event.option) modifiers.push("alt");
  if (event.meta) modifiers.push("meta");
  const raw = modifiers.length > 0 ? `${modifiers.join("+")}+${name}` : name;
  return normalizeKey(raw);
}
