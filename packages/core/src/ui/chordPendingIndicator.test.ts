/**
 * `createChordPendingIndicator` tests (Task 3.4, Req 4.4,
 * `chordPendingIndicator.ts`'s TSDoc): a real {@link ChordStateMachine}
 * (`keymap/chords.ts`) driving a real {@link SlotRegistry} — entering
 * pending registers `(prefix)`, completing/discarding/timing-out/
 * cancelling clears it, and `dispose()` unsubscribes and clears whatever is
 * currently showing.
 */

import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { createBindingTable, type KeymapLayers } from "../keymap/bindingTable";
import { CHORD_TIMEOUT_MS, createChordStateMachine, type ChordScheduler } from "../keymap/chords";
import { createSlotRegistry } from "./slotRegistry";
import {
  CHORD_PENDING_STATUS_BAR_ITEM_ID,
  CHORD_PENDING_STATUS_BAR_PRIORITY,
  createChordPendingIndicator,
} from "./chordPendingIndicator";

function layersOf(partial: Partial<KeymapLayers>): KeymapLayers {
  return {
    defaults: partial.defaults ?? [],
    fallback: partial.fallback ?? [],
    extension: partial.extension ?? [],
    user: partial.user ?? [],
  };
}

/** One real 2-stroke chord binding (`ctrl+k ctrl+s` -> `keybindings.open`),
 * matching `keymap/chords.test.ts`'s own `chordTable` fixture. */
function chordTable() {
  return createBindingTable(
    layersOf({ user: [{ key: "ctrl+k ctrl+s", command: "keybindings.open" }] }),
    { log: createHostLog() },
  );
}

/** A fake scheduler (matches `keymap/chords.test.ts`'s own) — `fire()` runs
 * every still-armed timeout synchronously, so the 3-second real timeout
 * never has to elapse in a test. */
function createFakeScheduler(): ChordScheduler & { fire(): void } {
  let nextHandle = 0;
  const pending = new Map<number, () => void>();
  return {
    set(fn) {
      const handle = nextHandle++;
      pending.set(handle, fn);
      return handle;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
    fire() {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const cb of callbacks) cb();
    },
  };
}

describe("createChordPendingIndicator", () => {
  test("entering pending registers a left-side statusBar.item showing '(prefix)'", () => {
    const slotRegistry = createSlotRegistry();
    const scheduler = createFakeScheduler();
    const chordMachine = createChordStateMachine({
      table: chordTable(),
      execute: () => {},
      getContext: () => undefined,
      scheduler,
    });
    createChordPendingIndicator({ chordMachine, slotRegistry });

    expect(slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID)).toBeUndefined();

    chordMachine.handleStroke("ctrl+k");

    const entry = slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID);
    expect(entry?.title).toBe("(ctrl+k)");
    expect(entry?.component).toBeUndefined();
    expect(entry?.statusBar).toEqual({ side: "left", priority: CHORD_PENDING_STATUS_BAR_PRIORITY });
  });

  test("completing the chord clears the indicator", () => {
    const slotRegistry = createSlotRegistry();
    const executed: string[] = [];
    const chordMachine = createChordStateMachine({
      table: chordTable(),
      execute: (id) => {
        executed.push(id);
      },
      getContext: () => undefined,
      scheduler: createFakeScheduler(),
    });
    createChordPendingIndicator({ chordMachine, slotRegistry });

    chordMachine.handleStroke("ctrl+k");
    expect(slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID)).toBeDefined();

    chordMachine.handleStroke("ctrl+s");
    expect(executed).toEqual(["keybindings.open"]);
    expect(slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID)).toBeUndefined();
  });

  test("Escape cancels a pending chord and clears the indicator", () => {
    const slotRegistry = createSlotRegistry();
    const chordMachine = createChordStateMachine({
      table: chordTable(),
      execute: () => {},
      getContext: () => undefined,
      scheduler: createFakeScheduler(),
    });
    createChordPendingIndicator({ chordMachine, slotRegistry });

    chordMachine.handleStroke("ctrl+k");
    chordMachine.handleStroke("escape");
    expect(slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID)).toBeUndefined();
  });

  test("a failed continuation is discarded and clears the indicator (no replay)", () => {
    const slotRegistry = createSlotRegistry();
    const chordMachine = createChordStateMachine({
      table: chordTable(),
      execute: () => {},
      getContext: () => undefined,
      scheduler: createFakeScheduler(),
    });
    createChordPendingIndicator({ chordMachine, slotRegistry });

    chordMachine.handleStroke("ctrl+k");
    chordMachine.handleStroke("x"); // no such continuation
    expect(slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID)).toBeUndefined();
  });

  test("the 3-second timeout clears the indicator", () => {
    const slotRegistry = createSlotRegistry();
    const scheduler = createFakeScheduler();
    const chordMachine = createChordStateMachine({
      table: chordTable(),
      execute: () => {},
      getContext: () => undefined,
      scheduler,
    });
    createChordPendingIndicator({ chordMachine, slotRegistry });

    chordMachine.handleStroke("ctrl+k");
    expect(slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID)).toBeDefined();

    scheduler.fire();
    expect(slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID)).toBeUndefined();
    void CHORD_TIMEOUT_MS; // documents which timeout this fake scheduler stands in for
  });

  test("dispose() unsubscribes and clears whatever is currently showing, idempotently", () => {
    const slotRegistry = createSlotRegistry();
    const chordMachine = createChordStateMachine({
      table: chordTable(),
      execute: () => {},
      getContext: () => undefined,
      scheduler: createFakeScheduler(),
    });
    const indicator = createChordPendingIndicator({ chordMachine, slotRegistry });

    chordMachine.handleStroke("ctrl+k");
    expect(slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID)).toBeDefined();

    indicator.dispose();
    expect(slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID)).toBeUndefined();
    expect(() => indicator.dispose()).not.toThrow();

    // Disposed: further pending changes on the (still-live) machine must not
    // resurrect the indicator.
    chordMachine.reset();
    chordMachine.handleStroke("ctrl+k");
    expect(slotRegistry.getView("statusBar.item", CHORD_PENDING_STATUS_BAR_ITEM_ID)).toBeUndefined();
  });
});
