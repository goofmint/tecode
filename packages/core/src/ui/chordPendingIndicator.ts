/**
 * `createChordPendingIndicator` (Task 3.4, Req 4.4, design.md §6.3/§13):
 * "status bar shows e.g. `(ctrl+k)`" while a two-stroke chord is pending —
 * wired directly against the live {@link ChordStateMachine}/{@link
 * SlotRegistry} at the composition root, core-internal (this is NOT part of
 * the `statusbar` builtin's `activate()` — a plain extension has no access
 * to `ChordStateMachine`, which lives in `@tecode/core`, never crossing the
 * extension/api boundary).
 *
 * A componentless `statusBar.item` registration, following
 * `windowMessageService.ts`'s and `hostErrorSink.ts`'s exact
 * dispose-then-re-register update mechanics: `chordMachine.
 * onDidChangePending` fires with the canonical prefix string on entering
 * pending (and on every re-transition while staying pending — a longer
 * sequence's prefix growing), and `undefined` on every exit back to idle —
 * this module disposes whatever registration is currently showing and
 * registers a fresh one (or none) each time, rather than trying to mutate
 * an existing entry in place (`slotRegistry.ts`'s `registerView` has no
 * in-place update — see `windowMessageService.ts`'s TSDoc for why
 * dispose-then-re-register, not a raw re-`registerView` call, is this
 * codebase's chosen update mechanics: a raw re-registration under the same
 * id logs a spurious "View re-registered" warning against the
 * PREVIOUS — not lazy — entry every single time, since `chordMachine.
 * onDidChangePending` can fire on every keystroke while a chord is open).
 */

import type { Disposable } from "@tecode/api";
import type { ChordStateMachine } from "../keymap/chords";
import type { SlotRegistry } from "./slotRegistry";

/** The well-known `statusBar.item` id this indicator registers under
 * (namespaced like every other core-owned id — `theme.select`,
 * `tecode.window.message`, `tecode.host.error`). */
export const CHORD_PENDING_STATUS_BAR_ITEM_ID = "tecode.keymap.chordPending";

/** Renders on the left, below `tecode.host.error` (2,000,000) and
 * `tecode.window.message` (1,000,000) — a pending chord is useful context,
 * not urgent feedback — but above any ordinary extension-registered
 * left-side item (the `statusbar` builtin's own items top out at 30). */
export const CHORD_PENDING_STATUS_BAR_PRIORITY = 500_000;

/** Dependencies for {@link createChordPendingIndicator}. */
export interface ChordPendingIndicatorDeps {
  /** The live chord state machine to reflect (this module's TSDoc) —
   * narrowed to the one event this indicator needs. */
  chordMachine: Pick<ChordStateMachine, "onDidChangePending">;
  /** The live slot registry the rendered Shell's `StatusBar` reads from —
   * narrowed to `registerView`. */
  slotRegistry: Pick<SlotRegistry, "registerView">;
}

/**
 * Wire the chord-pending indicator (Task 3.4, Req 4.4). Returns a
 * {@link Disposable} that unsubscribes from `chordMachine` and clears
 * whatever `statusBar.item` registration is currently showing — idempotent,
 * matching every other `dispose()` in this codebase.
 */
export function createChordPendingIndicator(deps: ChordPendingIndicatorDeps): Disposable {
  const { chordMachine, slotRegistry } = deps;

  let currentItem: Disposable | undefined;

  function clearItem(): void {
    currentItem?.dispose();
    currentItem = undefined;
  }

  const pendingSub = chordMachine.onDidChangePending((prefix) => {
    clearItem();
    if (prefix === undefined) return;
    currentItem = slotRegistry.registerView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID, undefined, {
      title: `(${prefix})`,
      statusBar: { side: "left", priority: CHORD_PENDING_STATUS_BAR_PRIORITY },
    });
  });

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingSub.dispose();
      clearItem();
    },
  };
}
