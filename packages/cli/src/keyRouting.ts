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
}

/** Dependencies for {@link handleKeyEvent} — narrowed to exactly the one
 * method each collaborator needs (matches `chords.ts`'s own
 * `ChordStateMachineDeps.table: Pick<BindingTable, ...>` convention). */
export interface KeyRoutingDeps {
  chordMachine: Pick<ChordStateMachine, "handleStroke">;
  editorInputRouter: Pick<EditorInputRouter, "routeKeyEvent">;
}

/**
 * Route one live key event (design.md §6.1's full pipeline, Task 2.2):
 * convert it to a canonical stroke and offer it to the chord state machine
 * first; if the machine reports `"consumed"` (a binding fired, or a chord
 * was entered/continued/cancelled/discarded), call `event.preventDefault()`
 * and stop — the keystroke must never also reach the editor. Only when the
 * machine reports `"passthrough"` (idle, no binding, no chord prefix) does
 * the raw event go to the editor input router.
 */
export function handleKeyEvent(deps: KeyRoutingDeps, event: RoutableKeyEvent): void {
  const stroke = keyEventToStroke(event);
  const result = deps.chordMachine.handleStroke(stroke);
  if (result === "consumed") {
    event.preventDefault?.();
    return;
  }
  deps.editorInputRouter.routeKeyEvent(event);
}
