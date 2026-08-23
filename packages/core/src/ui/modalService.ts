/**
 * `ModalService` (Task 3.1, Req 10.1's `tecode.window`, design.md §12: "
 * `tecode.window.showQuickPick/showInputBox` are implemented on the shell's
 * modal layer — a centered overlay component owned by core, since the
 * palette and pickers must exist before any extension UI"): the stateful
 * layer behind `tecode.window.showQuickPick`/`showInputBox`
 * (`api/create.ts`) and `modalOverlay.tsx`. Owns every mutation of "what
 * modal is open and what it currently shows" — `api/create.ts`'s real
 * `WindowNamespace` backing and `modalOverlay.tsx` both only ever call
 * through here, mirroring `findService.ts`'s "all state/logic lives in
 * `@tecode/core`, the component only renders it" split (`ui/findService.ts`'s
 * TSDoc).
 *
 * **One modal at a time, deliberately** (this task's plan): `openQuickPick`/
 * `openInputBox` each return a `Promise` that resolves once the picker
 * closes (accept or cancel) — exactly `WindowNamespace.showQuickPick`/
 * `showInputBox`'s own documented contract. If a modal is ALREADY open when
 * either is called again, the previous one is cancelled (its promise
 * resolves `undefined`, as if the user pressed Escape) before the new one
 * opens — never queued, never rejected, never silently ignored. This keeps
 * "what promise resolves when" simple for every caller (including two
 * concurrent `commands.execute` calls racing each other) at the cost of the
 * first caller's picker vanishing out from under the user — an acceptable
 * MVP trade-off given nothing in this codebase yet opens two pickers
 * concurrently on purpose.
 *
 * **Filtering — pure, separately testable** ({@link filterQuickPickItems}):
 * case-insensitive substring matching against `label`, `description`, AND
 * `detail` (a query matching any ONE of the three counts as a match) — the
 * same three fields `QuickPickItem` exposes (`@tecode/api`'s
 * `namespaces.ts`). `getState()` always DERIVES the filtered list and a
 * freshly clamped `activeIndex` from the raw `items`/`filterQuery`/
 * `activeIndex` triple rather than caching a filtered snapshot — the single
 * source of truth for "does the active index still point at something
 * real" lives in exactly one place (this function), so `setFilter`,
 * `selectNext`/`selectPrevious`, and `accept` all stay simple: they mutate
 * the RAW `activeIndex` (or leave it alone, for `setFilter`) and let
 * `getState`/`accept` reconcile it against whatever the CURRENT filtered
 * list happens to be, on every read.
 *
 * **`accept()`** resolves the highlighted item in the CURRENT filtered list
 * (or `undefined` if filtering has left nothing visible) for a quick pick;
 * for an input box, it only resolves (closing the modal) when
 * `InputBoxOptions.validateInput` — re-run on every {@link setInputValue}
 * call — currently reports no error, exactly like a real form's "cannot
 * submit while invalid" contract. `cancel()` always resolves `undefined`
 * regardless of validation state, matching Escape's "never mind" semantics.
 */

import type {
  Disposable,
  Event,
  InputBoxOptions,
  Listener,
  QuickPickItem,
  QuickPickOptions,
} from "@tecode/api";

/** A read-only snapshot of what the modal overlay should currently render
 * (this module's TSDoc) — `modalOverlay.tsx`'s only way to read
 * {@link ModalService} state. `items`/`activeIndex` for `"quickPick"` are
 * already filtered/clamped against the CURRENT `filterQuery` (this module's
 * TSDoc's "pure, separately testable" note) — a renderer never needs to
 * re-filter or re-clamp anything itself. */
export type ModalState =
  | { mode: null }
  | {
      mode: "quickPick";
      /** The filtered items, in original order. */
      items: readonly QuickPickItem[];
      filterQuery: string;
      /** Index into `items` above (already clamped into range, or `-1`
       * when `items` is empty) — the item `accept()`/Enter would pick right
       * now. */
      activeIndex: number;
      options: QuickPickOptions | undefined;
    }
  | {
      mode: "inputBox";
      value: string;
      /** `InputBoxOptions.validateInput`'s current result — `undefined`
       * means the current `value` is valid. */
      validationMessage: string | undefined;
      options: InputBoxOptions | undefined;
    };

/** The modal service's public shape (this module's TSDoc). */
export interface ModalService {
  /** The modal overlay's current, fully-derived state — see
   * {@link ModalState}'s TSDoc. */
  getState(): ModalState;
  /** Open a quick pick over `items` (Req 10.1's `WindowNamespace.
   * showQuickPick`) — resolves the accepted item, or `undefined` on cancel
   * (Escape) or if another modal was already open (this module's TSDoc's
   * "one modal at a time"). */
  openQuickPick(items: QuickPickItem[], options?: QuickPickOptions): Promise<QuickPickItem | undefined>;
  /** Open an input box (Req 10.1's `WindowNamespace.showInputBox`) —
   * resolves the accepted text, or `undefined` on cancel/supersession (this
   * module's TSDoc). */
  openInputBox(options?: InputBoxOptions): Promise<string | undefined>;
  /** Update the quick pick's filter query — a no-op when no quick pick is
   * open. */
  setFilter(query: string): void;
  /** Update the input box's value, re-running `validateInput` (this
   * module's TSDoc) — a no-op when no input box is open. */
  setInputValue(value: string): void;
  /** Move the quick pick's active selection to the next filtered item,
   * wrapping past the end back to the first — a no-op when no quick pick is
   * open or its filtered list is empty. */
  selectNext(): void;
  /** Move the quick pick's active selection to the previous filtered item,
   * wrapping before the start back to the last — a no-op when no quick pick
   * is open or its filtered list is empty. */
  selectPrevious(): void;
  /** Accept the current modal (this module's TSDoc's `accept()` note). A
   * no-op when no modal is open. */
  accept(): void;
  /** Cancel the current modal, resolving `undefined` — a no-op when no
   * modal is open. */
  cancel(): void;
  /** Fires after every state change this service makes — same "just
   * re-render, don't diff what changed" shape as `findService.ts`'s
   * `onDidChange`. */
  onDidChange: Event<void>;
  /** Cancels whatever modal is open (if any) and clears every listener.
   * Idempotent. */
  dispose(): void;
}

interface QuickPickInternal {
  mode: "quickPick";
  items: QuickPickItem[];
  filterQuery: string;
  /** The RAW active index — always re-clamped against the CURRENT filtered
   * list by `getState`/`accept`/`selectNext`/`selectPrevious` before use
   * (this module's TSDoc); never trusted as already-in-range on its own. */
  activeIndex: number;
  options: QuickPickOptions | undefined;
  resolve: (value: QuickPickItem | undefined) => void;
}

interface InputBoxInternal {
  mode: "inputBox";
  value: string;
  validationMessage: string | undefined;
  options: InputBoxOptions | undefined;
  resolve: (value: string | undefined) => void;
}

type InternalState = QuickPickInternal | InputBoxInternal | { mode: null };

/** Whether `item` matches `lowerQuery` (already lower-cased by the caller)
 * — a case-insensitive substring test against `label`, `description`, OR
 * `detail` (this module's TSDoc). An empty query matches everything. */
function matchesQuery(item: QuickPickItem, lowerQuery: string): boolean {
  if (lowerQuery.length === 0) return true;
  if (item.label.toLowerCase().includes(lowerQuery)) return true;
  if (item.description && item.description.toLowerCase().includes(lowerQuery)) return true;
  if (item.detail && item.detail.toLowerCase().includes(lowerQuery)) return true;
  return false;
}

/** The pure quick-pick filter (this module's TSDoc) — separately
 * unit-testable, with no {@link ModalService} instance needed. */
export function filterQuickPickItems(
  items: readonly QuickPickItem[],
  query: string,
): QuickPickItem[] {
  const lowerQuery = query.toLowerCase();
  return items.filter((item) => matchesQuery(item, lowerQuery));
}

/** Clamp `index` into `[0, length - 1]`, or `-1` when `length` is 0 — the
 * shared "derive a safe active index" rule `getState`/`selectNext`/
 * `selectPrevious`/`accept` all apply against the CURRENT filtered list
 * (this module's TSDoc). Never wraps: a negative or too-large `index`
 * lands on the nearest valid end, not the opposite end (wrapping is
 * `selectNext`/`selectPrevious`'s own, deliberately different, ring
 * behavior below). */
function clampIndex(index: number, length: number): number {
  if (length === 0) return -1;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

/** Build a {@link ModalService} (Task 3.1, Req 10.1, design.md §12). Takes
 * no dependencies — a self-contained UI-state store, matching
 * `createContextService()`'s zero-deps factory shape (`keymap/context.ts`)
 * rather than `findService.ts`'s document-backed one, since nothing about
 * "what modal is open" needs any other core service. */
export function createModalService(): ModalService {
  let state: InternalState = { mode: null };
  const listeners = new Set<Listener<void>>();

  function fireChange(): void {
    // Snapshot before iterating, isolate listener failures — matches every
    // other `onDidChange` in this codebase (`findService.ts`,
    // `slotRegistry.ts`, `context.ts`).
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch {
        // Isolate listener failures.
      }
    }
  }

  /** Resolve+clear whatever modal is currently open with `undefined`
   * (this module's TSDoc's "one modal at a time") — used both by
   * `cancel()` and by `openQuickPick`/`openInputBox` superseding a modal
   * that was already open. Does NOT fire `onDidChange` itself: `cancel()`
   * fires once after calling this; the open-supersedes-open path relies on
   * the NEW open's own `fireChange()` immediately after, so callers never
   * observe the momentary `{ mode: null }` in between. */
  function resolveCurrentAsCancelled(): void {
    if (state.mode === "quickPick" || state.mode === "inputBox") {
      const resolve = state.resolve;
      state = { mode: null };
      resolve(undefined);
    }
  }

  function getState(): ModalState {
    if (state.mode === "quickPick") {
      const items = filterQuickPickItems(state.items, state.filterQuery);
      return {
        mode: "quickPick",
        items,
        filterQuery: state.filterQuery,
        activeIndex: clampIndex(state.activeIndex, items.length),
        options: state.options,
      };
    }
    if (state.mode === "inputBox") {
      return {
        mode: "inputBox",
        value: state.value,
        validationMessage: state.validationMessage,
        options: state.options,
      };
    }
    return { mode: null };
  }

  function openQuickPick(
    items: QuickPickItem[],
    options?: QuickPickOptions,
  ): Promise<QuickPickItem | undefined> {
    resolveCurrentAsCancelled();
    return new Promise<QuickPickItem | undefined>((resolve) => {
      state = {
        mode: "quickPick",
        items: items.slice(),
        filterQuery: "",
        activeIndex: items.length > 0 ? 0 : -1,
        options,
        resolve,
      };
      fireChange();
    });
  }

  function openInputBox(options?: InputBoxOptions): Promise<string | undefined> {
    resolveCurrentAsCancelled();
    return new Promise<string | undefined>((resolve) => {
      const value = options?.value ?? "";
      let validationMessage: string | undefined;
      try {
        validationMessage = options?.validateInput?.(value);
      } catch {
        // A throwing validator must not break opening the input box —
        // treat it as "no validation error" rather than propagating.
        validationMessage = undefined;
      }
      state = { mode: "inputBox", value, validationMessage, options, resolve };
      fireChange();
    });
  }

  function setFilter(query: string): void {
    if (state.mode !== "quickPick") return;
    if (state.filterQuery === query) return;
    state = { ...state, filterQuery: query };
    fireChange();
  }

  function setInputValue(value: string): void {
    if (state.mode !== "inputBox") return;
    let validationMessage: string | undefined;
    try {
      validationMessage = state.options?.validateInput?.(value);
    } catch {
      validationMessage = undefined;
    }
    state = { ...state, value, validationMessage };
    fireChange();
  }

  function selectNext(): void {
    if (state.mode !== "quickPick") return;
    const filtered = filterQuickPickItems(state.items, state.filterQuery);
    if (filtered.length === 0) return;
    const current = clampIndex(state.activeIndex, filtered.length);
    state = { ...state, activeIndex: (current + 1) % filtered.length };
    fireChange();
  }

  function selectPrevious(): void {
    if (state.mode !== "quickPick") return;
    const filtered = filterQuickPickItems(state.items, state.filterQuery);
    if (filtered.length === 0) return;
    const current = clampIndex(state.activeIndex, filtered.length);
    state = { ...state, activeIndex: (current - 1 + filtered.length) % filtered.length };
    fireChange();
  }

  function accept(): void {
    if (state.mode === "quickPick") {
      const filtered = filterQuickPickItems(state.items, state.filterQuery);
      const index = clampIndex(state.activeIndex, filtered.length);
      const picked = index >= 0 ? filtered[index] : undefined;
      const resolve = state.resolve;
      state = { mode: null };
      resolve(picked);
      fireChange();
      return;
    }
    if (state.mode === "inputBox") {
      // Validation blocks accept (this module's TSDoc) — the modal stays
      // open, with whatever `validationMessage` is already showing.
      if (state.validationMessage !== undefined) return;
      const resolve = state.resolve;
      const value = state.value;
      state = { mode: null };
      resolve(value);
      fireChange();
    }
  }

  function cancel(): void {
    if (state.mode !== "quickPick" && state.mode !== "inputBox") return;
    resolveCurrentAsCancelled();
    fireChange();
  }

  function onDidChange(listener: Listener<void>): Disposable {
    listeners.add(listener);
    let listenerDisposed = false;
    return {
      dispose() {
        if (listenerDisposed) return;
        listenerDisposed = true;
        listeners.delete(listener);
      },
    };
  }

  function dispose(): void {
    cancel();
    listeners.clear();
  }

  return {
    getState,
    openQuickPick,
    openInputBox,
    setFilter,
    setInputValue,
    selectNext,
    selectPrevious,
    accept,
    cancel,
    onDidChange,
    dispose,
  };
}
