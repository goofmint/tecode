/**
 * The incremental-edit step `highlightService.ts` and `foldService.ts` both
 * run before a re-parse: translate one `DocumentChangeEvent`'s edits into
 * the offset/row-column descriptors `ParserTree.edit` wants, and apply them
 * bottom-up — plus the matching teardown of one document's parse state
 * (Qodana `DuplicatedCode` — each service carried an identical copy of both,
 * each one's comment pointing at the other's).
 */

import type { Disposable, TextEdit } from "@tecode/api";
import { createLineBuffer, type LineBuffer } from "../buffer/lineBuffer";
import { comparePositions } from "../editor/positionTransform";
import type { ParserTree } from "./parserBackend";

/** {@link applyIncrementalEdits}' by-products, both of which the callers
 * still need afterwards: the sorted edit list (`highlightService.ts` feeds
 * it to its ranged span splice) and the pre-edit line buffer (for its
 * `lineCount`). */
export interface IncrementalEditResult {
  /** `edits` in the order they were applied — descending start position. */
  sortedEdits: TextEdit[];
  /** A {@link LineBuffer} over the text as it was BEFORE these edits. */
  oldBuffer: LineBuffer;
}

/**
 * Apply `edits` to `tree`'s internal node offsets, resolving each edit's
 * positions against `lastText` — the document's text as of the last parse,
 * which is what the pre-batch offsets in `edits` are relative to.
 *
 * Edits are applied BOTTOM-UP (descending start position), the same order
 * `document.ts`'s `buffer.applyEdits` uses: that is what makes every edit's
 * pre-batch offsets still valid when applied in sequence, since an earlier
 * (higher) edit never shifts a later (lower) one's coordinates.
 *
 * Per {@link ParserTree.edit}'s contract the caller MUST follow this with a
 * `ParserBackend.parse` passing `tree` back as `oldTree` before querying it
 * again.
 */
export function applyIncrementalEdits(
  tree: ParserTree,
  lastText: string,
  edits: readonly TextEdit[],
): IncrementalEditResult {
  const oldBuffer = createLineBuffer(lastText || "\n", "\n");
  const sortedEdits = Array.from(edits).sort((a: TextEdit, b: TextEdit) =>
    comparePositions(b.range.start, a.range.start),
  );
  for (const edit of sortedEdits) {
    tree.edit({
      startIndex: oldBuffer.offsetAt(edit.range.start),
      oldEndIndex: oldBuffer.offsetAt(edit.range.end),
      insertedText: edit.newText,
      startPosition: { row: edit.range.start.line, column: edit.range.start.character },
      oldEndPosition: { row: edit.range.end.line, column: edit.range.end.character },
    });
  }
  return { sortedEdits, oldBuffer };
}

/** The slice of a language service's per-document state that needs
 * releasing — `highlightService.ts`'s `HighlightDocState` and
 * `foldService.ts`'s `FoldDocState` both satisfy it structurally. */
export interface ParsedDocumentState {
  documentSub?: Disposable;
  tree?: { dispose?(): void };
}

/**
 * Release one document's parse state: its `onDidChange` subscription and its
 * parse tree. The tree is freed NOW rather than left to GC — Req 13.1's
 * finding: `web-tree-sitter`'s `Tree#delete` frees WASM heap memory
 * immediately, and relying on GC alone lets it grow unboundedly under
 * per-keystroke re-parses (`ParserTree.dispose`'s own TSDoc).
 *
 * Does NOT remove the state from its owning map — the two call shapes differ
 * there (`detachDocument` deletes one key; `dispose` clears the whole map
 * after looping).
 */
export function disposeParsedDocumentState(state: ParsedDocumentState): void {
  state.documentSub?.dispose();
  state.tree?.dispose?.();
}
