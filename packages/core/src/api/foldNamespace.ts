/**
 * `createFoldNamespace`: the REAL `tecode.editor.folds` implementation
 * (Issue #150), backed by `ui/foldController.ts`.
 *
 * This module is only the ACTIVE-EDITOR adapter — it resolves "which
 * document?" (and, for a defaulted `line` argument, "where is the caret?")
 * and forwards everything else unchanged to the controller, which owns all
 * the actual folding policy. That split is what lets `EditorView`'s gutter
 * click reach the exact same code without going through the extension API
 * at all.
 *
 * A separate module from `stubs.ts`'s `createFoldStub` for the same reason
 * `editorNamespace.ts` is separate from `createEditorStub`: `create.ts`
 * still needs the inert surface for every caller built without a fold
 * backing, and that stub's "always no-op" contract is pinned by its own
 * tests.
 */

import type { FoldNamespace, FoldRange } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import type { EditorSessionService } from "../ui/editorSession";
import type { FoldController } from "../ui/foldController";

/** A shared, permanently-empty result for the no-active-editor reads —
 * same reference every call, matching `stubs.ts`'s own constant. */
const EMPTY_FOLD_RANGES: readonly FoldRange[] = [];

/** Dependencies for {@link createFoldNamespace}. */
export interface FoldNamespaceDeps {
  /** Resolves the active document, and (through its `EditorState`) the
   * primary cursor a defaulted `line` argument falls back to. Narrowed to
   * a `Pick`, matching `EditorNamespaceDeps`' own narrowing. */
  editorSession: Pick<EditorSessionService, "getActiveDocument" | "getState">;
  /** All the folding policy (`ui/foldController.ts`). */
  foldController: Pick<
    FoldController,
    "getFoldRanges" | "getCollapsedFolds" | "foldAt" | "unfoldAt" | "toggleAt" | "foldAll" | "unfoldAll" | "isLineVisible"
  >;
}

/** Build the real `tecode.editor.folds` namespace (Issue #150). Every
 * method resolves against `editorSession`'s current active document and
 * no-ops (reads report "nothing") when there is none — the same
 * absent-safe contract `createFoldStub` provides unconditionally. */
export function createFoldNamespace(deps: FoldNamespaceDeps): FoldNamespace {
  const { editorSession, foldController } = deps;

  function activeDocument(): CoreDocument | undefined {
    return editorSession.getActiveDocument();
  }

  /** `line` as given, or the primary cursor's line when omitted — "fold
   * where I am" is what a keyboard fold command means, and is what every
   * caller that passes nothing wants. */
  function resolveLine(document: CoreDocument, line: number | undefined): number {
    if (line !== undefined) return Math.max(0, Math.trunc(line) || 0);
    const active = editorSession.getState(document.uri).selections[0]?.active;
    return active ? active.line : 0;
  }

  return {
    ranges(): readonly FoldRange[] {
      const document = activeDocument();
      if (!document) return EMPTY_FOLD_RANGES;
      return foldController.getFoldRanges(document.uri);
    },

    collapsed(): readonly FoldRange[] {
      const document = activeDocument();
      if (!document) return EMPTY_FOLD_RANGES;
      return foldController.getCollapsedFolds(document.uri);
    },

    fold(line?: number): void {
      const document = activeDocument();
      if (!document) return;
      foldController.foldAt(document.uri, resolveLine(document, line));
    },

    unfold(line?: number): void {
      const document = activeDocument();
      if (!document) return;
      foldController.unfoldAt(document.uri, resolveLine(document, line));
    },

    toggle(line?: number): void {
      const document = activeDocument();
      if (!document) return;
      foldController.toggleAt(document.uri, resolveLine(document, line));
    },

    foldAll(): void {
      const document = activeDocument();
      if (!document) return;
      foldController.foldAll(document.uri);
    },

    unfoldAll(): void {
      const document = activeDocument();
      if (!document) return;
      foldController.unfoldAll(document.uri);
    },

    isLineVisible(line: number): boolean {
      const document = activeDocument();
      // No active editor: nothing is folded, so nothing is hidden — the
      // same answer `createFoldStub` always gives, so a caller (movement's
      // `LineReader`, most notably) never needs a "is folding even wired
      // up?" branch of its own.
      if (!document) return true;
      return foldController.isLineVisible(document.uri, line);
    },
  };
}
