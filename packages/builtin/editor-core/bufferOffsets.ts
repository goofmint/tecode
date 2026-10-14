/**
 * The line↔offset mapping `clipboard.ts` and `multiCursor.ts` both need to
 * treat the document as one flat string (Qodana `DuplicatedCode`: each
 * carried a byte-identical private copy, each justifying it in TSDoc as
 * "no cross-module coupling beyond what's actually shared" — but the thing
 * actually shared turned out to be the whole helper).
 *
 * This is `editor-core`'s own mapping rather than `@tecode/core`'s
 * `LineBuffer.offsetAt`/`positionAt`: `packages/builtin/**` may not import
 * `@tecode/core` (the ESLint layering rule), and a full-buffer scan here is
 * only paid on an explicit copy/cut or ctrl+d press, never per keystroke.
 */

import type { Position } from "@tecode/api";
import type { LineReader } from "./movement";

/**
 * Join every line of the document into one string with the offset each line
 * starts at. `lineStarts[i]` is line `i`'s first character's offset into
 * `text`; lines are joined with `"\n"` regardless of the document's actual
 * EOL — callers only ever compare offsets computed through this module, so
 * the join character need not match the document's real line endings, only
 * be self-consistent.
 */
export function readBuffer(reader: LineReader): { text: string; lineStarts: number[] } {
  const lines: string[] = [];
  const lineStarts: number[] = [];
  let offset = 0;
  for (let i = 0; i < reader.lineCount; i++) {
    const line = reader.getLine(i);
    lineStarts.push(offset);
    lines.push(line);
    offset += line.length + 1;
  }
  return { text: lines.join("\n"), lineStarts };
}

/** Convert `position` to an offset into {@link readBuffer}'s `text`. */
export function toOffset(position: Position, lineStarts: readonly number[]): number {
  return lineStarts[position.line]! + position.character;
}
