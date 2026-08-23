/**
 * `EditorSessionService` (Task 2.2, design.md §8.1/§8.3): the one place
 * that owns *which* document is the shell's single editor group's active
 * tab, and each open document's `EditorState` (`editorState.ts`) — lifted
 * out of `shell.tsx`'s own `useState`/`useRef` (Task 2.1's original,
 * React-only home for this) so that something *outside* React — the
 * editor input router (`editor/inputRouter.ts`) at the composition root —
 * can read the active document/state and write back new cursor positions
 * after routing a keystroke, with `Shell` simply re-rendering off this
 * service's `onDidChange` instead of being the sole owner of the data.
 *
 * **Why a new service instead of exposing `Shell`'s internal refs**: React
 * refs/state are not readable or writable from outside a component's own
 * render/effect closures — there is no seam for `packages/cli`'s key-input
 * handler (which lives entirely outside React) to reach into `Shell`'s
 * `editorStatesRef` even if it were exported. A plain event-driven service,
 * built with `createEditorSessionService(deps)` per house convention
 * (matches `createContextService`, `createSlotRegistry`), is the standard
 * shape this codebase already uses for exactly this "component-external
 * code and React both need to read/write the same live state" problem.
 *
 * **Backward compatibility (Task 2.1)**: `Shell`'s `editorSession` prop is
 * optional — see `shell.tsx`'s own TSDoc on why an existing caller/test
 * that never passes one keeps getting Task 2.1's original decoupled,
 * component-local behavior unchanged.
 *
 * **Active-document policy**, replicated here from `shell.tsx`'s original
 * effect so both this service (when supplied) and `Shell`'s Task 2.1
 * fallback (when it isn't) behave identically: keep the current active
 * document if it's still open; otherwise fall back to the first open one;
 * `undefined` when nothing is open.
 */

import type { Disposable, Event, Listener, Uri } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import type { DocumentManager } from "../buffer/documentManager";
import { createInitialEditorState, type EditorState } from "./editorState";

/** Dependencies for {@link createEditorSessionService}. */
export interface EditorSessionServiceDeps {
  /** The single source of truth for which documents are open (Req 6.5) —
   * this service tracks the active one among them and reacts to
   * `onDidOpen`/`onDidClose` exactly as `shell.tsx`'s original effect did. */
  documents: DocumentManager;
}

/**
 * The editor session service's public shape (Task 2.2, design.md §8.1,
 * §8.3). Built with {@link createEditorSessionService} rather than a class,
 * per house convention.
 */
export interface EditorSessionService {
  /** The single editor group's active document uri, or `undefined` when no
   * document is open (Req 6.5). */
  getActiveDocumentUri(): Uri | undefined;
  /** The active document itself (a convenience over
   * {@link getActiveDocumentUri} plus a `documents.documents` lookup) —
   * `undefined` under the same conditions as {@link getActiveDocumentUri}. */
  getActiveDocument(): CoreDocument | undefined;
  /** Switch the active tab (e.g. a tab-bar click, `Shell`'s
   * `onSelectEditorTab`). A no-op (fires no event) if `uri` is already
   * active. Does not validate that `uri` is actually open — matches Task
   * 2.1's original `useState` setter, which never validated either. */
  setActiveDocumentUri(uri: Uri | undefined): void;
  /** `uri`'s current `EditorState` (design.md §8.3), creating and storing
   * the initial collapsed-cursor-at-origin state (`createInitialEditorState`)
   * on first access so every caller always gets a real value, never
   * `undefined`. */
  getState(uri: Uri): EditorState;
  /** Replace `uri`'s `EditorState` wholesale and fire {@link onDidChange} —
   * the editor input router's write-back path after routing a keystroke
   * (`editor/inputRouter.ts`, Task 2.2). */
  setState(uri: Uri, state: EditorState): void;
  /**
   * Fires after any change this service tracks: the active document
   * switching (including a `documents.onDidOpen`/`onDidClose`-driven
   * switch, not just an explicit {@link setActiveDocumentUri} call), or a
   * {@link setState} call. Carries no payload — same "just re-render, don't
   * try to diff what changed" shape as `slotRegistry.ts`'s
   * `useSlotViews`/`useOpenDocuments` consumers (`shell.tsx`) already use.
   */
  onDidChange: Event<void>;
  /** Unsubscribe from `documents` and clear all `onDidChange` listeners.
   * Idempotent. */
  dispose(): void;
}

/**
 * Build an {@link EditorSessionService} (Task 2.2). Synchronously runs the
 * active-document policy once against whatever `deps.documents` already has
 * open (covering a caller that constructs this after documents have already
 * been opened), then keeps it current via `onDidOpen`/`onDidClose`.
 */
export function createEditorSessionService(deps: EditorSessionServiceDeps): EditorSessionService {
  const { documents } = deps;
  const states = new Map<Uri, EditorState>();
  const listeners = new Set<Listener<void>>();
  let activeUri: Uri | undefined;
  let disposed = false;

  function fireChange(): void {
    // Snapshot before iterating, and isolate listener failures — matches
    // every other `onDidChange` in this codebase (context.ts, document.ts,
    // documentManager.ts).
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch {
        // Isolate listener failures: one throwing listener must not stop
        // the remaining listeners or propagate out of this service.
      }
    }
  }

  /** `shell.tsx`'s original effect, replicated exactly (this module's
   * TSDoc): keep the current active document if still open; otherwise fall
   * back to the first open one; `undefined` when nothing is open. */
  function syncActiveDocument(): void {
    const open = documents.documents;
    if (open.length === 0) {
      if (activeUri !== undefined) {
        activeUri = undefined;
        fireChange();
      }
      return;
    }
    if (activeUri !== undefined && open.some((d) => d.uri === activeUri)) return;
    const next = open[0]!.uri;
    if (activeUri !== next) {
      activeUri = next;
      fireChange();
    }
  }

  const openSub = documents.onDidOpen(() => {
    if (!disposed) syncActiveDocument();
  });
  const closeSub = documents.onDidClose((closed) => {
    if (disposed) return;
    // Drop retained EditorState for a document that is no longer open —
    // otherwise a long session's Map would grow forever across
    // open/close cycles (matches shell.tsx's original pruning effect).
    states.delete(closed.uri);
    syncActiveDocument();
  });

  // Cover a caller built after documents were already opened (this
  // module's TSDoc).
  syncActiveDocument();

  function getActiveDocumentUri(): Uri | undefined {
    return activeUri;
  }

  function getActiveDocument(): CoreDocument | undefined {
    if (activeUri === undefined) return undefined;
    return documents.documents.find((d) => d.uri === activeUri);
  }

  function setActiveDocumentUri(uri: Uri | undefined): void {
    if (activeUri === uri) return;
    activeUri = uri;
    fireChange();
  }

  function getState(uri: Uri): EditorState {
    let state = states.get(uri);
    if (!state) {
      state = createInitialEditorState(uri);
      states.set(uri, state);
    }
    return state;
  }

  function setState(uri: Uri, state: EditorState): void {
    states.set(uri, state);
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
    if (disposed) return;
    disposed = true;
    openSub.dispose();
    closeSub.dispose();
    listeners.clear();
  }

  return {
    getActiveDocumentUri,
    getActiveDocument,
    setActiveDocumentUri,
    getState,
    setState,
    onDidChange,
    dispose,
  };
}
