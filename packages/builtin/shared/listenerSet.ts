/**
 * The subscribe/dispatch/clear triple every built-in's store is built on —
 * the `builtin`-side copy of `@tecode/core`'s `util/listenerSet.ts`
 * (Qodana `DuplicatedCode`: `explorer/store.ts`, `search/store.ts` and
 * `terminal/store.ts` each carried an identical hand-rolled copy, each
 * citing one of the others as its precedent).
 *
 * The duplication across the two packages is deliberate and enforced: the
 * extension/core layering rule (`eslint.config.mjs`, Req 1.3) forbids
 * `packages/builtin/**` from importing `@tecode/core`, and `@tecode/api` is
 * by contract a type-only package. Within `builtin` it is imported, not
 * re-copied.
 */

import type { Disposable, Event, Listener } from "@tecode/api";

/** One store's set of subscribers. */
export interface ListenerSet<T> {
  /** Subscribe. The returned `Disposable` is idempotent. */
  readonly on: Event<T>;
  /** Dispatch `value` to a snapshot of the current subscribers, isolating
   * each one's failure. Never throws — a store fires this from inside its
   * own state transitions, so one broken view must not stop the others. */
  emit(value: T): void;
  /** Drop every subscriber. */
  clear(): void;
}

/** Build a {@link ListenerSet}. A listener's throw is swallowed, matching
 * every existing built-in store's own guarded dispatch. */
export function createListenerSet<T>(): ListenerSet<T> {
  const listeners = new Set<Listener<T>>();
  return {
    on(listener: Listener<T>): Disposable {
      listeners.add(listener);
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          listeners.delete(listener);
        },
      };
    },
    emit(value: T): void {
      for (const listener of Array.from(listeners)) {
        try {
          listener(value);
        } catch {
          // Isolate listener failures: one throwing subscriber must not
          // stop the rest or propagate out of the store that fired.
        }
      }
    },
    clear(): void {
      listeners.clear();
    },
  };
}
