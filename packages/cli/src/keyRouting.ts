/**
 * The real key-input pipeline's terminal seam (Task 2.2, design.md §6.1):
 * `terminal bytes → OpenTUI key event → chord state machine → binding
 * lookup → when filter → commands.execute`, with the `no match →
 * focused component` branch routed to the editor input router
 * (`@tecode/core`'s `createEditorInputRouter`, `editor/inputRouter.ts`).
 *
 * Pulled out of `renderShell.tsx`'s `renderShellToTerminal` into this
 * standalone, dependency-injected function specifically so it can be
 * exercised directly in tests (`keyRouting.test.ts`) without a real TTY or
 * `@opentui/core`'s `CliRenderer` — `renderShellToTerminal` only wires
 * `renderer.keyInput.on("keypress", (key) => handleKeyEvent(deps, key))`
 * once real key events actually exist.
 */

import { keyEventToStroke, type ChordStateMachine, type EditorInputRouter, type KeyEventLike } from "@tecode/core";

/** A real OpenTUI `KeyEvent` (`@opentui/core`'s `lib/KeyHandler.ts`) also
 * has `preventDefault()`/`stopPropagation()`, which
 * `keymap/keyEvent.ts`'s `KeyEventLike` deliberately omits (it only needs
 * the fields stroke-normalization reads) — this is the fuller shape
 * {@link handleKeyEvent} actually receives from a live renderer. */
export interface RoutableKeyEvent extends KeyEventLike {
  /** Marks the keystroke as consumed so nothing else (OpenTUI's own
   * default key handling) also acts on it. Optional here purely so a test
   * can pass a bare `KeyEventLike` without stubbing it out. */
  preventDefault?: () => void;
  /** The literal raw terminal bytes `@opentui/core`'s `KeyHandler`/
   * `parseKeypress` decoded this keystroke from (its `KeyEvent.raw`,
   * `lib/parse.keypress.d.ts`) — forwarded VERBATIM to the pty when the
   * terminal panel has focus (Issue #98 Phase 3, {@link
   * TerminalKeyRoutingDeps.write}). Replaying the exact bytes the real
   * terminal received is the only way to reproduce arrow keys/Ctrl
   * chords/etc. inside the child process without this module re-deriving
   * an escape sequence from `name`/modifiers by hand — a real terminal
   * emulator never does that either, it just forwards what it read.
   * Optional purely so a test can pass a bare `KeyEventLike` without it;
   * production wiring (`renderShell.tsx`) always hands `handleKeyEvent` a
   * real OpenTUI `KeyEvent`, which always has this field. */
  raw?: string;
}

/**
 * The one reserved escape stroke (Issue #98 Phase 3) that moves focus OUT
 * of the terminal panel and back to the editor — checked BEFORE any other
 * terminal-focused key is forwarded to the pty, and can therefore never be
 * intercepted by (or forwarded into) the child process. Without this, a
 * full-screen program that consumes Ctrl+C/Escape/Tab/arrows itself
 * (Claude Code, among others — this issue's own driving case) would leave
 * the terminal panel permanently unreachable once focused: every key the
 * user could press to try to leave goes straight to the child instead.
 *
 * **Why `ctrl+o`, specifically** (`editor-core/manifest.ts`'s own TSDoc:
 * "Plain `ctrl+letter` combos... decode identically and unambiguously in
 * every mode" — unlike `ctrl+shift+<letter>`, which needs the Kitty
 * keyboard protocol to disambiguate from the bare `ctrl+<letter>` on a
 * non-Kitty terminal, this key must work identically everywhere with no
 * protocol dependency at all, so the choice is confined to plain
 * `ctrl+<letter>` combos from the start). Already spoken for, checked
 * across every manifest AND the base fallback layer (not just
 * `packages/builtin`): `ctrl+c` (quit, intercepted by OpenTUI itself,
 * `editor-core/manifest.ts`), `ctrl+d` (multi-cursor), `ctrl+e`
 * (`explorer.focus`, `keymap/keybindings.fallback.json` — a DEFAULT
 * binding, not merely a builtin one), `ctrl+f` (find), `ctrl+g`
 * (`workbench.action.showCommands`, same fallback layer), `ctrl+k` (chord
 * prefix), `ctrl+l` (`editor.action.deleteLine`, same fallback layer),
 * `ctrl+p` (quick open), `ctrl+s`/`ctrl+q` (also excluded regardless of
 * whether either is bound — both are the terminal's own XON/XOFF flow
 * control bytes, which a real terminal emulator can swallow before an
 * application ever sees them, making either an unreliable choice for an
 * application-level shortcut), `ctrl+v`/`ctrl+x` (paste/cut), `ctrl+w`
 * (tab close), `ctrl+y`/`ctrl+z` (redo/undo). Of what remains, `ctrl+o` is
 * `readline`'s `operate-and-get-next` — real, but by a wide margin the
 * least-reached-for `readline` default of the ones left (unlike
 * `ctrl+a`/`ctrl+e`/`ctrl+r`/`ctrl+u`/`ctrl+w`/`ctrl+n`/`ctrl+b`, every one
 * of which is a command a shell user reaches for constantly while editing
 * a command line).
 *
 * **The trade-off, stated plainly**: choosing ANY key here permanently
 * removes it from the child process's own input space while the terminal
 * has focus — there is no way to both reserve an escape hatch and forward
 * 100% of the child's input. A user who genuinely needs `ctrl+o` inside
 * the child process (an editor running inside the embedded terminal that
 * itself binds `ctrl+o`, say) cannot send it through this integrated
 * terminal. This cost is accepted deliberately: the alternative (Ctrl+C,
 * as this constant's own TSDoc opens with) is a terminal a user can enter
 * but never leave, which is strictly worse.
 */
export const TERMINAL_ESCAPE_STROKE = "ctrl+o";

/**
 * Dependencies for routing keys to the integrated terminal (Issue #98
 * Phase 3) — supplied to {@link KeyRoutingDeps.terminal} only once a real
 * pty/panel exist (`main.ts`'s composition root); a caller/test that omits
 * this entirely gets the pre-#98 behavior unchanged (this module's own
 * "wired only when given" convention, matching `renderShell.tsx`'s
 * `ShellRenderDeps.onPaste`).
 */
export interface TerminalKeyRoutingDeps {
  /** Whether the terminal panel currently holds real focus — reads the
   * `"terminalFocus"` context key (`ui/focus.tsx`'s `useFocusTracking`,
   * set by the terminal built-in's own view). A plain function, not a
   * captured boolean, so this always reflects focus at the moment each
   * keystroke arrives, not whatever it happened to be when `deps` was
   * built. */
  isFocused: () => boolean;
  /** Forward one keystroke's raw bytes (`RoutableKeyEvent.raw`) into the
   * active pty session (`PtySession.write`, already documented
   * never-throwing). A no-op with nowhere to route to (no session
   * spawned/already exited) is this function's own concern, not this
   * module's — `handleKeyEvent` calls it unconditionally whenever {@link
   * isFocused} is true and the stroke is not {@link TERMINAL_ESCAPE_STROKE}. */
  write: (data: string) => void;
  /** Run exactly when {@link TERMINAL_ESCAPE_STROKE} arrives while {@link
   * isFocused} is true — must synchronously move real focus away from the
   * terminal panel and back to the editor (`ui/shell.tsx`'s `EditorArea`'s
   * published focus handle, `onEditorFocusHandleChange`, is `main.ts`'s
   * real wiring for this). Never called for any other stroke, and never
   * called while {@link isFocused} is false. */
  escape: () => void;
}

/** Dependencies for {@link handleKeyEvent} — narrowed to exactly the one
 * method each collaborator needs (matches `chords.ts`'s own
 * `ChordStateMachineDeps.table: Pick<BindingTable, ...>` convention). */
export interface KeyRoutingDeps {
  chordMachine: Pick<ChordStateMachine, "handleStroke">;
  editorInputRouter: Pick<EditorInputRouter, "routeKeyEvent">;
  /** Terminal-forwarding collaborator (Issue #98 Phase 3) — see {@link
   * TerminalKeyRoutingDeps}'s TSDoc for when this is supplied. */
  terminal?: TerminalKeyRoutingDeps;
}

/**
 * Route one live key event (design.md §6.1's full pipeline, Task 2.2;
 * extended by Issue #98 Phase 3 for the integrated terminal).
 *
 * **The terminal-focus branch runs FIRST, before the chord machine even
 * sees the stroke** (`deps.terminal?.isFocused()`) — this is deliberate
 * and load-bearing, not an ordering accident: while the terminal panel has
 * focus, ordinary tecode keybindings (quit, the command palette, save,
 * ...) must NOT fire out from under a full-screen program running inside
 * it, since the whole point of an integrated terminal is that keys the
 * child process itself wants (Ctrl+arrows, Ctrl+D to exit a shell, ...)
 * reach it exactly as if it were the real, outermost terminal. Exactly one
 * exception is checked first, inside this same branch, before anything is
 * ever written to the pty: {@link TERMINAL_ESCAPE_STROKE}, which calls
 * {@link TerminalKeyRoutingDeps.escape} instead and returns — see that
 * constant's own TSDoc for why this specific ordering (checked before the
 * forward-to-pty branch, never reachable by the child) is the one thing
 * this function guarantees above everything else. Every other
 * terminal-focused stroke is forwarded via {@link
 * TerminalKeyRoutingDeps.write} using the event's raw bytes (`event.raw`
 * — `RoutableKeyEvent`'s own TSDoc on why raw bytes, not a re-derived
 * escape sequence). Either way, `event.preventDefault()` is called and
 * this function returns — the chord machine and editor input router never
 * run at all while the terminal has focus.
 *
 * **When the terminal does not have focus** (`deps.terminal` omitted
 * entirely, or `isFocused()` false): unchanged from before this issue —
 * convert the stroke to canonical form and offer it to the chord state
 * machine first; if the machine reports `"consumed"` (a binding fired, or
 * a chord was entered/continued/cancelled/discarded), call `event.
 * preventDefault()` and stop — the keystroke must never also reach the
 * editor. Only when the machine reports `"passthrough"` (idle, no
 * binding, no chord prefix) does the raw event go to the editor input
 * router.
 */
export function handleKeyEvent(deps: KeyRoutingDeps, event: RoutableKeyEvent): void {
  const stroke = keyEventToStroke(event);

  if (deps.terminal?.isFocused()) {
    if (stroke === TERMINAL_ESCAPE_STROKE) {
      deps.terminal.escape();
    } else {
      deps.terminal.write(event.raw ?? event.sequence ?? "");
    }
    event.preventDefault?.();
    return;
  }

  const result = deps.chordMachine.handleStroke(stroke);
  if (result === "consumed") {
    event.preventDefault?.();
    return;
  }
  deps.editorInputRouter.routeKeyEvent(event);
}

/** Dependencies for {@link handlePasteEvent} — narrowed to the one method
 * it needs (matches {@link KeyRoutingDeps}'s own `Pick<...>` convention). */
export interface PasteRoutingDeps {
  editorInputRouter: Pick<EditorInputRouter, "insertText">;
}

/**
 * Route one decoded bracketed-paste string (Issue #91, design.md §6.1's
 * pipeline extended to terminal paste input): straight to {@link
 * EditorInputRouter.insertText}, with no chord-machine step at all —
 * unlike {@link handleKeyEvent}'s ordinary keystrokes, a paste never has a
 * keybinding to match against; it always means "insert this text" at
 * whatever the current selections are. `renderShell.tsx`'s
 * `renderShellToTerminal` calls this from its `renderer.keyInput.on(
 * "paste", ...)` listener, already having decoded `PasteEvent.bytes` (a
 * `Uint8Array`) to a UTF-8 string (`ShellRenderDeps.onPaste`'s TSDoc) —
 * this function itself never touches raw bytes, matching {@link
 * handleKeyEvent}'s own "pulled out for direct, `@opentui/core`-free
 * testability" shape (this module's TSDoc).
 */
export function handlePasteEvent(deps: PasteRoutingDeps, text: string): void {
  deps.editorInputRouter.insertText(text);
}
