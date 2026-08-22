/**
 * The context service (Req 4.6, design.md §6.4): a flat key/value store
 * that `when` clauses ({@link WhenContextGetter}) read from. Built as a
 * factory function — `createContextService()` — rather than a class, to
 * match the rest of core (`createCommandRegistry`, `createHostLog`).
 *
 * Core sets keys like `editorFocus`, `editorTextFocus`, `editorLangId`,
 * and focus-tracking keys as focus moves; extensions set their own (e.g.
 * `explorerFocus`) through `tecode.context.set`.
 */

import type { ContextNamespace, Disposable, Event, Listener } from "@tecode/api";

/**
 * The context service's internal shape: `set`/`get` are exactly
 * `tecode.context` ({@link ContextNamespace}); `onDidChange` is exposed
 * only to internal consumers (focus tracking, the palette, the keymap
 * service's binding re-evaluation) — it is not part of the public
 * `ContextNamespace` surface extensions see. Because `ContextService`
 * extends `ContextNamespace`, the public projection is just picking
 * `{ set, get }` off of it; no separate wrapper object is needed.
 */
export interface ContextService extends ContextNamespace {
  /** Fires with the key that changed whenever `set` actually changes its
   * value (design.md §6.4). Setting a key to a value it already holds
   * does not fire. */
  onDidChange: Event<string>;
}

/** Build a context service (Req 4.6). Backed by a single
 * `Map<string, unknown>` — no per-namespace nesting, no schema. */
export function createContextService(): ContextService {
  const store = new Map<string, unknown>();
  const listeners = new Set<Listener<string>>();

  function get<T = unknown>(key: string): T | undefined {
    return store.get(key) as T | undefined;
  }

  function set(key: string, value: unknown): void {
    const previous = store.get(key);
    // Object.is (not ===) so re-setting NaN to NaN is correctly treated
    // as "unchanged" rather than spuriously firing a change event.
    if (Object.is(previous, value)) return;
    store.set(key, value);
    // Snapshot before iterating: a listener that disposes itself (or
    // another listener) during the loop must not perturb this dispatch.
    for (const listener of Array.from(listeners)) {
      try {
        listener(key);
      } catch {
        // Isolate listener failures: one throwing listener must not stop
        // the remaining listeners or propagate out of set().
      }
    }
  }

  function onDidChange(listener: Listener<string>): Disposable {
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

  return { get, set, onDidChange };
}
