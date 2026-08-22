/**
 * `LineBuffer`: the TypeScript-side line-array text store backing every
 * `Document` (Req 5.1, design.md §7.1 "TS-side line array — decision #1").
 * Lines are stored without their line terminators; the `Eol` supplied at
 * construction is used purely for offset math and for re-joining lines in
 * `getText()`.
 */

import type { Eol, Position, Range, TextEdit } from "@tecode/api";

/**
 * One edit as actually applied, paired with its inverse. The inverse's
 * range covers the text `edit` inserted (in the buffer's *post-edit*
 * coordinates) and its `newText` is the text `edit` replaced — applying
 * `inverse` restores exactly what was there before. Consumed by the
 * future `UndoStack` (Task 1.8, design.md §7.1's `AppliedEdit`).
 */
export interface AppliedEdit {
  /** The edit as validated and applied. */
  edit: TextEdit;
  /** The edit that undoes `edit`. */
  inverse: TextEdit;
}

/**
 * The line-array buffer itself (design.md §7.1). Built with
 * {@link createLineBuffer} rather than a class, per house convention.
 */
export interface LineBuffer {
  /** Number of lines currently in the buffer (always >= 1). */
  readonly lineCount: number;
  /** The text of line `n` (0-based), without its line terminator. Throws
   * `RangeError` if `n` is out of bounds. */
  getLine(n: number): string;
  /** The full buffer text, with lines rejoined using the buffer's
   * {@link Eol}. */
  getText(): string;
  /**
   * Apply one or more edits atomically (Req 5.2, design.md §7.1).
   *
   * Every edit's range is validated first (0-based, `start <= end`, and
   * within the buffer's current bounds — out-of-range or inverted ranges
   * are programmer errors and throw `RangeError`); then edit ranges are
   * checked for overlap (overlapping ranges throw `RangeError`; touching/
   * adjacent ranges are allowed). All validation happens before any
   * mutation, so a rejected batch never leaves the buffer half-edited.
   * Once validated, edits are applied bottom-up (sorted descending by
   * start position) so earlier splices never invalidate the positions of
   * edits still to come.
   *
   * Returns one {@link AppliedEdit} per input edit, in the same order as
   * `edits`, carrying the inverse needed to undo the whole batch.
   */
  applyEdits(edits: TextEdit[]): AppliedEdit[];
  /** Convert a `Position` to a 0-based UTF-16 code-unit offset into
   * `getText()`. Out-of-range input clamps to the nearest valid offset
   * (design.md §7.1's "future LSP mapping"). */
  offsetAt(pos: Position): number;
  /** The inverse of {@link offsetAt}. Out-of-range input clamps to the
   * nearest valid position. Mutual inverse of `offsetAt` for in-range
   * values, including CJK/astral (surrogate-pair) content, since both
   * operate in native UTF-16 code units and never split a surrogate
   * pair. */
  positionAt(offset: number): Position;
}

/** Split text into lines on any of `\r\n` or `\n`, dropping the
 * terminators (they're re-added by `eol` on join/offset math). */
function splitIntoLines(text: string): string[] {
  return text.split(/\r\n|\n/);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.character - b.character;
}

function validatePosition(lines: readonly string[], pos: Position): void {
  if (!Number.isInteger(pos.line) || pos.line < 0 || pos.line >= lines.length) {
    throw new RangeError(
      `Position line ${String(pos.line)} is out of range [0, ${lines.length})`,
    );
  }
  const lineText = lines[pos.line]!;
  if (
    !Number.isInteger(pos.character) ||
    pos.character < 0 ||
    pos.character > lineText.length
  ) {
    throw new RangeError(
      `Position character ${String(pos.character)} is out of range [0, ${lineText.length}] on line ${pos.line}`,
    );
  }
}

function validateRange(lines: readonly string[], range: Range): void {
  validatePosition(lines, range.start);
  validatePosition(lines, range.end);
  if (comparePositions(range.start, range.end) > 0) {
    throw new RangeError(
      `Range start ${JSON.stringify(range.start)} is after end ${JSON.stringify(range.end)}`,
    );
  }
}

/** Total UTF-16 code-unit length of `lines` joined by `eol` — equal to
 * `lines.join(eol).length`, computed without allocating the join. */
function totalLength(lines: readonly string[], eol: Eol): number {
  let length = 0;
  for (const line of lines) length += line.length;
  return length + eol.length * Math.max(0, lines.length - 1);
}

function offsetAtIn(lines: readonly string[], eol: Eol, pos: Position): number {
  const line = clamp(Math.trunc(pos.line) || 0, 0, lines.length - 1);
  const lineText = lines[line] ?? "";
  const character = clamp(Math.trunc(pos.character) || 0, 0, lineText.length);
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i]!.length + eol.length;
  return offset + character;
}

function positionAtIn(lines: readonly string[], eol: Eol, offset: number): Position {
  const max = totalLength(lines, eol);
  let remaining = clamp(Math.trunc(offset) || 0, 0, max);
  for (let line = 0; line < lines.length; line++) {
    const lineText = lines[line]!;
    if (remaining <= lineText.length) {
      return { line, character: remaining };
    }
    remaining -= lineText.length + eol.length;
    if (remaining < 0) {
      // The offset points inside the EOL sequence itself (the second code
      // unit of a CRLF): round forward to the start of the next line
      // rather than returning a negative character.
      return { line: line + 1, character: 0 };
    }
  }
  const lastLine = lines.length - 1;
  return { line: lastLine, character: lines[lastLine]?.length ?? 0 };
}

/** The text `range` covers in `lines`, joined with `eol` — extracted
 * range-locally so `applyEdits` never has to join the whole buffer just to
 * record replaced text (documents can be 10 MB and edits arrive per
 * keystroke). Equivalent to slicing `lines.join(eol)` between the range's
 * offsets. */
function sliceRange(lines: readonly string[], eol: Eol, range: Range): string {
  const { start, end } = range;
  if (start.line === end.line) {
    return lines[start.line]!.slice(start.character, end.character);
  }
  const parts = [lines[start.line]!.slice(start.character)];
  for (let i = start.line + 1; i < end.line; i++) parts.push(lines[i]!);
  parts.push(lines[end.line]!.slice(0, end.character));
  return parts.join(eol);
}

/** Splice `edit` into `lines` in place, using `edit.range` as coordinates
 * into the *current* state of `lines`. Safe to call repeatedly only when
 * processing edits bottom-up (descending by position), since a splice at
 * one position never shifts the line indices of positions above it. */
function spliceEdit(lines: string[], edit: TextEdit): void {
  const { start, end } = edit.range;
  const prefix = lines[start.line]!.slice(0, start.character);
  const suffix = lines[end.line]!.slice(end.character);
  const inserted = splitIntoLines(edit.newText);
  const replacement =
    inserted.length === 1
      ? [prefix + inserted[0] + suffix]
      : [prefix + inserted[0], ...inserted.slice(1, -1), inserted[inserted.length - 1] + suffix];
  lines.splice(start.line, end.line - start.line + 1, ...replacement);
}

/**
 * Build a `LineBuffer` over `text`, splitting it into lines up front
 * (Req 5.1, design.md §7.1). `eol` is the line-ending style detected by
 * the caller (typically `Document`'s load-time detection) — it does not
 * affect how `text` is split (any of `\r\n`/`\n` is accepted regardless
 * of `eol`), only how lines are rejoined and how offsets are computed.
 */
export function createLineBuffer(text: string, eol: Eol): LineBuffer {
  const lines: string[] = splitIntoLines(text);

  function getLine(n: number): string {
    if (!Number.isInteger(n) || n < 0 || n >= lines.length) {
      throw new RangeError(`Line ${String(n)} is out of range [0, ${lines.length})`);
    }
    return lines[n]!;
  }

  function getText(): string {
    return lines.join(eol);
  }

  function offsetAt(pos: Position): number {
    return offsetAtIn(lines, eol, pos);
  }

  function positionAt(offset: number): Position {
    return positionAtIn(lines, eol, offset);
  }

  function applyEdits(edits: TextEdit[]): AppliedEdit[] {
    if (edits.length === 0) return [];

    // Phase 1: validate every range against the buffer as it stands right
    // now, before any mutation — a bad edit anywhere in the batch must
    // reject the whole batch, never apply a prefix of it.
    for (const edit of edits) validateRange(lines, edit.range);

    // Phase 2: compute each edit's offsets (still against the pre-batch
    // buffer) and sort ascending to detect overlaps and to compute
    // prefix-sum deltas for the final (post-batch) inverse offsets.
    const items = edits.map((edit, index) => ({
      edit,
      index,
      startOffset: offsetAtIn(lines, eol, edit.range.start),
      endOffset: offsetAtIn(lines, eol, edit.range.end),
    }));
    // Order ties deterministically: at the same start offset, zero-length
    // inserts sort before longer edits (their text lands before the
    // replaced span in the final buffer), and equal-length edits keep
    // input order. Phase 4 mirrors this so application order matches the
    // final-offset bookkeeping.
    items.sort(
      (a, b) =>
        a.startOffset - b.startOffset ||
        (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset) ||
        a.index - b.index,
    );

    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1]!;
      const curr = items[i]!;
      if (curr.startOffset < prev.endOffset) {
        throw new RangeError(
          `Overlapping edits are not allowed: [${prev.startOffset}, ${prev.endOffset}) and [${curr.startOffset}, ${curr.endOffset})`,
        );
      }
    }

    // Phase 3: for each edit (ascending order), record the text it
    // replaces and the offset range its replacement will occupy in the
    // FINAL (post-batch) buffer — a simple running prefix-sum of length
    // deltas, since edits are non-overlapping and sorted by position.
    // `newText` as it will actually sit in the buffer: split on any line
    // break and rejoined with this buffer's eol, so its length matches the
    // final offset space even when the edit's line breaks differ from
    // `eol` (e.g. a "\n" insert into a "\r\n" buffer occupies one extra
    // code unit per line break).
    const insertedLength = (newText: string): number =>
      splitIntoLines(newText).join(eol).length;

    let cumulativeDelta = 0;
    const withFinal = items.map(({ edit, index, startOffset, endOffset }) => {
      const replaced = sliceRange(lines, eol, edit.range);
      const newLength = insertedLength(edit.newText);
      const finalStart = startOffset + cumulativeDelta;
      const finalEnd = finalStart + newLength;
      cumulativeDelta += newLength - (endOffset - startOffset);
      return { edit, index, startOffset, endOffset, replaced, finalStart, finalEnd };
    });

    // Phase 4: mutate `lines` bottom-up (descending by start offset) using
    // each edit's original Position range — safe because not-yet-applied
    // edits are always positioned strictly above (or touching) the one
    // just applied, so their line numbers are unaffected by this splice.
    // The exact reverse of Phase 2's order: at a shared start offset the
    // longer (replacing) edit applies before a zero-length insert — the
    // insert must land in front of the replacement's text, not be
    // overwritten by a replacement still using pre-insert coordinates —
    // and same-position inserts apply in reverse input order so the final
    // text keeps them in input order.
    const descending = [...withFinal].sort(
      (a, b) =>
        b.startOffset - a.startOffset ||
        (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset) ||
        b.index - a.index,
    );
    for (const { edit } of descending) spliceEdit(lines, edit);

    // Phase 5: `lines` now reflects the whole batch, so translate each
    // edit's final offsets into positions in that buffer to build its
    // inverse — result order matches the caller's `edits` order.
    const result: AppliedEdit[] = new Array(edits.length);
    for (const { edit, index, replaced, finalStart, finalEnd } of withFinal) {
      result[index] = {
        edit,
        inverse: {
          range: {
            start: positionAtIn(lines, eol, finalStart),
            end: positionAtIn(lines, eol, finalEnd),
          },
          newText: replaced,
        },
      };
    }
    return result;
  }

  return {
    get lineCount() {
      return lines.length;
    },
    getLine,
    getText,
    applyEdits,
    offsetAt,
    positionAt,
  };
}
