/**
 * `wireEditorLangIdContext` (Req 4.6, design.md §6.4: "core maintains
 * `editorFocus`, `editorTextFocus`, `editorLangId`... as focus moves").
 * `editorFocus`/`editorTextFocus` are already maintained by
 * `useFocusTracking` calls in `shell.tsx`'s `EditorArea` and
 * `editorView.tsx`'s `EditorView` respectively (Task 2.1) — this module is
 * the third leg, for `editorLangId`, which is not a focus event at all but
 * an *active-document* event (a document's `languageId` is fixed at open
 * time, per `document.ts`; only which document is active can change).
 *
 * Deliberately wired here, at the composition root
 * (`packages/cli`'s `main.ts`), rather than inside a React render: setting
 * a context key is a side effect with no rendering purpose of its own, and
 * `EditorSessionService.onDidChange` already exists as a plain event this
 * module can subscribe to directly, with no React tree required to observe
 * it — the exact rationale design.md §6.4 gives for keeping context
 * maintenance in the keymap/host layer rather than in components.
 */

import type { Disposable } from "@tecode/api";
import type { ContextService } from "../keymap/context";
import type { EditorSessionService } from "./editorSession";

/** Dependencies for {@link wireEditorLangIdContext}. */
export interface WireEditorLangIdContextDeps {
  editorSession: Pick<EditorSessionService, "getActiveDocument" | "onDidChange">;
  context: Pick<ContextService, "set">;
}

/**
 * Keep `tecode.context`'s `"editorLangId"` key in sync with the active
 * document's `languageId` (Req 4.6): set to the active document's
 * `languageId` whenever it changes, and to `undefined` — the same "unset"
 * representation `when`-clause evaluation already treats as falsy
 * (design.md §6.4: "Unknown keys evaluate to `undefined`") — when there is
 * no active document. Runs once immediately (so the very first render sees
 * a correct value, not a stale default) and again on every subsequent
 * {@link EditorSessionService.onDidChange}. Returns a {@link Disposable}
 * that stops the subscription; idempotent.
 */
export function wireEditorLangIdContext(deps: WireEditorLangIdContextDeps): Disposable {
  const { editorSession, context } = deps;

  function sync(): void {
    const document = editorSession.getActiveDocument();
    context.set("editorLangId", document?.languageId);
  }

  sync();
  const sub = editorSession.onDidChange(sync);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      sub.dispose();
    },
  };
}
