/**
 * `EditorState` (design.md §8.3's per-tab editor state) and
 * {@link useLineTicks}, the `EditorView` hook that turns a document's
 * `onDidChange`/`dirtyRange` events into a per-line "this line's rendered
 * output is stale" signal (Req 13.1's "render cost ∝ viewport" and dirty
 * line ranges) — the mechanism `editorView.tsx` uses to memoize each
 * visible line's row so an edit re-renders only the lines it actually
 * touched.
 */

import { useEffect, useReducer, useRef } from "react";
import type { Selection, Uri } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";

/**
 * One tab's editing state (design.md §8.3): which document it shows, the
 * cursor(s)/selection(s), and the current scroll offset. `selections` is a
 * first-class array from day one (Req 6.6, 11.1 — multi-cursor editing);
 * `selections[0]` is always the *primary* cursor, the one that drives
 * `revealLine` scrolling (design.md §8.3).
 */
export interface EditorState {
  documentUri: Uri;
  /** Always has at least one entry — a document with no selections is not
   * representable (there is always at least a collapsed cursor somewhere). */
  selections: Selection[];
  scrollTop: number;
}

/** A single-cursor {@link EditorState} at the document origin (line 0,
 * character 0) — the state a freshly opened tab starts in. */
export function createInitialEditorState(documentUri: Uri): EditorState {
  const origin = { line: 0, character: 0 };
  return {
    documentUri,
    selections: [{ start: origin, end: origin, anchor: origin, active: origin }],
    scrollTop: 0,
  };
}

/** What {@link useLineTicks} returns. */
export interface LineTicks {
  /** Bumps on every `onDidChange` this hook has observed — a plain
   * "something changed" counter `EditorView` can put in its own dependency
   * arrays; the interesting, per-line signal is {@link getLineTick}. */
  documentTick: number;
  /** This line's current revision number. Two calls for the same `line`
   * return the same number until a document change touches that line (or
   * shifts it — see this module's TSDoc on `lineCountDelta`), so a memoized
   * line component keyed on this value only re-renders when it actually
   * needs to. Lines never observed by an `onDidChange` yet (including every
   * line before the first change) all read as `0`. */
  getLineTick(line: number): number;
}

/**
 * Subscribes to `document.onDidChange` (following `shell.tsx`'s
 * `useSlotViews` subscription pattern: subscribe in an effect, then force
 * one extra render right after subscribing to close the
 * render-before-subscribe race — a change landing in that gap must not be
 * lost) and turns each event's `dirtyRange` into per-line revision bumps
 * (Req 13.1, design.md §8.3):
 *
 * - Every line in `[startLine, endLine]` (inclusive — `dirtyRange`'s own
 *   convention, design.md §7.1) gets a fresh, bumped tick: its rendered
 *   content is definitely stale.
 * - When `lineCountDelta` is non-zero (a multi-line insert/delete changed
 *   the document's line count), every previously observed line *below*
 *   `endLine` has physically moved to a new index — the tick tracked under
 *   its old index is carried over to `oldIndex + lineCountDelta` rather
 *   than just bumped in place, so a line whose *content* didn't change
 *   (just its position) keeps comparing equal to what it showed before at
 *   its OLD index, while whatever tick was previously recorded at its NEW
 *   index (a different line, before the shift) is superseded — forcing that
 *   now-stale row to re-render even though this hook never "bumped" the new
 *   index directly.
 *
 * Isolates listener exceptions the same way `document.ts`'s own `emit` does
 * (a throwing subscriber elsewhere must not break this hook, and this
 * hook's own reducer dispatch cannot throw), and disposes the subscription
 * on unmount/document change.
 */
export function useLineTicks(document: CoreDocument | undefined): LineTicks {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const ticksRef = useRef<Map<number, number>>(new Map());
  const documentTickRef = useRef(0);

  useEffect(() => {
    if (!document) return undefined;
    const sub = document.onDidChange((event) => {
      const { startLine, endLine, lineCountDelta } = event.dirtyRange;
      const ticks = ticksRef.current;

      if (lineCountDelta !== 0) {
        const shifted = new Map<number, number>();
        for (const [line, tick] of ticks) {
          if (line < startLine) {
            shifted.set(line, tick);
          } else if (line > endLine) {
            shifted.set(line + lineCountDelta, tick);
          }
          // Lines within [startLine, endLine] are dropped here — every one
          // of them gets a fresh bump below regardless of what it held
          // before.
        }
        ticks.clear();
        for (const [line, tick] of shifted) ticks.set(line, tick);
      }

      for (let line = startLine; line <= endLine; line++) {
        ticks.set(line, (ticks.get(line) ?? 0) + 1);
      }

      documentTickRef.current += 1;
      forceRender();
    });
    // Close the subscribe-after-render race — see this module's TSDoc
    // (matches shell.tsx's useSlotViews).
    forceRender();
    return () => sub.dispose();
  }, [document]);

  return {
    documentTick: documentTickRef.current,
    getLineTick: (line: number) => ticksRef.current.get(line) ?? 0,
  };
}
