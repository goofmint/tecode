/**
 * Core, dependency-free primitive types shared across the `@tecode/api`
 * surface. These are intentionally LSP-compatible (0-based line/character
 * positions) so that `offsetAt`/`positionAt`-style mapping and a future
 * language server integration require no shape changes (design.md §7,
 * §18 "Deferred Design Concerns").
 */

/**
 * A zero-based position in a document, expressed as a line number and a
 * character offset (in UTF-16 code units) within that line. Matches the
 * LSP `Position` shape.
 */
export interface Position {
  /** Zero-based line number. */
  line: number;
  /** Zero-based character offset within the line. */
  character: number;
}

/**
 * A half-open range between two positions: `[start, end)`. Matches the LSP
 * `Range` shape.
 */
export interface Range {
  start: Position;
  end: Position;
}

/**
 * A text selection: a {@link Range} plus the anchor/active endpoints needed
 * to render carets and support multiple cursors (Req 6.6). `anchor` is
 * where the selection began; `active` is where the caret currently sits
 * (they are equal for a collapsed selection/cursor).
 */
export interface Selection extends Range {
  anchor: Position;
  active: Position;
}

/**
 * A single text replacement over a {@link Range}. `applyEdits(edits:
 * TextEdit[])` is the *only* document mutation path (Req 5.2) — every
 * insert, delete, and replace in the editor is expressed as one or more
 * `TextEdit`s.
 */
export interface TextEdit {
  range: Range;
  newText: string;
}

/**
 * Opaque identifier for a resource, represented as a URI string (typically
 * `file://...`). Kept as a plain string alias — rather than a branded or
 * structured type — to stay LSP-compatible and dependency-free.
 */
export type Uri = string;

/**
 * A handle returned by any registration or subscription method in the API.
 * Calling `dispose()` undoes the registration (unregisters a command,
 * removes an event listener, closes a file watcher, ...). Extensions
 * typically push these into `ExtensionContext.subscriptions` so the host
 * can dispose them all on deactivation (design.md §4.2).
 */
export interface Disposable {
  dispose(): void;
}

/** A callback subscribed to an {@link Event}. */
export type Listener<T> = (e: T) => void;

/**
 * A subscribable event. Calling the event with a {@link Listener} registers
 * it and returns a {@link Disposable} that removes it again — the same
 * pattern used throughout the API for `onDidChange`, `onDidOpen`, and
 * friends.
 */
export type Event<T> = (listener: Listener<T>) => Disposable;
