/**
 * The subscribe/dispatch/clear triple every `onDidChange`-style service in
 * `@tecode/core` is built on (Qodana `DuplicatedCode`): a `Set<Listener<T>>`,
 * an `on` that hands back an idempotent `Disposable`, and a dispatch that
 * snapshots the set before iterating and isolates each listener's failure.
 *
 * Nine services (`layoutState.ts`, `editorSession.ts`, `modalService.ts`,
 * `themeService.ts`, `themeRegistry.ts`, `findService.ts`, `foldService.ts`,
 * `highlightService.ts`, `languageRegistry.ts`) each carried their own copy
 * of all three, differing only in what they do when a listener throws — and
 * each one's TSDoc said so ("matches every other `onDidChange` in this
 * codebase"). That variation is the `onListenerError` parameter here; the
 * rest is now declared once.
 *
 * **Why `emit` snapshots**: a listener that disposes itself (or another
 * subscriber) during dispatch would otherwise mutate the set being
 * iterated. **Why `emit` swallows**: `onDidChange` is called from inside
 * state transitions, so one broken subscriber must neither stop the
 * remaining ones nor propagate out of the service that fired.
 *
 * `packages/builtin/**` has its own copy in `builtin/shared/listenerSet.ts`
 * — the extension/core layering rule forbids importing `@tecode/core` there,
 * and `@tecode/api` is a type-only package by contract.
 */

import type { Disposable, Event, Listener } from "@tecode/api";

/** One service's set of subscribers. */
export interface ListenerSet<T> {
  /** Subscribe. The returned `Disposable` is idempotent — disposing twice
   * is a no-op, never a double-delete. */
  readonly on: Event<T>;
  /** Dispatch `value` to a snapshot of the current subscribers, routing any
   * listener's throw to this set's `onListenerError`. Never throws. */
  emit(value: T): void;
  /** Drop every subscriber (a service's own `dispose()`). */
  clear(): void;
}

/**
 * Build a {@link ListenerSet}. `onListenerError`, when supplied, receives
 * whatever a listener threw; when omitted the throw is swallowed — the two
 * behaviors the existing services split between (logging ones pass their own
 * guarded logger, the rest pass nothing).
 */
export function createListenerSet<T>(onListenerError?: (cause: unknown) => void): ListenerSet<T> {
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
        } catch (cause) {
          onListenerError?.(cause);
        }
      }
    },
    clear(): void {
      listeners.clear();
    },
  };
}
