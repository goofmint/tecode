/**
 * Pure per-selection logic for `editor-core`'s clipboard commands (Issue
 * #91): `editor.action.clipboardCopy`/`clipboardCut`/`clipboardPaste`.
 * Copy/cut read the text under every selection (joined by `"\n"` across
 * multiple cursors — a multi-cursor copy/cut's clipboard text has one line
 * per cursor, in selection order); cut also builds the delete-the-selection
 * edit batch, reusing `editing.ts`'s `buildEditBatch` exactly like
 * `deleteLeft`/`deleteRight` do. Paste reuses `editing.ts`'s own
 * `buildInsertEdit` — a paste and a Tab/Enter keystroke both "insert this
 * text, replacing any active selection" (that function's own TSDoc).
 *
 * No `@tecode/core` import (the ESLint layering rule); reads through a
 * {@link LineReader}, matching `movement.ts`/`multiCursor.ts`.
 */

import type { Selection, TextEdit } from "@tecode/api";
import { buildEditBatch, buildInsertEdit, type EditBatch } from "./editing";
import { readBuffer, toOffset } from "./bufferOffsets";
import type { LineReader } from "./movement";
import { isCollapsed } from "./selectionMerge";

/**
 * The text `editor.action.clipboardCopy`/`clipboardCut` write to the
 * clipboard (Issue #91): each selection's own text (`""` for a collapsed
 * cursor with nothing selected), joined with `"\n"` across multiple
 * cursors, in `selections`' own order. `""` for an empty `selections`
 * array (the no-active-editor/no-op case — `index.ts`'s command handlers
 * already guard on this before ever calling here, matching every other
 * command in this package's convention).
 */
export function buildClipboardText(reader: LineReader, selections: readonly Selection[]): string {
  if (selections.length === 0) return "";
  const { text, lineStarts } = readBuffer(reader);
  return selections
    .map((selection) => text.slice(toOffset(selection.start, lineStarts), toOffset(selection.end, lineStarts)))
    .join("\n");
}

/** Build the edit that deletes `selection`'s own range for
 * `editor.action.clipboardCut` — `undefined` for a collapsed selection
 * (nothing to delete for that cursor, matching `buildBackspaceEdit`/
 * `buildDeleteEdit`'s own "boundary no-op" convention in `editing.ts`,
 * rather than deleting a whole line the way some editors do with nothing
 * selected — Issue #91 does not ask for that). */
function buildCutRangeEdit(selection: Selection): TextEdit | undefined {
  if (isCollapsed(selection)) return undefined;
  return { range: { start: selection.start, end: selection.end }, newText: "" };
}

/** What {@link buildCutResult} produces: the clipboard text (this module's
 * {@link buildClipboardText}) plus the delete edit batch (`editing.ts`'s
 * `EditBatch` shape — `edits` to apply, `selections` the resulting
 * collapsed cursors). */
export interface CutResult extends EditBatch {
  text: string;
}

/**
 * Build `editor.action.clipboardCut`'s full result (Issue #91): the text to
 * write to the clipboard (every selection's own text, even a collapsed
 * one's `""`, so a cut always copies exactly what a copy of the same
 * selections would have), and the edit batch that deletes each
 * NON-collapsed selection's range — reusing `editing.ts`'s `buildEditBatch`
 * exactly like `deleteLeft`/`deleteRight` do (this module's TSDoc).
 */
export function buildCutResult(reader: LineReader, selections: readonly Selection[]): CutResult {
  const text = buildClipboardText(reader, selections);
  const { edits, selections: newSelections } = buildEditBatch(selections, buildCutRangeEdit);
  return { text, edits, selections: newSelections };
}

/**
 * Build `editor.action.clipboardPaste`'s edit batch (Issue #91): insert
 * `text` at every selection, replacing its range if it has one — reusing
 * `editing.ts`'s own `buildInsertEdit(selection, text)` (the exact
 * "insert, replacing any active selection" shape Tab/Enter already use)
 * through `buildEditBatch`, so a multi-line/multi-cursor paste is one
 * batch, one `applyEdits` call, one undo step, exactly like every other
 * `editor-core` editing command.
 */
export function buildPasteResult(selections: readonly Selection[], text: string): EditBatch {
  return buildEditBatch(selections, (selection) => buildInsertEdit(selection, text));
}
