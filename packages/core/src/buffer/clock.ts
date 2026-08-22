/**
 * A minimal time source, injected wherever wall-clock time drives behavior
 * that a test needs to control deterministically — currently just the
 * `UndoStack`'s 750 ms typing-coalescing window (Req 5.4, design.md §7.1:
 * "typing coalesces consecutive single-character inserts on the same line
 * within 750 ms into one group"). Tests substitute a fake, advanceable
 * clock instead of depending on real elapsed time.
 */
export interface Clock {
  /** Current time in milliseconds — same epoch and units as `Date.now()`. */
  now(): number;
}

/** The default {@link Clock} for real use, backed by `Date.now()`. */
export function createSystemClock(): Clock {
  return {
    now() {
      return Date.now();
    },
  };
}
