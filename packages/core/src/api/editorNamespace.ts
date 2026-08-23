/**
 * `createEditorNamespace`: the REAL `tecode.editor` implementation (Req
 * 6.5, 6.6, 11.1; design.md §12, §13), backed by `ui/editorSession.ts`'s
 * `EditorSessionService` — the same seam `editor/inputRouter.ts` (Task 2.2)
 * already reads/writes.
 *
 * This is a separate module from `stubs.ts`'s `createEditorStub`
 * (deliberately — see `create.ts`'s TSDoc) rather than a modification to
 * it: `createEditorStub`'s existing tests (`stubs.test.ts`) pin its exact
 * "always no active editor" behavior with no session dependency at all, and
 * `create.ts` still needs that exact fallback for any caller that builds
 * the `tecode` API without an `EditorSessionService` (every test root that
 * predates Task 2.3, and any future caller that genuinely has no editor UI
 * to back it). `create.ts` picks between the two based on whether
 * `CreateTecodeApiDeps.editorSession` was supplied.
 */

import type { EditorNamespace, Position, Selection, TextEdit } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import type { StatusSink } from "../host/errors";
import type { EditorSessionService } from "../ui/editorSession";

/** The primary cursor's placeholder position when there is no active
 * editor: the document origin. A fresh object every call — mirrors
 * `stubs.ts`'s `originPosition` (duplicated rather than imported: a
 * one-line helper isn't worth widening that module's exported surface
 * for). */
function originPosition(): Position {
  return { line: 0, character: 0 };
}

/** A fresh, independent copy of `position` — no shared references back into
 * whatever object it came from. */
function clonePosition(position: Position): Position {
  return { line: position.line, character: position.character };
}

/**
 * A fresh, independent deep copy of `selection` (Finding 2 / this API's
 * mutability boundary — Req 10.1's "extensions must not be able to reach
 * into host state"): `Selection`/`Position` are plain mutable objects, so
 * handing an extension the SAME object `EditorSessionService` holds would
 * let it mutate `EditorState` in place — `selection.start.character = 0`,
 * say — bypassing `setState` entirely and skipping every change
 * notification that's supposed to fire on a real cursor move. Every read
 * that surfaces a `Selection` (or a `Position` nested inside one) MUST run
 * it through this first; `setSelections` must clone on the way IN for the
 * same reason, in case the extension keeps its own reference to the array
 * it just handed over and mutates it afterward. Exported so `create.ts`'s
 * `window.activeEditor.selections` — which reads through this same
 * `editorSession` state — reuses the identical copy, rather than
 * re-implementing it.
 */
export function cloneSelection(selection: Selection): Selection {
  return {
    start: clonePosition(selection.start),
    end: clonePosition(selection.end),
    anchor: clonePosition(selection.anchor),
    active: clonePosition(selection.active),
  };
}

/** Dependencies for {@link createEditorNamespace}. */
export interface EditorNamespaceDeps {
  /** Where a no-active-editor action reports (design.md §12, §14) —
   * matches `createEditorStub`'s own `sink` dependency. */
  sink: StatusSink;
  /** The live active-document/selection seam (Task 2.2). Narrowed to a
   * `Pick` (matches `editor/inputRouter.ts`'s own dependency narrowing) so
   * a test can inject a minimal fake instead of a whole real service. */
  editorSession: Pick<EditorSessionService, "getActiveDocument" | "getState" | "setState">;
}

/**
 * Build the real `tecode.editor` namespace (Req 6.5, 6.6, 11.1). Every
 * read/write resolves against `editorSession`'s current active document —
 * `undefined` (no active document) reproduces `createEditorStub`'s exact
 * no-op-plus-sink-notice contract for `revealLine`/`insertSnippet`/
 * `applyEdits`, and reads (`selections`/`cursor`/`getLine`/`lineCount`)
 * report the same "nothing is active" defaults the stub always returned
 * (`[]`, the origin position, `""`, `0`).
 */
export function createEditorNamespace(deps: EditorNamespaceDeps): EditorNamespace {
  const { sink, editorSession } = deps;

  /** Guarded `sink.error` — a broken/throwing sink must not make an editor
   * call throw (matches `createEditorStub`'s `notifyNoActiveEditor`). */
  function notifyNoActiveEditor(action: string): void {
    try {
      sink.error({ message: `No active editor to ${action}.` });
    } catch {
      // Swallowed — see this module's TSDoc on the never-throw discipline.
    }
  }

  function activeDocument(): CoreDocument | undefined {
    return editorSession.getActiveDocument();
  }

  return {
    get selections(): readonly Selection[] {
      const document = activeDocument();
      if (!document) return [];
      return editorSession.getState(document.uri).selections.map(cloneSelection);
    },

    get cursor(): Position {
      const document = activeDocument();
      if (!document) return originPosition();
      const selections = editorSession.getState(document.uri).selections;
      const active = selections[0]?.active;
      return active ? clonePosition(active) : originPosition();
    },

    revealLine(line: number): void {
      const document = activeDocument();
      if (!document) {
        notifyNoActiveEditor(`reveal line ${line}`);
        return;
      }
      // A minimal, viewport-agnostic "reveal": jump the tracked scrollTop
      // to the requested line, clamped in bounds. `EditorView` itself
      // already re-derives its actual scroll position from the PRIMARY
      // CURSOR on every render (`ui/editorView.tsx`'s `revealLine` call
      // over `viewport.ts`), so every movement/selection command in
      // `editor-core` gets "scroll to keep the caret visible" for free via
      // `setSelections` alone — this method exists for an extension that
      // wants to reveal a line WITHOUT moving the cursor there.
      const maxLine = Math.max(0, document.lineCount - 1);
      const clamped = Math.max(0, Math.min(Math.trunc(line) || 0, maxLine));
      const state = editorSession.getState(document.uri);
      editorSession.setState(document.uri, { ...state, scrollTop: clamped });
    },

    insertSnippet(snippet: string): void {
      const document = activeDocument();
      if (!document) {
        notifyNoActiveEditor("insert a snippet");
        return;
      }
      // Snippet tab-stop syntax/expansion is host-defined and not
      // implemented yet (`@tecode/api`'s own TSDoc on `insertSnippet`
      // only fixes the entry point) — report rather than silently
      // dropping the call (design.md §14's "never silently do nothing").
      try {
        sink.error({ message: `tecode.editor.insertSnippet is not implemented yet: ${snippet}` });
      } catch {
        // Swallowed — see this module's TSDoc.
      }
    },

    applyEdits(edits: TextEdit[]): void {
      const document = activeDocument();
      if (!document) {
        notifyNoActiveEditor("apply edits");
        return;
      }
      document.applyEdits(edits);
    },

    getLine(line: number): string {
      const document = activeDocument();
      if (!document) return "";
      try {
        return document.getLine(line);
      } catch {
        // Out-of-bounds `line` (CoreDocument.getLine throws RangeError) —
        // the API never throws to extension code (design.md §14); "" is
        // the same graceful default a no-active-editor read reports.
        return "";
      }
    },

    get lineCount(): number {
      const document = activeDocument();
      return document ? document.lineCount : 0;
    },

    setSelections(selections: readonly Selection[]): void {
      const document = activeDocument();
      if (!document) return;
      // A document always has at least one selection (`EditorState`'s own
      // invariant, `ui/editorState.ts`) — an empty array would corrupt
      // that invariant, so it is a documented no-op (this interface's
      // TSDoc in `@tecode/api`) rather than clearing the caret entirely.
      if (selections.length === 0) return;
      const state = editorSession.getState(document.uri);
      editorSession.setState(document.uri, { ...state, selections: selections.map(cloneSelection) });
    },
  };
}
