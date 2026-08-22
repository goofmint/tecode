/**
 * `Document`: the core's implementation of the `@tecode/api` `Document`
 * interface (Req 5, design.md §7.1). Wraps a {@link LineBuffer} with
 * version/dirty tracking, EOL detection, readonly enforcement, and the
 * `onDidChange` event.
 */

import type {
  Disposable,
  Document,
  DocumentChangeEvent,
  Eol,
  Listener,
  Selection,
  TextEdit,
  Uri,
} from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import { createSystemClock, type Clock } from "./clock";
import { createLineBuffer } from "./lineBuffer";
import { createUndoStack, type TypingCoalesceHint } from "./undoStack";

/** Dependencies and initial state for {@link createDocument}. */
export interface CreateDocumentOptions {
  /** The document's resource identifier. */
  uri: Uri;
  /** The language ID resolved for this document (Req 8.3). */
  languageId: string;
  /** The document's initial text content, as read from disk (or empty for
   * an untitled buffer). */
  text: string;
  /** Whether the document rejects edits — set by the caller when, e.g., a
   * file is over the 10 MB threshold (Req 5.5). Defaults to `false`. */
  readonly?: boolean;
  /** Where readonly-rejection errors are surfaced (design.md §14). */
  sink: StatusSink;
  /** Structured log for error/warning bookkeeping (design.md §14). */
  log: HostLog;
  /** Time source for the undo stack's typing-coalescing window (Req 5.4).
   * Defaults to {@link createSystemClock}; tests inject a fake, advanceable
   * clock (mirrors the `sink`/`log` injection pattern). */
  clock?: Clock;
}

/** Extra, optional per-call bookkeeping for {@link CoreDocument.applyEdits}
 * (design.md §7.1's `applyEdits(edits, opts?: { undoGroup?: string })`).
 * Not part of the public `@tecode/api` `Document.applyEdits` signature —
 * an extra optional parameter is assignment-compatible with it, so
 * `CoreDocument` still satisfies `Document`. */
export interface ApplyEditsOptions {
  /** Group this call's undo entry with other calls sharing the same id
   * (set internally by `transaction`, or supplied directly by a caller
   * that wants finer control). Bypasses typing coalescing entirely. */
  undoGroup?: string;
  /** Selections before this edit, restored on `undo()`. Defaults to `[]`
   * when omitted. */
  selectionsBefore?: Selection[];
  /** Selections after this edit, restored on `redo()`. Defaults to `[]`
   * when omitted. */
  selectionsAfter?: Selection[];
}

/**
 * The concrete document shape core builds and hands to the rest of the
 * host — `Document` (`@tecode/api`) plus the undo/redo entry points and
 * the extended `applyEdits` those callers need but extensions never see
 * (Req 5.4, design.md §7.1). `packages/api` is intentionally left
 * unchanged: `applyEdits`'s extra `opts` parameter is optional, so this
 * interface still structurally satisfies `Document`.
 */
export interface CoreDocument extends Document {
  applyEdits(edits: TextEdit[], opts?: ApplyEditsOptions): void;
  /**
   * Undo the most recent undo-stack entry: applies its inverse edits
   * through the internal `LineBuffer` (bypassing the undo-recording path
   * — this must not push a new undo entry or clear the redo stack),
   * bumps `version`, fires one `onDidChange`, and moves the
   * freshly-recomputed redo batch onto the redo stack. Returns the
   * entry's `selectionsBefore` so the caller can restore the caret;
   * `undefined` on an empty undo stack (silent no-op).
   */
  undo(): Selection[] | undefined;
  /** The redo counterpart to {@link CoreDocument.undo}. Returns the
   * entry's `selectionsAfter`; `undefined` on an empty redo stack. */
  redo(): Selection[] | undefined;
  /**
   * The document's full current text, joined with `eol` (design.md §7.2:
   * `DocumentManager.save` needs this to write the file). Internal to
   * core — not part of the public `@tecode/api` `Document` — since
   * extensions read text via `LineBuffer`-shaped accessors, not a bulk
   * getter.
   */
  getText(): string;
  /**
   * Mark the document as saved: clears `dirty` without touching `version`
   * and fires no `onDidChange` (Req 5.5, design.md §7.2 — `save` clears
   * `dirty` once the write+rename succeeds). Internal to core; called by
   * `DocumentManager.save`, never exposed to extensions.
   */
  markSaved(): void;
}

/**
 * Detect a text's EOL style: first line-break occurrence wins — `"\r\n"`
 * if the first break is `"\r\n"`, `"\n"` if it's a bare `"\n"`, and `"\n"`
 * by default when the text has no line breaks at all (Req 5.1).
 */
function detectEol(text: string): Eol {
  const match = /\r\n|\n/.exec(text);
  return match ? (match[0] as Eol) : "\n";
}

/** The inclusive 0-based line range touched by an edit batch, in
 * pre-application coordinates. The caller adds `lineCountDelta` (measured
 * around the actual buffer mutation) to complete the `DirtyRange`. */
function dirtyRangeOf(edits: readonly TextEdit[]): { startLine: number; endLine: number } {
  let startLine = edits[0]!.range.start.line;
  let endLine = edits[0]!.range.end.line;
  for (const edit of edits) {
    if (edit.range.start.line < startLine) startLine = edit.range.start.line;
    if (edit.range.end.line > endLine) endLine = edit.range.end.line;
  }
  return { startLine, endLine };
}

/**
 * Whether `edits` is a single, plain single-character insert (collapsed
 * range, one-character `newText`, not a line break) — the only shape
 * eligible for typing coalescing (Req 5.4). Anything else (multi-edit
 * batches, deletes/replaces, multi-character inserts like paste, and
 * newline inserts) returns `undefined`, which `UndoStack.push` treats as
 * "not a coalescing candidate".
 */
function typingHintFor(edits: readonly TextEdit[]): TypingCoalesceHint | undefined {
  if (edits.length !== 1) return undefined;
  const { range, newText } = edits[0]!;
  if (range.start.line !== range.end.line || range.start.character !== range.end.character) {
    return undefined;
  }
  if (newText.length !== 1 || newText === "\n" || newText === "\r") return undefined;
  return { line: range.start.line, insertedAt: range.start };
}

/**
 * Build a `Document` (Req 5.1) — concretely, a {@link CoreDocument}.
 * `applyEdits` is the sole mutation path (Req 5.2): it validates and
 * applies through the internal {@link LineBuffer}, then bumps `version`
 * and fires exactly one `onDidChange` per call (Req 5.3), recording the
 * batch on the internal `UndoStack` (Req 5.4). On a `readonly` document it
 * reports through `sink.error` instead, guarded so a broken sink can never
 * make `applyEdits` throw (matching the registry's `notifySafely`
 * pattern).
 */
export function createDocument(options: CreateDocumentOptions): CoreDocument {
  const { uri, languageId, text, sink, log } = options;
  const readonlyFlag = options.readonly ?? false;
  const eol = detectEol(text);
  const buffer = createLineBuffer(text, eol);
  const clock = options.clock ?? createSystemClock();
  const undoStack = createUndoStack({ clock });

  let version = 0;
  let dirty = false;
  let transactionGroupId: string | undefined;
  let nextTransactionId = 0;
  const listeners = new Set<Listener<DocumentChangeEvent>>();

  /** Guarded `sink.error` — a broken/throwing sink must not make
   * `applyEdits` itself throw (design.md §14, matching registry.ts's
   * `notifySafely`). */
  function notifySafely(err: HostError): void {
    try {
      sink.error(err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go.
    }
  }

  /** Guarded `log.append` — same rationale as {@link notifySafely}. */
  function logSafely(err: HostError): void {
    try {
      log.append("error", err);
    } catch {
      // Swallowed — see notifySafely.
    }
  }

  function emit(event: DocumentChangeEvent): void {
    // Snapshot before iterating: a listener that disposes itself (or
    // another listener) mid-dispatch must not perturb this loop
    // (keymap/context.ts's onDidChange pattern).
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (cause) {
        // Isolate listener failures: one throwing listener must not stop
        // the remaining listeners or propagate out of applyEdits().
        logSafely({
          message: `Document onDidChange listener threw: ${describeError(cause)}`,
          path: uri,
        });
      }
    }
  }

  function applyEdits(edits: TextEdit[], opts?: ApplyEditsOptions): void {
    if (readonlyFlag) {
      notifySafely({
        message: `Cannot apply edits: document is read-only: ${uri}`,
        path: uri,
      });
      return;
    }
    if (edits.length === 0) return;

    // Validation/overlap/bounds errors from the buffer are programmer
    // errors (Req 5.2) — let them propagate uncaught, without bumping
    // version or firing an event.
    const lineCountBefore = buffer.lineCount;
    const applied = buffer.applyEdits(edits);

    version += 1;
    dirty = true;
    const { startLine, endLine } = dirtyRangeOf(edits);
    const inverseEdits = applied.map((a) => a.inverse);

    // An explicit `opts.undoGroup` wins over an enclosing `transaction`;
    // otherwise fall back to the transaction's group, if any (Req 5.4).
    const groupId = opts?.undoGroup ?? transactionGroupId;
    undoStack.push({
      inverseEdits,
      selectionsBefore: opts?.selectionsBefore ?? [],
      selectionsAfter: opts?.selectionsAfter ?? [],
      groupId,
      // Transaction-grouped entries never coalesce with typing, so there
      // is no point computing a hint for them.
      typing: groupId === undefined ? typingHintFor(edits) : undefined,
    });

    emit({
      document,
      edits: [...edits],
      version,
      dirtyRange: {
        startLine,
        endLine,
        lineCountDelta: buffer.lineCount - lineCountBefore,
      },
      inverseEdits,
    });
  }

  function transaction(fn: () => void): void {
    // Every `applyEdits` call inside `fn` still fires its own
    // `onDidChange` (unchanged from before this task), but they now share
    // one undo-stack group id so the whole transaction undoes/redoes as a
    // single step (Req 5.4, design.md §7.1). Nested `transaction` calls
    // reuse the outer group rather than opening a new one. The group is
    // closed in `finally` so a throwing `fn` still leaves the document in
    // a consistent state for the next call.
    const isOutermost = transactionGroupId === undefined;
    if (isOutermost) {
      transactionGroupId = `txn-${nextTransactionId++}`;
    }
    try {
      fn();
    } finally {
      if (isOutermost) {
        transactionGroupId = undefined;
      }
    }
  }

  /** Apply `edits` through the `LineBuffer` and fire the matching
   * `onDidChange`, WITHOUT recording anything on the undo stack — shared
   * by {@link undo} and {@link redo}, which record the recomputed
   * opposite-direction batch themselves via `UndoStack.recordRedo`/
   * `recordUndo`. */
  function applyWithoutRecording(edits: TextEdit[]): TextEdit[] {
    const lineCountBefore = buffer.lineCount;
    const applied = buffer.applyEdits(edits);

    version += 1;
    dirty = true;
    const { startLine, endLine } = dirtyRangeOf(edits);
    const inverseEdits = applied.map((a) => a.inverse);

    emit({
      document,
      edits: [...edits],
      version,
      dirtyRange: {
        startLine,
        endLine,
        lineCountDelta: buffer.lineCount - lineCountBefore,
      },
      inverseEdits,
    });

    return inverseEdits;
  }

  function undo(): Selection[] | undefined {
    const popped = undoStack.undo();
    if (!popped) return undefined;
    // Applying `popped.inverseEdits` through the LineBuffer returns their
    // own inverses, in the buffer's now-current (post-undo) coordinates —
    // exactly the batch that would redo this step. Naively moving
    // `popped` itself onto the redo stack would be wrong: replaying its
    // `inverseEdits` a second time would undo again, not redo.
    const redoEdits = applyWithoutRecording(popped.inverseEdits);
    undoStack.recordRedo({
      inverseEdits: redoEdits,
      selectionsBefore: popped.selectionsBefore,
      selectionsAfter: popped.selectionsAfter,
      groupId: popped.groupId,
    });
    return popped.selectionsBefore;
  }

  function redo(): Selection[] | undefined {
    const popped = undoStack.redo();
    if (!popped) return undefined;
    const undoEdits = applyWithoutRecording(popped.inverseEdits);
    undoStack.recordUndo({
      inverseEdits: undoEdits,
      selectionsBefore: popped.selectionsBefore,
      selectionsAfter: popped.selectionsAfter,
      groupId: popped.groupId,
    });
    return popped.selectionsAfter;
  }

  function getText(): string {
    return buffer.getText();
  }

  function markSaved(): void {
    dirty = false;
  }

  function onDidChange(listener: Listener<DocumentChangeEvent>): Disposable {
    listeners.add(listener);
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        listeners.delete(listener);
      },
    };
  }

  const document: CoreDocument = {
    uri,
    languageId,
    get version() {
      return version;
    },
    get dirty() {
      return dirty;
    },
    get readonly() {
      return readonlyFlag;
    },
    eol,
    applyEdits,
    transaction,
    onDidChange,
    undo,
    redo,
    getText,
    markSaved,
  };

  return document;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches registry.ts's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}
