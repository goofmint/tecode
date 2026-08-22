import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { createBindingTable, type KeymapLayers } from "./bindingTable";
import { CHORD_TIMEOUT_MS, createChordStateMachine, type ChordScheduler } from "./chords";

/** Build a context getter from a plain object, matching the rest of the
 * keymap test suite's table-driven helper (bindingTable.test.ts,
 * when.test.ts). */
function contextOf(values: Record<string, unknown> = {}): (key: string) => unknown {
  return (key) => values[key];
}

/** Build a full {@link KeymapLayers}, defaulting every layer to empty. */
function layersOf(partial: Partial<KeymapLayers>): KeymapLayers {
  return {
    defaults: partial.defaults ?? [],
    fallback: partial.fallback ?? [],
    extension: partial.extension ?? [],
    user: partial.user ?? [],
  };
}

/**
 * A fake {@link ChordScheduler}: `set` records the callback instead of
 * arming a real timer, and exposes `fire()` to run it synchronously plus
 * `clearedHandles` to prove `clear` was actually called (the
 * "timeout cleared on completion" test). Handles are just incrementing
 * numbers — nothing here depends on their real shape, only on `clear`
 * receiving whatever `set` returned.
 */
function createFakeScheduler(): ChordScheduler & {
  fire(): void;
  clearedHandles: unknown[];
  pendingCount(): number;
} {
  let nextHandle = 0;
  const pending = new Map<number, () => void>();
  const clearedHandles: unknown[] = [];

  return {
    set(fn, ms) {
      void ms; // unused: this fake scheduler is driven by fire(), not real delay
      const handle = nextHandle++;
      pending.set(handle, fn);
      return handle;
    },
    clear(handle) {
      clearedHandles.push(handle);
      pending.delete(handle as number);
    },
    fire() {
      // Fire every still-armed timeout, matching a real scheduler where
      // clear() prevents a callback from ever running.
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const cb of callbacks) cb();
    },
    clearedHandles,
    pendingCount() {
      return pending.size;
    },
  };
}

/** Build a table with one real 2-stroke chord binding
 * (`ctrl+k ctrl+s` → `keybindings.open`), optionally gated by a `when`
 * clause on the continuation, plus any extra layer entries a test wants. */
function chordTable(opts: { when?: string; extraUser?: KeymapLayers["user"] } = {}) {
  const binding: KeymapLayers["user"][number] = {
    key: "ctrl+k ctrl+s",
    command: "keybindings.open",
    ...(opts.when !== undefined ? { when: opts.when } : {}),
  };
  return createBindingTable(
    layersOf({ user: [binding, ...(opts.extraUser ?? [])] }),
    { log: createHostLog() },
  );
}

/** Track every `execute` call the machine makes. */
function createExecuteRecorder() {
  const calls: string[] = [];
  return {
    calls,
    execute(id: string) {
      calls.push(id);
    },
  };
}

/** Track every `onDidChangePending` payload in order. */
function trackPending(machine: { onDidChangePending: (l: (v: unknown) => void) => unknown }) {
  const events: unknown[] = [];
  machine.onDidChangePending((v) => events.push(v));
  return events;
}

describe("createChordStateMachine — chord completion", () => {
  test("a completed 2-stroke chord executes its command exactly once and returns to idle", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { calls, execute } = createExecuteRecorder();
    const machine = createChordStateMachine({
      table,
      execute,
      getContext: contextOf(),
      scheduler,
    });

    expect(machine.handleStroke("ctrl+k")).toBe("consumed");
    expect(machine.handleStroke("ctrl+s")).toBe("consumed");

    expect(calls).toEqual(["keybindings.open"]);

    // Back in idle: an unrelated stroke with no binding now passes through.
    expect(machine.handleStroke("x")).toBe("passthrough");
  });

  test("timeout is cleared on completion (scheduler.clear is called)", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { execute } = createExecuteRecorder();
    const machine = createChordStateMachine({
      table,
      execute,
      getContext: contextOf(),
      scheduler,
    });

    machine.handleStroke("ctrl+k");
    expect(scheduler.pendingCount()).toBe(1);

    machine.handleStroke("ctrl+s");
    expect(scheduler.clearedHandles.length).toBe(1);
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("createChordStateMachine — timeout", () => {
  test("an expired pending chord returns to idle, executes nothing, and fires the exit event", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { calls, execute } = createExecuteRecorder();
    const machine = createChordStateMachine({
      table,
      execute,
      getContext: contextOf(),
      scheduler,
    });
    const events = trackPending(machine);

    expect(machine.handleStroke("ctrl+k")).toBe("consumed");
    expect(events).toEqual(["ctrl+k"]);

    scheduler.fire();

    expect(events).toEqual(["ctrl+k", undefined]);
    expect(calls).toEqual([]);

    // Back in idle: the completion stroke of the chord no longer means
    // anything on its own.
    expect(machine.handleStroke("ctrl+s")).toBe("passthrough");
  });
});

describe("createChordStateMachine — Escape cancels", () => {
  test("Escape while pending returns to idle with no side effects, consumed", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { calls, execute } = createExecuteRecorder();
    const machine = createChordStateMachine({
      table,
      execute,
      getContext: contextOf(),
      scheduler,
    });
    const events = trackPending(machine);

    expect(machine.handleStroke("ctrl+k")).toBe("consumed");
    expect(machine.handleStroke("Escape")).toBe("consumed");

    expect(calls).toEqual([]);
    expect(events).toEqual(["ctrl+k", undefined]);
    // The armed timeout was cleared, not left to fire later.
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("createChordStateMachine — prefix-then-miss", () => {
  test("a second stroke that completes nothing is discarded (consumed, not passthrough, no execute)", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { calls, execute } = createExecuteRecorder();
    const machine = createChordStateMachine({
      table,
      execute,
      getContext: contextOf(),
      scheduler,
    });

    expect(machine.handleStroke("ctrl+k")).toBe("consumed");
    expect(machine.handleStroke("x")).toBe("consumed");

    expect(calls).toEqual([]);
    // Back to idle; the stroke was discarded, not replayed against x alone.
    expect(machine.handleStroke("ctrl+s")).toBe("passthrough");
  });
});

describe("createChordStateMachine — single-stroke exact match vs. prefix", () => {
  test("a stroke that is both an exact single-stroke binding AND a chord prefix enters pending", () => {
    const table = chordTable({
      extraUser: [{ key: "ctrl+k", command: "editor.action.deleteLine" }],
    });
    const scheduler = createFakeScheduler();
    const { calls, execute } = createExecuteRecorder();
    const machine = createChordStateMachine({
      table,
      execute,
      getContext: contextOf(),
      scheduler,
    });
    const events = trackPending(machine);

    expect(machine.handleStroke("ctrl+k")).toBe("consumed");

    // Pending wins: the single-stroke binding did NOT fire.
    expect(calls).toEqual([]);
    expect(events).toEqual(["ctrl+k"]);

    // And the chord still completes normally from here.
    expect(machine.handleStroke("ctrl+s")).toBe("consumed");
    expect(calls).toEqual(["keybindings.open"]);
  });
});

describe("createChordStateMachine — when-filtered prefix (real table)", () => {
  test("a chord whose only continuation's when fails does not open pending at all", () => {
    const table = chordTable({ when: "editorTextFocus" });
    const scheduler = createFakeScheduler();
    const { calls, execute } = createExecuteRecorder();
    const machine = createChordStateMachine({
      table,
      execute,
      getContext: contextOf({ editorTextFocus: false }),
      scheduler,
    });
    const events = trackPending(machine);

    // hasSequencePrefix("ctrl+k") is false under this context, so the
    // machine never enters pending — the stroke passes through untouched
    // since ctrl+k alone has no binding either.
    expect(machine.handleStroke("ctrl+k")).toBe("passthrough");
    expect(events).toEqual([]);
    expect(calls).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("the same chord opens pending once the when clause passes", () => {
    const table = chordTable({ when: "editorTextFocus" });
    const scheduler = createFakeScheduler();
    const { calls, execute } = createExecuteRecorder();
    const machine = createChordStateMachine({
      table,
      execute,
      getContext: contextOf({ editorTextFocus: true }),
      scheduler,
    });

    expect(machine.handleStroke("ctrl+k")).toBe("consumed");
    expect(machine.handleStroke("ctrl+s")).toBe("consumed");
    expect(calls).toEqual(["keybindings.open"]);
  });
});

describe("createChordStateMachine — onDidChangePending across all exit paths", () => {
  test("completion: enter then exit(undefined)", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { execute } = createExecuteRecorder();
    const machine = createChordStateMachine({ table, execute, getContext: contextOf(), scheduler });
    const events = trackPending(machine);

    machine.handleStroke("ctrl+k");
    machine.handleStroke("ctrl+s");

    expect(events).toEqual(["ctrl+k", undefined]);
  });

  test("timeout: enter then exit(undefined)", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { execute } = createExecuteRecorder();
    const machine = createChordStateMachine({ table, execute, getContext: contextOf(), scheduler });
    const events = trackPending(machine);

    machine.handleStroke("ctrl+k");
    scheduler.fire();

    expect(events).toEqual(["ctrl+k", undefined]);
  });

  test("escape: enter then exit(undefined)", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { execute } = createExecuteRecorder();
    const machine = createChordStateMachine({ table, execute, getContext: contextOf(), scheduler });
    const events = trackPending(machine);

    machine.handleStroke("ctrl+k");
    machine.handleStroke("escape");

    expect(events).toEqual(["ctrl+k", undefined]);
  });

  test("discard: enter then exit(undefined)", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { execute } = createExecuteRecorder();
    const machine = createChordStateMachine({ table, execute, getContext: contextOf(), scheduler });
    const events = trackPending(machine);

    machine.handleStroke("ctrl+k");
    machine.handleStroke("z");

    expect(events).toEqual(["ctrl+k", undefined]);
  });
});

describe("createChordStateMachine — reset() and dispose()", () => {
  test("reset() while pending cancels and clears the timeout, firing the exit event", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { execute } = createExecuteRecorder();
    const machine = createChordStateMachine({ table, execute, getContext: contextOf(), scheduler });
    const events = trackPending(machine);

    machine.handleStroke("ctrl+k");
    machine.reset();

    expect(events).toEqual(["ctrl+k", undefined]);
    expect(scheduler.pendingCount()).toBe(0);
    // A fresh stroke starts a clean chord again.
    expect(machine.handleStroke("ctrl+k")).toBe("consumed");
  });

  test("reset() while idle is a no-op — no event fires", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { execute } = createExecuteRecorder();
    const machine = createChordStateMachine({ table, execute, getContext: contextOf(), scheduler });
    const events = trackPending(machine);

    machine.reset();
    expect(events).toEqual([]);
  });

  test("dispose() clears the armed timeout and stops delivering events", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { execute } = createExecuteRecorder();
    const machine = createChordStateMachine({ table, execute, getContext: contextOf(), scheduler });
    const events = trackPending(machine);

    machine.handleStroke("ctrl+k");
    machine.dispose();

    expect(scheduler.pendingCount()).toBe(0);
    expect(events).toEqual(["ctrl+k"]); // no trailing exit event after dispose
  });
});

describe("createChordStateMachine — defensive normalization of incoming strokes", () => {
  test("strokes are normalized before table lookup (mixed case, unsorted modifiers)", () => {
    const table = chordTable();
    const scheduler = createFakeScheduler();
    const { calls, execute } = createExecuteRecorder();
    const machine = createChordStateMachine({
      table,
      execute,
      getContext: contextOf(),
      scheduler,
    });

    expect(machine.handleStroke("Ctrl+K")).toBe("consumed");
    expect(machine.handleStroke("CTRL+S")).toBe("consumed");
    expect(calls).toEqual(["keybindings.open"]);
  });
});

test("CHORD_TIMEOUT_MS matches the 3-second requirement (design.md §6.3)", () => {
  expect(CHORD_TIMEOUT_MS).toBe(3000);
});

test("a disposed machine passes strokes through and executes nothing", () => {
  const executed: string[] = [];
  const table = createBindingTable(
    {
      defaults: [{ key: "ctrl+p", command: "quickOpen.show" }],
      fallback: [],
      extension: [],
      user: [],
    },
    { log: createHostLog() },
  );
  const machine = createChordStateMachine({
    table,
    execute: (id) => {
      executed.push(id);
    },
    getContext: () => undefined,
  });

  machine.dispose();

  expect(machine.handleStroke("ctrl+p")).toBe("passthrough");
  expect(executed).toEqual([]);
});

test("a scheduler whose set() throws does not break pending entry", () => {
  const executed: string[] = [];
  const table = createBindingTable(
    {
      defaults: [{ key: "ctrl+k ctrl+s", command: "keybindings.open" }],
      fallback: [],
      extension: [],
      user: [],
    },
    { log: createHostLog() },
  );
  const machine = createChordStateMachine({
    table,
    execute: (id) => {
      executed.push(id);
    },
    getContext: () => undefined,
    scheduler: {
      set() {
        throw new Error("scheduler broken");
      },
      clear() {
        throw new Error("scheduler broken");
      },
    },
  });

  expect(machine.handleStroke("ctrl+k")).toBe("consumed");
  expect(machine.handleStroke("ctrl+s")).toBe("consumed");
  expect(executed).toEqual(["keybindings.open"]);
});
