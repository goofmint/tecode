/**
 * The two-stroke chord state machine (Req 4.4, design.md §6.3: "When a
 * stroke matches only prefixes, the service enters *pending* state (status
 * bar shows e.g. `(ctrl+k)`), with a 3-second timeout and Escape to
 * cancel. A stroke that completes no sequence in pending state is
 * discarded (VS Code behavior), not replayed.").
 *
 * This sits directly on top of {@link BindingTable}'s two sequence queries
 * (`lookup`, `hasSequencePrefix`) rather than re-compiling or re-indexing
 * bindings itself — the table already keys multi-stroke bindings by their
 * space-joined canonical strokes, so a chord machine's whole job is
 * bookkeeping *which* stroke run has been typed so far and asking the
 * table what it means.
 *
 * **@opentui/keymap decision (Req 4.4, adaptation note):** the requirement
 * names `@opentui/keymap`'s sequence engine, so it was installed into
 * `packages/core` and inspected (Task 1.6). Its published API
 * (`Keymap`/`KeymapHost`, `createOpenTuiKeymap(renderer)`, layered
 * target/focus-scoped bindings, its own binding-language parsers and
 * command catalog) is a complete, renderer-coupled keymap runtime that
 * wants to own binding resolution, focus routing, and dispatch end to end
 * against a `CliRenderer` — not a standalone sequence primitive that could
 * sit *underneath* this project's own compiled {@link BindingTable} (Req
 * 4.1-4.3, design.md §6.2) and its `when`-clause evaluator (design.md
 * §6.4). Adopting it here would mean replacing the binding table's
 * declarative-layers model with its own, before the renderer even exists.
 * The dependency was therefore removed again after inspection (never
 * added to `@tecode/api`, per house layering rules), and the sequence
 * bookkeeping below is implemented directly — it is small, as anticipated.
 * The actual OpenTUI integration point (wiring a `CliRenderer`'s key
 * events into {@link ChordStateMachine.handleStroke}) lands with the UI
 * shell task, where an adapter can still choose to lean on
 * `@opentui/keymap`'s OpenTUI-specific input normalization if that proves
 * useful without requiring its binding/dispatch model.
 */

import type { Disposable, Event, Listener } from "@tecode/api";
import type { HostLog } from "../host/errors";
import type { BindingTable } from "./bindingTable";
import { normalizeKey } from "./normalize";
import type { WhenContextGetter } from "./when";

/** The chord timeout (design.md §6.3: "a 3-second timeout"), in
 * milliseconds. Exported so callers (tests, the status bar indicator) can
 * reference the same constant rather than hard-coding `3000` again. */
export const CHORD_TIMEOUT_MS = 3000;

/**
 * The subset of `setTimeout`/`clearTimeout` the chord state machine needs,
 * injected so tests can supply a fake clock instead of waiting on real
 * 3-second timers. `handle` is opaque — whatever `set` returns is passed
 * back to `clear` unchanged.
 */
export interface ChordScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** The default {@link ChordScheduler}, backed by the global
 * `setTimeout`/`clearTimeout`. */
function createDefaultScheduler(): ChordScheduler {
  return {
    set(fn, ms) {
      return setTimeout(fn, ms);
    },
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

/** Dependencies {@link createChordStateMachine} reports through rather
 * than owning directly (design.md §5, §14's pattern of injected `log`,
 * applied here to the chord machine). */
export interface ChordStateMachineDeps {
  /** The compiled binding table (or just these two methods off of one) to
   * query on every stroke — {@link BindingTable.lookup} for exact
   * (sequence-complete) matches, {@link BindingTable.hasSequencePrefix}
   * for "should this stroke open a pending chord". */
  table: Pick<BindingTable, "lookup" | "hasSequencePrefix">;
  /** Fire-and-forget command execution — typically `commands.execute`
   * (Req 3.1), which already never throws (design.md §5); this machine
   * guards the call anyway per house style rather than trusting that
   * contract blindly. */
  execute: (commandId: string) => void | Promise<unknown>;
  /** Reads the live `when`-clause context (Req 4.6, design.md §6.4). */
  getContext: WhenContextGetter;
  /** Defaults to the global `setTimeout`/`clearTimeout`. */
  scheduler?: ChordScheduler;
  /** Structured log for discard/timeout observability. Optional — a
   * machine built without one simply doesn't log. */
  log?: HostLog;
}

/** The chord state machine's public shape. */
export interface ChordStateMachine {
  /**
   * Feed one already-parsed key stroke through the machine (design.md
   * §6.1: "chord state machine → binding lookup → when filter →
   * commands.execute"). `stroke` is expected to already be in
   * {@link normalizeKey}'s canonical form (the input pipeline normalizes
   * live key events before calling this) but is normalized again here
   * defensively, matching {@link BindingTable.lookup}'s documented
   * contract of trusting pre-normalized input from a careful caller while
   * this call site chooses not to assume it.
   *
   * Returns `"consumed"` when the stroke was absorbed by the chord
   * machine (it completed or extended a chord, was discarded as a failed
   * chord continuation, or cancelled a pending chord via Escape) — the
   * caller must not let it fall through to the focused component.
   * Returns `"passthrough"` only when the machine was idle and the stroke
   * matched no binding and no chord prefix at all.
   */
  handleStroke(stroke: string): "consumed" | "passthrough";
  /**
   * Fires whenever pending state changes: on entering pending, with the
   * canonical prefix typed so far (e.g. `"ctrl+k"`); on every exit back to
   * idle — sequence completion, timeout, Escape cancellation, or a failed
   * continuation being discarded — with `undefined`. Display formatting
   * (e.g. the status bar's `(ctrl+k)` indicator, design.md §6.3) is
   * entirely the subscriber's job; this event carries only the canonical
   * prefix string.
   */
  onDidChangePending: Event<string | undefined>;
  /** Cancel any pending chord and return to idle, clearing the armed
   * timeout, without executing anything. A no-op (fires no event) when
   * already idle. */
  reset(): void;
  /** Clear all `onDidChangePending` listeners and any armed timeout. Does
   * not fire a final change event — there is nothing left listening. After
   * dispose, {@link handleStroke} always returns `"passthrough"` without
   * touching the table or executing anything, and {@link reset} is a
   * no-op. */
  dispose(): void;
}

/** Render a caught `unknown` value as a message string, matching the
 * `describeError` helper duplicated across the command registry and
 * binding table (design.md §5, §14). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Canonical form of the Escape key, as {@link normalizeKey} would produce
 * it — the only stroke that cancels a pending chord (design.md §6.3). */
const ESCAPE = "escape";

type InternalState =
  | { kind: "idle" }
  | { kind: "pending"; prefix: string; timeoutHandle: unknown };

/**
 * Build a two-stroke (and, incidentally, N-stroke — see below) chord state
 * machine (Req 4.4, design.md §6.3).
 *
 * The MVP requirement is a 2-stroke maximum, but the transition rules fall
 * out naturally from {@link BindingTable.hasSequencePrefix} without any
 * stroke-count special-casing: entering pending re-checks
 * `hasSequencePrefix` on the *combined* sequence, so a table that happened
 * to contain a 3+ stroke binding would keep the machine pending through
 * additional strokes rather than misbehaving. Nothing here assumes "at
 * most one more stroke".
 */
export function createChordStateMachine(deps: ChordStateMachineDeps): ChordStateMachine {
  const { table, execute, getContext } = deps;
  const scheduler = deps.scheduler ?? createDefaultScheduler();
  const log = deps.log;

  let state: InternalState = { kind: "idle" };
  let machineDisposed = false;
  // Guards stale timeout callbacks: clearArmedTimeout swallows a throwing
  // scheduler.clear, so a callback the scheduler failed to cancel could
  // otherwise still fire after its pending state already ended. Every state
  // transition bumps the generation; a timeout callback armed under an
  // older generation returns without acting.
  let generation = 0;
  const listeners = new Set<Listener<string | undefined>>();

  function logSafely(level: "error" | "warning", message: string): void {
    if (!log) return;
    try {
      log.append(level, { message });
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go
      // (same rationale as the binding table's logSafely).
    }
  }

  function fireChange(pending: string | undefined): void {
    // Snapshot before iterating: a listener that disposes itself (or
    // another listener) mid-dispatch must not perturb this loop, matching
    // the context service's onDidChange dispatch.
    for (const listener of Array.from(listeners)) {
      try {
        listener(pending);
      } catch {
        // Isolate listener failures — one throwing listener must not stop
        // the remaining listeners or propagate out of handleStroke.
      }
    }
  }

  /** Guarded, fire-and-forget command execution (Req 3.4/3.5's
   * never-throwing contract, respected defensively rather than trusted
   * blindly — house style per registry.ts/bindingTable.ts). */
  function executeSafely(commandId: string): void {
    try {
      const result = execute(commandId);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch((cause: unknown) => {
          logSafely(
            "error",
            `Chord command "${commandId}" rejected: ${describeError(cause)}`,
          );
        });
      }
    } catch (cause) {
      logSafely("error", `Chord command "${commandId}" threw: ${describeError(cause)}`);
    }
  }

  /** Clear whatever timeout is armed for the current pending state, if
   * any. Every path back to idle (and every re-arm while staying pending)
   * routes through this first, so a timeout can never fire after its
   * pending state has already ended. */
  function clearArmedTimeout(): void {
    if (state.kind !== "pending") return;
    try {
      scheduler.clear(state.timeoutHandle);
    } catch {
      // A misbehaving injected scheduler must not break the state
      // machine's own transition guarantees.
    }
  }

  /** Transition to idle, clearing any armed timeout, and fire the exit
   * event — the single choke point every "back to idle" path uses. */
  function goIdle(): void {
    clearArmedTimeout();
    generation += 1;
    state = { kind: "idle" };
    fireChange(undefined);
  }

  /** Transition to (or re-transition within) pending for `prefix`,
   * clearing any previously armed timeout and arming a fresh one. */
  function goPending(prefix: string): void {
    clearArmedTimeout();
    generation += 1;
    const armedGeneration = generation;
    let timeoutHandle: unknown;
    try {
      timeoutHandle = scheduler.set(() => {
        // Stale-callback guard: if any transition happened since this
        // timeout was armed (clearArmedTimeout may have failed to cancel it
        // when scheduler.clear threw), this callback must do nothing.
        if (armedGeneration !== generation) return;
        logSafely("warning", `Chord sequence timed out: ${prefix}`);
        goIdle();
      }, CHORD_TIMEOUT_MS);
    } catch (cause) {
      // A throwing injected scheduler must not break stroke handling —
      // pending still works, it just won't auto-expire (Escape and the
      // next stroke still resolve it).
      logSafely(
        "warning",
        `Chord timeout could not be armed: ${describeError(cause)}`,
      );
      timeoutHandle = undefined;
    }
    state = { kind: "pending", prefix, timeoutHandle };
    fireChange(prefix);
  }

  function handleIdleStroke(stroke: string): "consumed" | "passthrough" {
    // Prefix wins over a simultaneous single-stroke exact match
    // (design.md §6.3) — checked first, unconditionally.
    if (table.hasSequencePrefix(stroke, getContext)) {
      goPending(stroke);
      return "consumed";
    }

    const resolved = table.lookup(stroke, getContext);
    if (resolved) {
      executeSafely(resolved.command);
      return "consumed";
    }

    return "passthrough";
  }

  function handlePendingStroke(stroke: string, prefix: string): "consumed" | "passthrough" {
    if (stroke === ESCAPE) {
      goIdle();
      return "consumed";
    }

    const combined = `${prefix} ${stroke}`;

    const resolved = table.lookup(combined, getContext);
    if (resolved) {
      // Sequence complete: clear the timeout and go idle before executing,
      // so a slow command handler can never race a timeout that fires
      // mid-execution and re-enters idle a second time.
      goIdle();
      executeSafely(resolved.command);
      return "consumed";
    }

    // Not a 2-stroke MVP requirement, but falls out naturally from the
    // table's general prefix query: if the combined sequence is itself a
    // prefix of something longer, keep waiting instead of discarding.
    if (table.hasSequencePrefix(combined, getContext)) {
      goPending(combined);
      return "consumed";
    }

    // No sequence completes: discard, no replay (design.md §6.3's
    // documented VS Code behavior).
    logSafely("warning", `Chord sequence discarded: no binding for "${combined}"`);
    goIdle();
    return "consumed";
  }

  function handleStroke(rawStroke: string): "consumed" | "passthrough" {
    // A disposed machine handles nothing: strokes pass through to the
    // focused component instead of executing commands from beyond the
    // grave.
    if (machineDisposed) return "passthrough";
    const stroke = normalizeKey(rawStroke);
    if (state.kind === "pending") {
      return handlePendingStroke(stroke, state.prefix);
    }
    return handleIdleStroke(stroke);
  }

  function onDidChangePending(listener: Listener<string | undefined>): Disposable {
    listeners.add(listener);
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        listeners.delete(listener);
      },
    };
  }

  function reset(): void {
    if (machineDisposed) return;
    if (state.kind === "idle") return;
    goIdle();
  }

  function dispose(): void {
    machineDisposed = true;
    clearArmedTimeout();
    generation += 1;
    state = { kind: "idle" };
    listeners.clear();
  }

  return { handleStroke, onDidChangePending, reset, dispose };
}
