/**
 * The document/text-buffer surface (Req 5, design.md §7).
 */

import type { Event, TextEdit, Uri } from "./primitives";

/** Line-ending style. Detected on load (first occurrence wins, default
 * `"\n"`) and preserved on save (Req 5.1). */
export type Eol = "\n" | "\r\n";

/**
 * The inclusive 0-based line range touched by one `applyEdits` call —
 * `startLine` is the lowest edit's start line, `endLine` the highest
 * edit's end line, both taken over the edits as given (pre-application
 * coordinates). Lets a view re-render only the affected lines instead of
 * the whole buffer (Req 13.1, design.md §7.1's "rendering sync").
 */
export interface DirtyRange {
  startLine: number;
  endLine: number;
  /**
   * Net change in the document's line count produced by the batch
   * (post-edit count minus pre-edit count). When non-zero, every line
   * below `endLine` has shifted by this amount, so a view that repaints
   * only `startLine..endLine` must also invalidate everything below —
   * without this a multi-line insert or delete would leave stale rows on
   * screen (design.md §7.1's "rendering sync").
   */
  lineCountDelta: number;
}

/**
 * Fired on `Document.onDidChange` after a call to `applyEdits` completes.
 * Carries the edits that were applied (in the form actually committed, i.e.
 * already validated) and the document's new version, so listeners such as
 * the syntax-highlight service can apply incremental updates instead of
 * re-scanning the whole buffer (design.md §10).
 *
 * `dirtyRange` is the touched line span, for view implementations that
 * only need to know *where* to re-render (design.md §7.1). `inverseEdits`
 * is the edit batch that undoes `edits` — one inverse per edit, in the
 * same order — consumed by the `UndoStack` (Req 5.4, Task 1.8) and
 * available to any other listener that needs to reconstruct the prior
 * text without re-reading the whole document.
 */
export interface DocumentChangeEvent {
  document: Document;
  edits: TextEdit[];
  version: number;
  dirtyRange: DirtyRange;
  inverseEdits: TextEdit[];
}

/**
 * A single open text document. Every open file (and unsaved/untitled
 * buffer) is represented as one `Document`, synchronized to the renderer by
 * the core (Req 5.1).
 *
 * `applyEdits` is the *only* mutation path (Req 5.2) — there is no
 * `setText`, no direct buffer access, and no other way to change a
 * document's content. This keeps undo/redo and change notification
 * centralized in the core.
 */
export interface Document {
  /** The document's resource identifier. */
  uri: Uri;
  /** The language ID resolved for this document (e.g. `"typescript"`,
   * `"plaintext"` when no language matches — Req 8.3). */
  languageId: string;
  /** Monotonically increasing version number, bumped on every applied
   * edit. */
  version: number;
  /** Whether the document has unsaved changes. */
  dirty: boolean;
  /** Whether the document rejects edits (e.g. files over 10 MB are opened
   * read-only — Req 5.5). */
  readonly: boolean;
  /** Line-ending style used when saving this document. */
  eol: Eol;

  /**
   * Apply one or more edits atomically. This is the only way to modify a
   * document's content (Req 5.2). Edits are validated, applied bottom-up,
   * and recorded on the undo stack; the call bumps `version` and fires
   * exactly one `onDidChange` event. On a `readonly` document this
   * surfaces a status-bar error and does nothing (design.md §14).
   */
  applyEdits(edits: TextEdit[]): void;

  /**
   * Group every `applyEdits` call made inside `fn` into a single undo step
   * (Req 5.4), so extensions can perform multi-step edits (e.g. "toggle
   * comment on N lines") that undo/redo as one operation.
   */
  transaction(fn: () => void): void;

  /** Fired after each `applyEdits` call completes (Req 5.3). */
  onDidChange: Event<DocumentChangeEvent>;
}
