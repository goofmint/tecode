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
  TextEdit,
  Uri,
} from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import { createLineBuffer } from "./lineBuffer";

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
 * Build a `Document` (Req 5.1). `applyEdits` is the sole mutation path
 * (Req 5.2): it validates and applies through the internal
 * {@link LineBuffer}, then bumps `version` and fires exactly one
 * `onDidChange` per call (Req 5.3). On a `readonly` document it reports
 * through `sink.error` instead, guarded so a broken sink can never make
 * `applyEdits` throw (matching the registry's `notifySafely` pattern).
 */
export function createDocument(options: CreateDocumentOptions): Document {
  const { uri, languageId, text, sink, log } = options;
  const readonlyFlag = options.readonly ?? false;
  const eol = detectEol(text);
  const buffer = createLineBuffer(text, eol);

  let version = 0;
  let dirty = false;
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

  function applyEdits(edits: TextEdit[]): void {
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
    // Minimal passthrough for this task: `applyEdits` calls made inside
    // `fn` each still fire their own `onDidChange` and undo entry. Undo
    // grouping (one undo step per transaction) lands with the UndoStack
    // in Task 1.8 (Req 5.4, design.md §7.1).
    fn();
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

  const document: Document = {
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
