/**
 * `EditorInputRouter` (Task 2.2, Req 4.6, 6.6; design.md §6.1, §8.3): what a
 * key stroke becomes once the keymap pipeline (`keymap/chords.ts`) reports
 * `"passthrough"` — no binding matched, or the matching binding's `when`
 * clause failed. design.md §6.1's pipeline diagram names the destination
 * plainly: "no match → focused component (editor insert, list
 * navigation)"; §8.3 spells out what that means for the editor
 * specifically: "Key input that reaches the view ... becomes an insert
 * `applyEdits` at all cursors."
 *
 * **Scope** (deliberately narrow, matching tasks.md's Task 2.2 line item
 * "Keymap fall-through to the focused editor becomes insert/delete
 * `applyEdits` at all cursors"): only plain printable insert (one code
 * point from an ordinary keystroke, or several at once from an IME commit —
 * Issue #110, `isPrintableSequence`'s TSDoc), backspace, and forward-delete.
 * Arrow keys, Enter/auto-indent, Tab
 * indentation, and replacing a non-collapsed selection when typing are all
 * out of scope here — they are editor-core commands (Task 2.3's
 * "movement... insert/delete with auto-indent, tab/shift-tab indentation")
 * that will get real keybindings of their own and be *consumed* by the
 * keymap before ever reaching this router, not something this router needs
 * to special-case. A selection's `active` point is always what this router
 * edits at; a non-collapsed selection is not replaced by typing yet (no
 * selection-creating command exists before Task 2.3 either, so every
 * `EditorState` this router sees today only ever holds collapsed cursors in
 * practice).
 *
 * **Multi-cursor batching** (Req 6.6): every cursor's edit for one keystroke
 * is built into a single `TextEdit[]` and applied with exactly one
 * `document.applyEdits(...)` call — already one atomic buffer mutation and
 * one `UndoStack` entry per `document.ts`'s own contract (`applyEdits`
 * pushes exactly once per call), so no extra `document.transaction(...)`
 * wrapper is needed to get "one keystroke = one undo step": that wrapper
 * would actually be actively harmful here, since wrapping every call in a
 * transaction would set `document.ts`'s internal `transactionGroupId` on
 * every keystroke and disable its typing-coalescing (Req 5.4: "typing
 * coalesces consecutive single-character inserts... into one group"),
 * which only activates when a single-edit `applyEdits` call carries no
 * group id at all.
 */

import type { Position, Selection, TextEdit } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import type { ContextService } from "../keymap/context";
import type { KeyEventLike } from "../keymap/keyEvent";
import type { EditorSessionService } from "../ui/editorSession";
import { comparePositions, transformPosition } from "./positionTransform";

/** One editing operation this router recognizes (this module's TSDoc's
 * "Scope" section). */
type EditOp = "insert" | "backspace" | "delete";

/** Every C0 control character and DEL are excluded from "printable" — a
 * `KeyEvent.sequence` for backspace/delete/tab/enter/escape is always one of
 * these, so this check alone would already reject them; `name` is checked
 * first anyway (below) for clarity and to stay correct even if some
 * terminal ever reports a different `sequence` for a named key.
 *
 * **Deliberately NOT restricted to a single code point** (Issue #110: "IME
 * text (Japanese) cannot be entered"). An IME delivers its whole composed
 * string — e.g. "日本語" — as ONE `KeyEvent` whose `sequence` holds several
 * code points at once; it is not one keystroke per character the way ASCII
 * typing is. A prior version of this function rejected any `sequence` with
 * `Array.from(sequence).length !== 1`, which classified every such commit
 * as non-printable and made `classifyKeyEvent` return `undefined` —
 * `routeKeyEvent` then silently dropped the entire input. The fix is to
 * require every code point in `sequence` to individually be printable,
 * rather than requiring there be exactly one. This is safe to do without
 * any change to how the edit is built or applied:
 * {@link buildEditBatch} already threads whatever `insertText` string it is
 * given straight into one `TextEdit` per cursor, and `positionTransform.ts`'s
 * `transformPosition` (which computes each cursor's post-edit position) is
 * already fully general over multi-character and multi-line `newText` — its
 * own TSDoc documents the multi-line case at length. So an N-character IME
 * commit already lands correctly as one `applyEdits` call (one undo entry)
 * with no further changes needed here.
 *
 * This intentionally does NOT route multi-code-point input through
 * `insertText`/{@link buildInsertTextBatch} instead (the paste path) even
 * though that function already handles arbitrary-length `text`: that
 * function replaces each selection's whole `[start, end)` range, whereas
 * the `"insert"` case below (via {@link buildEditForCursor}) inserts at a
 * zero-width `[active, active)` and never replaces a selection. Branching
 * IME/multi-char input to the paste path would make typing "日本語" over an
 * active selection replace it while typing "a" over the same selection
 * would not — an inconsistency this fix does not introduce. (Whether
 * printable insertion should ever replace a selection is a separate
 * question, out of this module's current "Scope".)
 *
 * Iterates with `Array.from` rather than indexing or comparing `.length`
 * against a byte/UTF-16-unit count, so a single character outside the BMP
 * (e.g. an emoji like "😀", a UTF-16 surrogate pair) is correctly counted
 * and checked as ONE code point, not two. */
function isPrintableSequence(sequence: string): boolean {
  if (!sequence) return false;
  const codepoints = Array.from(sequence);
  return codepoints.every((codepoint) => {
    const codePoint = codepoint.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint !== 0x7f;
  });
}

/**
 * Named keys {@link classifyKeyEvent} must never classify as `"insert"`.
 * This is defence in depth, added alongside the Issue #110 fix above, and
 * NOT load-bearing for most of these names today: verified against
 * `@opentui/core`'s `lib/parse.keypress.ts` keypress tables, every key
 * named here already reports a `sequence` that is either a single C0 byte
 * (`"\t"`, `"\r"`, `"\x1b"`, `"\x7f"`) or an ESC-prefixed (`"\x1b["`/`"\x1bO"`)
 * CSI/SS3 escape — {@link isPrintableSequence} above already rejects all of
 * those on their own, with or without this list. Kept anyway in case some
 * terminal or a future OpenTUI version ever reports a different `sequence`
 * for one of these names, per Issue #110's fix plan's Design Choice 2.
 *
 * Deliberately does NOT include ordinary printable keys that happen to
 * carry a `name` matching their character (e.g. `name: "a"`, or `name:
 * "space"` for the space bar) — blocking those on `name` would break
 * ordinary typing. `backspace`/`delete` keep their own explicit checks in
 * {@link classifyKeyEvent} rather than living in this set. */
const NON_INSERT_KEY_NAMES: ReadonlySet<string> = new Set([
  "up", "down", "left", "right",
  "escape", "tab", "return", "enter",
  "home", "end", "pageup", "pagedown", "insert",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

/**
 * Classify `event` (this module's TSDoc's "Scope"). `ctrl`/`meta` combos
 * never insert text (they are command chords' territory — a chord that
 * reaches here at all already means no binding claimed it, and typing the
 * literal control character it would otherwise produce is never the right
 * fallback). `option`/Alt is deliberately NOT excluded: many layouts
 * produce ordinary accented/alternate characters via Option (e.g. macOS
 * `⌥e`), which should still insert whatever `sequence` reports.
 */
function classifyKeyEvent(event: KeyEventLike): EditOp | undefined {
  if (event.name === "backspace") return "backspace";
  if (event.name === "delete") return "delete";
  if (event.ctrl || event.meta) return undefined;
  if (NON_INSERT_KEY_NAMES.has(event.name)) return undefined;
  return isPrintableSequence(event.sequence) ? "insert" : undefined;
}

/** Sort ascending and drop duplicate cursors — two selections sharing the
 * exact same `active` position merge into one (this module's "Merge
 * selections that collapse onto the same position" invariant, Task 2.2).
 * Always returns at least one entry given a non-empty input, preserving
 * `EditorState.selections`' own "never empty" invariant. */
function dedupeByActive(selections: readonly Selection[]): Selection[] {
  const sorted = [...selections].sort((a, b) => comparePositions(a.active, b.active));
  const result: Selection[] = [];
  for (const selection of sorted) {
    const last = result[result.length - 1];
    if (last && comparePositions(last.active, selection.active) === 0) continue;
    result.push(selection);
  }
  return result;
}

/** Build the single `TextEdit` `op` produces at `active`, or `undefined` for
 * a boundary no-op (backspace at document start, forward-delete at document
 * end) — this module's TSDoc's per-cursor edit shapes. */
function buildEditForCursor(
  op: EditOp,
  document: Pick<CoreDocument, "getLine" | "lineCount">,
  active: Position,
  insertText: string,
): TextEdit | undefined {
  switch (op) {
    case "insert":
      return { range: { start: active, end: active }, newText: insertText };

    case "backspace": {
      if (active.character > 0) {
        return {
          range: { start: { line: active.line, character: active.character - 1 }, end: active },
          newText: "",
        };
      }
      if (active.line > 0) {
        const previousLineLength = document.getLine(active.line - 1).length;
        return {
          range: { start: { line: active.line - 1, character: previousLineLength }, end: active },
          newText: "",
        };
      }
      return undefined; // Document start: no-op for this cursor.
    }

    case "delete": {
      const lineLength = document.getLine(active.line).length;
      if (active.character < lineLength) {
        return {
          range: { start: active, end: { line: active.line, character: active.character + 1 } },
          newText: "",
        };
      }
      if (active.line < document.lineCount - 1) {
        return {
          range: { start: active, end: { line: active.line + 1, character: 0 } },
          newText: "",
        };
      }
      return undefined; // Document end: no-op for this cursor.
    }
  }
}

/**
 * Drop any edit that overlaps one already kept, scanning in ascending
 * position order. `dedupeByActive` already removes the common case (two
 * cursors landing on the exact same position); this is a defensive
 * fallback for the much rarer case of two *different* cursors' independent
 * operations (e.g. two simultaneous line-join backspaces) producing ranges
 * that overlap without being identical — `LineBuffer.applyEdits` would
 * throw on the whole batch otherwise, losing every cursor's edit for the
 * keystroke rather than just the colliding one. The earlier (lower-position)
 * edit wins; the later one's cursor simply does not move this keystroke,
 * exactly as if its own edit had been a boundary no-op.
 */
function dropOverlapping(edits: readonly TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => comparePositions(a.range.start, b.range.start));
  const kept: TextEdit[] = [];
  for (const edit of sorted) {
    const previous = kept[kept.length - 1];
    if (previous && comparePositions(edit.range.start, previous.range.end) < 0) continue;
    kept.push(edit);
  }
  return kept;
}

/** Sort ascending and collapse any positions that coincide after the batch
 * (this module's TSDoc's merge invariant, part 2: distinct cursors whose
 * edits land them on the same final position — e.g. two adjacent
 * backspaces meeting in the middle) into a single collapsed selection. */
function toMergedSelections(positions: readonly Position[]): Selection[] {
  const sorted = [...positions].sort(comparePositions);
  const result: Selection[] = [];
  for (const position of sorted) {
    const last = result[result.length - 1];
    if (last && comparePositions(last.active, position) === 0) continue;
    result.push({ start: position, end: position, anchor: position, active: position });
  }
  return result;
}

/** Build the full multi-cursor edit batch for one keystroke, plus the
 * resulting `selections[]` (this module's TSDoc). `insertText` is only
 * meaningful for `op === "insert"`. */
function buildEditBatch(
  op: EditOp,
  document: Pick<CoreDocument, "getLine" | "lineCount">,
  selections: readonly Selection[],
  insertText: string,
): { edits: TextEdit[]; newSelections: Selection[] } {
  const deduped = dedupeByActive(selections);
  const rawEdits: TextEdit[] = [];
  for (const selection of deduped) {
    const edit = buildEditForCursor(op, document, selection.active, insertText);
    if (edit) rawEdits.push(edit);
  }
  const edits = dropOverlapping(rawEdits);

  const newPositions = deduped.map((selection) => transformPosition(selection.active, edits));
  const newSelections = toMergedSelections(newPositions);

  return { edits, newSelections };
}

/** Build the single `TextEdit` a call to {@link createEditorInputRouter}'s
 * `insertText` produces for one selection (Issue #91's paste path): replace
 * the selection's whole range (a collapsed cursor's zero-width `[active,
 * active)`, or a real selection's `[start, end)`) with `text` wholesale —
 * deliberately the SAME "insert, replacing any active selection" shape
 * `editor-core`'s `editing.ts` uses for `buildInsertEdit` (Tab/Enter), just
 * duplicated here rather than imported: `editor-core` is a `builtin`
 * extension and this module lives in `@tecode/core` — the ESLint layering
 * rule (`no-restricted-imports`) only allows the reverse direction. Unlike
 * {@link buildEditForCursor}'s `"insert"` case (always at a collapsed,
 * zero-width `[active, active)` — a keystroke, including a multi-code-point
 * IME commit (Issue #110), never replaces a selection), `text` here
 * replaces the selection's whole `[start, end)` range and can itself be
 * arbitrary — one or many lines, from a paste. That "replace the
 * selection" behavior, not code-point count, is why `insertText` stays a
 * SEPARATE public method rather than a new `EditOp` value: routing paste
 * text through `classifyKeyEvent`'s `"insert"` case would replace an active
 * selection when typing a single character too, which is not this editor's
 * behavior (this module's TSDoc's "Scope"). */
function buildInsertTextEdit(selection: Selection, text: string): TextEdit {
  return { range: { start: selection.start, end: selection.end }, newText: text };
}

/**
 * Build the full multi-cursor batch {@link createEditorInputRouter}'s
 * `insertText` applies for one paste (Issue #91, Req 6.6's "multi-cursor
 * batching" — same one-`applyEdits`-call contract this module's TSDoc
 * states for a keystroke): dedupe cursors sharing one `active` point
 * (matching {@link buildEditBatch}'s own first step), build one
 * {@link buildInsertTextEdit} per surviving selection, drop any that
 * overlaps one already kept, and compute each selection's resulting
 * collapsed cursor.
 *
 * **Tracks each selection's OWN edit's `range.end`, not its `active`** —
 * unlike this module's private `buildEditBatch` above (whose selections are
 * always collapsed pre-Task-2.3, so `active` and `range.end` are always the
 * same point, making the distinction moot there): a PASTE can replace a
 * genuine, possibly-BACKWARD selection, whose `active` can be the far
 * (leftward/upward) end of `range` rather than `range.end` — tracking
 * `active` directly would land the post-paste cursor at the wrong end of a
 * backward selection's now-inserted text. `editor-core`'s `editing.ts`'s
 * real `buildEditBatch` (Task 2.3) already solves this identical problem
 * the identical way; this is that same "own edit's `range.end`, else the
 * original `active`, run through `transformPosition`" shape, independently
 * implemented here since `editing.ts` cannot be imported (this function's
 * sibling {@link buildInsertTextEdit} TSDoc's layering note).
 */
function buildInsertTextBatch(
  selections: readonly Selection[],
  text: string,
): { edits: TextEdit[]; newSelections: Selection[] } {
  const deduped = dedupeByActive(selections);
  const rawEdits = deduped.map((selection) => buildInsertTextEdit(selection, text));
  const edits = dropOverlapping(rawEdits);
  const survivingSet = new Set(edits);

  const newPositions = deduped.map((selection, i) => {
    const own = rawEdits[i]!;
    const trackPoint = survivingSet.has(own) ? own.range.end : selection.active;
    return transformPosition(trackPoint, edits);
  });

  return { edits, newSelections: toMergedSelections(newPositions) };
}

/** Dependencies for {@link createEditorInputRouter}. Narrowed to `Pick`s of
 * the real services (matching `keymap/chords.ts`'s `ChordStateMachineDeps`
 * pattern) so tests can inject minimal fakes. */
export interface EditorInputRouterDeps {
  /** Gates all routing on `editorTextFocus` (Req 4.6) — reading, never
   * writing (that context key is `editorView.tsx`'s `useFocusTracking`
   * job, already wired; this router only checks it). */
  context: Pick<ContextService, "get">;
  /** The active document and its `EditorState` this router reads and
   * writes back to (Task 2.2's shared-state seam, `ui/editorSession.ts`). */
  editorSession: Pick<EditorSessionService, "getActiveDocument" | "getState" | "setState">;
}

/** The editor input router's public shape. */
export interface EditorInputRouter {
  /**
   * Route one key event that the keymap pipeline reported as
   * `"passthrough"` (design.md §6.1). Returns `true` when this router
   * handled it (an edit was applied, or a recognized editing key was a
   * documented no-op — document-boundary backspace/delete, or an edit on a
   * read-only document, design.md §14), `false` when it left the event
   * alone entirely — no active document, `editorTextFocus` is falsy, or the
   * key is not one this router recognizes (this module's TSDoc's "Scope").
   * Never throws: an unexpected failure anywhere in this call is caught and
   * reported as `false` (left alone) rather than crashing the input loop —
   * this router sits at a composition seam (design.md §14, matching
   * `chords.ts`'s/`bindingTable.ts`'s own guarded-boundary discipline).
   */
  routeKeyEvent(event: KeyEventLike): boolean;
  /**
   * Insert `text` at every cursor, replacing each selection's range if it
   * has one (Issue #91's paste path, design.md §6.1/§8.3's "focused
   * component" destination extended to bracketed-paste terminal input, not
   * just single-keystroke fallthrough). ALWAYS applied as exactly one
   * `document.applyEdits(...)` call across every selection ({@link
   * buildInsertTextBatch}'s TSDoc, Req 6.6) — never one call per line or
   * per cursor — so a multi-line paste is a single undo step, matching
   * `routeKeyEvent`'s own one-`applyEdits`-per-invocation contract.
   * Deliberately bypasses `classifyKeyEvent`/`isPrintableSequence` entirely
   * — `text` is not run through either, and unlike `routeKeyEvent`'s
   * `"insert"` case (always a zero-width insert at `active`, whatever the
   * length of the printable text involved — including a multi-code-point
   * IME commit, Issue #110), this method replaces each selection's whole
   * range, which is why it stays a separate method rather than something
   * `classifyKeyEvent` could also produce (`buildInsertTextEdit`'s TSDoc).
   *
   * No-ops exactly like `routeKeyEvent` does (same guards, same order): no
   * `editorTextFocus`, no active document, or a readonly document (Req
   * 5.5) — `applyEdits` is skipped entirely and `text` never reaches the
   * buffer. Never throws (this interface's own "guarded boundary"
   * discipline, matching `routeKeyEvent`).
   */
  insertText(text: string): void;
}

/** Build an {@link EditorInputRouter} (Task 2.2). */
export function createEditorInputRouter(deps: EditorInputRouterDeps): EditorInputRouter {
  const { context, editorSession } = deps;

  function routeKeyEvent(event: KeyEventLike): boolean {
    try {
      if (!context.get("editorTextFocus")) return false;

      const op = classifyKeyEvent(event);
      if (!op) return false;

      const document = editorSession.getActiveDocument();
      if (!document) return false;

      // A read-only document (Req 5.5, design.md §14: "Edit on readonly
      // document | Status-bar notice, edit ignored") must not let this
      // router optimistically move cursors for an edit `applyEdits` is
      // about to silently drop — that would desync selections from the
      // buffer's actual (unchanged) content.
      if (document.readonly) return true;

      const state = editorSession.getState(document.uri);
      const { edits, newSelections } = buildEditBatch(op, document, state.selections, event.sequence);

      if (edits.length > 0) {
        document.applyEdits(edits, {
          selectionsBefore: state.selections,
          selectionsAfter: newSelections,
        });
      }
      editorSession.setState(document.uri, { ...state, selections: newSelections });
      return true;
    } catch {
      // Never throw past this seam (this module's TSDoc) — an unexpected
      // failure here must not take down the whole input loop. Treated as
      // "left alone" rather than "handled": a caller (the chord
      // pipeline/renderer) that would otherwise have let the key do
      // something else still can.
      return false;
    }
  }

  /** {@link EditorInputRouter.insertText} — see that TSDoc for the
   * contract. Same guard order/shape as {@link routeKeyEvent} above, minus
   * the `classifyKeyEvent` step it deliberately bypasses. */
  function insertText(text: string): void {
    try {
      if (!context.get("editorTextFocus")) return;

      const document = editorSession.getActiveDocument();
      if (!document) return;

      // Same read-only guard as `routeKeyEvent` (Req 5.5) — no cursor
      // movement either, for the same "must not desync from an edit
      // `applyEdits` would silently drop" reason.
      if (document.readonly) return;

      const state = editorSession.getState(document.uri);
      const { edits, newSelections } = buildInsertTextBatch(state.selections, text);

      if (edits.length > 0) {
        // ONE `applyEdits` call for the whole batch (this method's TSDoc,
        // Req 6.6) — every selection's replacement is one `TextEdit` in
        // `edits`, so a multi-line/multi-cursor paste is exactly one
        // atomic buffer mutation and one `UndoStack` entry, never a loop
        // that calls `applyEdits` once per line or per cursor.
        document.applyEdits(edits, {
          selectionsBefore: state.selections,
          selectionsAfter: newSelections,
        });
      }
      editorSession.setState(document.uri, { ...state, selections: newSelections });
    } catch {
      // Never throw past this seam — see `routeKeyEvent`'s own catch.
    }
  }

  return { routeKeyEvent, insertText };
}
