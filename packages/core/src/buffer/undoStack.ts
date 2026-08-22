/**
 * `UndoStack`: undo/redo bookkeeping for a `Document`, with transaction
 * grouping and typing coalescing (Req 5.4, design.md §7.1). Built with
 * {@link createUndoStack} rather than a class, per house convention.
 *
 * The stack itself never touches a `LineBuffer` or `Document` — it only
 * records and hands back `TextEdit` batches plus selection bookkeeping.
 * `Document` owns applying those batches (see `document.ts`'s `undo`/
 * `redo`), because only `Document` can turn "apply this batch" into the
 * *next* batch's inverse via `LineBuffer.applyEdits`'s `AppliedEdit`
 * return value.
 */

import type { Position, Selection, TextEdit } from "@tecode/api";
import type { Clock } from "./clock";

/** design.md §7.1's typing-coalescing window (Req 5.4): consecutive
 * single-character inserts on the same line, each starting exactly where
 * the previous one left off, merge into one undo entry as long as no gap
 * between them exceeds this many milliseconds. */
export const TYPING_COALESCE_WINDOW_MS = 750;

/**
 * One step on the undo or redo stack (design.md §7.1's `{ inverseEdits,
 * selectionsBefore, selectionsAfter, groupId }`).
 *
 * `inverseEdits` is direction-relative to whichever stack the entry sits
 * on: on the undo stack it is the batch that undoes the forward edit; on
 * the redo stack it is the batch that re-applies it. Both stacks share
 * this one shape because undoing/redoing is symmetric — see `undo`/`redo`
 * below.
 *
 * `inverseEdits` accumulates in most-recent-first order when entries
 * merge (grouping or coalescing): a later sub-edit's inverse is prepended
 * ahead of earlier ones'. This is purely documentary — `LineBuffer.
 * applyEdits` sorts a batch by position before applying it regardless of
 * array order — but it keeps the array's order legible: reading it
 * front-to-back matches the order in which undoing peels off the group's
 * edits (last typed/applied, first undone).
 */
export interface UndoEntry {
  inverseEdits: TextEdit[];
  selectionsBefore: Selection[];
  selectionsAfter: Selection[];
  groupId: string;
}

/**
 * Signal computed by the caller (`Document`) from the single edit it just
 * applied, describing whether — and where — it can coalesce with a
 * still-open typing run. Omit (pass `undefined` to {@link PushInput.typing})
 * for anything that isn't a plain single-character insert: multi-edit
 * batches, deletes, replaces, and multi-character inserts (e.g. paste)
 * are never coalescing candidates, so their presence/absence of a hint
 * *is* the "was this a single-character insertion?" signal — there is no
 * separate boolean.
 */
export interface TypingCoalesceHint {
  /** 0-based line the character landed on. */
  line: number;
  /** Where the character was inserted, i.e. the edit's (collapsed)
   * `range.start`. Compared against the previous coalescable entry's
   * post-insert position to confirm this insert exactly continues it
   * (cursor didn't move in between). */
  insertedAt: Position;
}

/** Input to {@link UndoStack.push}. */
export interface PushInput {
  /** The batch's inverse edits (undoes what was just applied). */
  inverseEdits: TextEdit[];
  /** Selections before the edit, restored on undo. Defaults are the
   * caller's responsibility — pass `[]` when unknown. */
  selectionsBefore: Selection[];
  /** Selections after the edit, restored on redo. */
  selectionsAfter: Selection[];
  /**
   * Explicit group id from `Document.transaction` — every `applyEdits`
   * call inside the same transaction passes the same id, and pushes with
   * a matching id merge into one entry instead of creating a new one.
   * Undefined for ordinary (non-transaction) edits.
   */
  groupId?: string;
  /**
   * Coalescing signal for a single-character insert (see
   * {@link TypingCoalesceHint}). Ignored (treated as not coalescable)
   * whenever `groupId` is set — transaction-grouped entries never
   * coalesce with typing, by design.
   */
  typing?: TypingCoalesceHint;
}

/** Dependencies for {@link createUndoStack}. */
export interface UndoStackDeps {
  /** Time source for the typing-coalescing window — inject a fake clock
   * in tests instead of depending on real elapsed time. */
  clock: Clock;
}

/** The undo/redo bookkeeping service itself. */
export interface UndoStack {
  /**
   * Record a just-applied edit batch (Req 5.4). Merges into the current
   * top-of-undo-stack entry when `input.groupId` matches its group, or
   * when `input.typing` continues an open typing run within
   * {@link TYPING_COALESCE_WINDOW_MS}; otherwise pushes a new entry.
   * Always clears the redo stack — any newly recorded forward edit
   * invalidates whatever was previously redoable, merge or not.
   */
  push(input: PushInput): void;
  /**
   * Pop the top undo entry, if any. Does **not** touch the redo stack —
   * pair with {@link UndoStack.recordRedo} once the caller has applied
   * the returned batch and recomputed the edits that would redo it (see
   * this module's top-level TSDoc for why the entry can't just be moved
   * over verbatim). Returns `undefined` on an empty stack; never throws.
   */
  undo(): UndoEntry | undefined;
  /** Push a freshly computed entry onto the redo stack, without clearing
   * it — the counterpart to {@link UndoStack.undo}. */
  recordRedo(entry: UndoEntry): void;
  /** Pop the top redo entry, if any — the counterpart to
   * {@link UndoStack.recordRedo}. Returns `undefined` on an empty stack;
   * never throws. */
  redo(): UndoEntry | undefined;
  /** Push a freshly computed entry onto the undo stack, without clearing
   * the redo stack — the counterpart to {@link UndoStack.redo}. */
  recordUndo(entry: UndoEntry): void;
}

/** Per-undo-entry bookkeeping kept alongside it, used only to decide
 * whether the *next* push can coalesce into it. Never exposed outside
 * this module. */
interface CoalesceState {
  line: number;
  /** The position right after the most recently merged character —
   * i.e. where the next character must land to continue this run. */
  positionAfter: Position;
  /** `clock.now()` at the most recent merge into this entry. */
  pushedAt: number;
}

interface StackFrame {
  entry: UndoEntry;
  /** Present only while this entry is still open to typing coalescing —
   * `undefined` for transaction-grouped entries and for any entry once a
   * later push has closed it out. */
  coalesce: CoalesceState | undefined;
}

function positionsEqual(a: Position, b: Position): boolean {
  return a.line === b.line && a.character === b.character;
}

function coalesceStateFor(typing: TypingCoalesceHint, pushedAt: number): CoalesceState {
  return {
    line: typing.line,
    positionAfter: { line: typing.insertedAt.line, character: typing.insertedAt.character + 1 },
    pushedAt,
  };
}

/**
 * Build an `UndoStack` (Req 5.4, design.md §7.1). Grouping/coalescing
 * decisions are made here from the hints `Document.applyEdits` supplies;
 * this module never inspects a `LineBuffer` or reads document text.
 */
export function createUndoStack(deps: UndoStackDeps): UndoStack {
  const { clock } = deps;
  const undoEntries: StackFrame[] = [];
  const redoEntries: StackFrame[] = [];
  let nextGroupId = 0;

  function canCoalesce(top: StackFrame | undefined, typing: TypingCoalesceHint): boolean {
    if (!top?.coalesce) return false;
    const { coalesce } = top;
    return (
      coalesce.line === typing.line &&
      positionsEqual(coalesce.positionAfter, typing.insertedAt) &&
      clock.now() - coalesce.pushedAt <= TYPING_COALESCE_WINDOW_MS
    );
  }

  function push(input: PushInput): void {
    const { inverseEdits, selectionsBefore, selectionsAfter, groupId, typing } = input;
    // Any new forward progress invalidates whatever was previously
    // redoable, whether this push merges into an existing entry or opens
    // a new one.
    redoEntries.length = 0;

    const top = undoEntries[undoEntries.length - 1];

    if (groupId !== undefined) {
      if (top && top.entry.groupId === groupId) {
        top.entry.inverseEdits = [...inverseEdits, ...top.entry.inverseEdits];
        top.entry.selectionsAfter = [...selectionsAfter];
        // Transaction boundary: this entry never coalesces with typing,
        // even if it merged in place of opening a new frame.
        top.coalesce = undefined;
        return;
      }
      undoEntries.push({
        entry: {
          inverseEdits: [...inverseEdits],
          selectionsBefore: [...selectionsBefore],
          selectionsAfter: [...selectionsAfter],
          groupId,
        },
        coalesce: undefined,
      });
      return;
    }

    if (typing && canCoalesce(top, typing)) {
      const frame = top!;
      frame.entry.inverseEdits = [...inverseEdits, ...frame.entry.inverseEdits];
      frame.entry.selectionsAfter = [...selectionsAfter];
      frame.coalesce = coalesceStateFor(typing, clock.now());
      return;
    }

    undoEntries.push({
      entry: {
        inverseEdits: [...inverseEdits],
        selectionsBefore: [...selectionsBefore],
        selectionsAfter: [...selectionsAfter],
        groupId: `undo-${nextGroupId++}`,
      },
      coalesce: typing ? coalesceStateFor(typing, clock.now()) : undefined,
    });
  }

  function undo(): UndoEntry | undefined {
    return undoEntries.pop()?.entry;
  }

  function recordRedo(entry: UndoEntry): void {
    redoEntries.push({ entry, coalesce: undefined });
  }

  function redo(): UndoEntry | undefined {
    return redoEntries.pop()?.entry;
  }

  function recordUndo(entry: UndoEntry): void {
    undoEntries.push({ entry, coalesce: undefined });
  }

  return { push, undo, recordRedo, redo, recordUndo };
}
