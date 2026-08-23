/**
 * Pure logic for `editor.action.toggleLineComment` (Req 11.1; design.md
 * §13; tasks.md's Task 2.4): given a language's `comments.line` marker
 * (looked up by `index.ts` via `tecode.languages.getLanguage` — Task 2.4's
 * new API surface), toggle line-comment markers on every line the current
 * selections touch. No `@tecode/core` import (the ESLint layering rule);
 * reads through a {@link LineReader}.
 */

import type { Selection, TextEdit } from "@tecode/api";
import type { LineReader } from "./movement";
import { affectedLineRange } from "./lineOps";
import { mergeSelections } from "./selectionMerge";
import { transformSelection } from "./positionTransform";

/** The distinct 0-based lines every selection touches (Req 11.1's line
 * operations convention, `lineOps.ts`'s {@link affectedLineRange}),
 * ascending and deduplicated — comment-toggling is per-LINE, not
 * per-contiguous-group, so (unlike `lineOps.ts`'s block operations) there
 * is no need to merge adjacent lines into a group first. */
function targetLines(selections: readonly Selection[]): number[] {
  const lines = new Set<number>();
  for (const selection of selections) {
    const [a, b] = affectedLineRange(selection);
    for (let line = a; line <= b; line++) lines.add(line);
  }
  return [...lines].sort((x, y) => x - y);
}

/** Whether `line`, after trimming leading whitespace, starts with
 * `marker` — this module's "is this line commented" test. An entirely
 * blank line never counts as commented (its trimmed text is `""`), which
 * is what pushes a selection mixing code and blank lines toward the
 * "comment" action rather than "uncomment" (this module's documented,
 * VS-Code-equivalent tie-break — see {@link buildToggleLineCommentResult}'s
 * TSDoc). */
function isLineCommented(line: string, marker: string): boolean {
  return line.trimStart().startsWith(marker);
}

/** What {@link buildToggleLineCommentResult} produces. `edits` is empty
 * exactly when there is nothing to toggle (no target lines — impossible
 * given a non-empty `selections`, but kept for symmetry with the other
 * builders' "no-op" contract). */
export interface ToggleLineCommentResult {
  edits: TextEdit[];
  selections: Selection[];
}

/**
 * Build the edit batch for `editor.action.toggleLineComment` (Req 11.1):
 * if EVERY target line is already commented, remove each one's marker (and
 * exactly one following space, if present — the mirror of what commenting
 * inserts, so toggling twice round-trips exactly); otherwise, comment every
 * target line that ISN'T already commented (leaving already-commented
 * lines alone, so re-toggling a partially-commented block converges to
 * "fully commented" in one step, matching mainstream editors). Every edit
 * lands at a distinct line, so they never overlap and need no
 * `dropOverlapping` pass; the whole batch is meant to be applied inside one
 * `document.transaction` for a single undo step.
 */
export function buildToggleLineCommentResult(
  reader: LineReader,
  selections: readonly Selection[],
  marker: string,
): ToggleLineCommentResult {
  const lines = targetLines(selections);
  const allCommented = lines.every((line) => isLineCommented(reader.getLine(line), marker));

  const edits: TextEdit[] = lines.map((line): TextEdit => {
    const text = reader.getLine(line);
    if (allCommented) {
      const indentLength = text.length - text.trimStart().length;
      const afterMarker = indentLength + marker.length;
      const hasSpace = text[afterMarker] === " ";
      return {
        range: {
          start: { line, character: indentLength },
          end: { line, character: hasSpace ? afterMarker + 1 : afterMarker },
        },
        newText: "",
      };
    }
    const indentLength = text.length - text.trimStart().length;
    const at = { line, character: indentLength };
    return { range: { start: at, end: at }, newText: `${marker} ` };
  });

  // Already-commented lines contribute no edit when commenting (they stay
  // untouched) — filter those out rather than emitting a no-op edit.
  const activeEdits = allCommented ? edits : edits.filter((_, i) => !isLineCommented(reader.getLine(lines[i]!), marker));

  const selectionsOut = mergeSelections(
    selections.map((selection) => transformSelection(selection, activeEdits)),
  );

  return { edits: activeEdits, selections: selectionsOut };
}
