/**
 * `HighlightService` (Req 8.1-8.3; design.md §10, §14; pattern: `ui/
 * findService.ts`): the syntax-highlighting pipeline. Tracks every open
 * document (subscribing on `documents.onDidOpen`, cleaning up on
 * `onDidClose`), keeps a tree-sitter parse tree per non-plaintext document
 * incrementally in sync with its `onDidChange` edits, and serves per-line
 * capture spans to `EditorView` (`ui/editorView.tsx`'s `buildLineRuns`
 * extension point).
 *
 * **`"plaintext"` bypasses the pipeline entirely** (design.md §10, Req
 * 8.3): a document whose `languageId` is `"plaintext"` (the language
 * registry's fallback for an unmatched extension, `languageRegistry.ts`)
 * gets no per-document state beyond a bare "nothing to highlight" marker —
 * no grammar load, no `onDidChange` subscription, no tree. The exact same
 * bypass permanently applies to any OTHER language whose grammar or
 * highlight-query load fails (this module's "Failure degradation" below):
 * from that point on, every document of that language is treated
 * identically to a genuinely plaintext one.
 *
 * **Per-language asset cache**: the first document opened for a given
 * (non-plaintext) language id kicks off that language's grammar-WASM +
 * `.scm`-query load (via the injected {@link AssetResolver}) and
 * tree-sitter compile (via the injected {@link ParserBackend}); the
 * resulting `{ language, query }` pair is cached and reused by every OTHER
 * document of the same language, including ones opened while the first
 * load is still in flight (the cache stores the in-flight `Promise`
 * itself, not just its settled result, so concurrent opens never trigger a
 * second load).
 *
 * **Incremental edits** (design.md §10's "applies incremental `tree.edit()`
 * on each `DocumentChangeEvent`, re-parses"): `handleChange` converts each
 * `TextEdit` in a `DocumentChangeEvent` into a {@link ParserEditDescriptor}
 * using `buffer/lineBuffer.ts`'s `offsetAt` against the document's
 * PRE-EDIT text (cached from the previous parse/edit round as
 * `DocState.lastText`) — never the live, already-mutated document, since
 * `TextEdit.range` is specified in pre-batch coordinates
 * (`document.ts`'s `applyEdits`: "applied bottom-up... earlier splices
 * never invalidate the positions of edits still to come"). Edits within
 * one batch are applied to the tree in the SAME bottom-up order (sorted
 * descending by start position) the buffer itself used: because batch
 * edits never overlap, every edit processed after the first is entirely
 * ABOVE (earlier than) the ones already applied, so its pre-batch offsets
 * remain valid against the tree's already-shifted state — no edit's
 * offsets ever need to be recomputed against a partially-edited buffer.
 * After every edit in the batch has been applied to the tree, one fresh
 * `backend.parse(text, oldTree)` call (passing the document's actual
 * CURRENT text) produces the new tree — real tree-sitter's incremental
 * reparse then only re-parses the ranges tree-sitter itself determined
 * changed, but the RESULT is defined to be identical to a fresh parse of
 * the same text (this module's differential test).
 *
 * **Ranged span recompute** (Req 13.1's 16ms typing budget): after the
 * incremental re-parse, spans are recomputed ONLY for the affected line
 * range — the edits' own lines UNIONed with tree-sitter's
 * `changedRanges(oldTree, newTree)` (which catches cascading recolors,
 * e.g. an unterminated template literal recoloring the rest of the file),
 * expanded to whole lines — via a range-restricted `query.captures()`
 * call, and spliced into the cached per-line map (untouched lines keep
 * their cached spans, shifted by the batch's line delta where lines were
 * inserted/deleted). See {@link spliceLineSpans} for the full mechanics
 * and trap analysis. The initial parse on document open still runs the
 * full-document pass; so does any edit on a backend without
 * `changedRanges` (every hand-rolled minimal mock in this module's
 * tests). Differential guarantee, enforced by tests at both the mock
 * level (`highlightService.test.ts`) and against the real
 * grammar/backend (`packages/cli`'s
 * `highlightIncremental.e2e.test.ts`): after ANY edit, every line's
 * `getSpansForLine` result is identical to a fresh full recompute of the
 * same final text.
 *
 * **Failure degradation** (design.md §14's "Grammar WASM fails to load ->
 * Language degrades to `plaintext`, one-time warning"): a `warnedLanguages`
 * `Set<languageId>` — the first grammar/`.scm`-query load failure for a
 * language logs+notifies exactly once (guarded, never throws) and caches
 * `undefined` as that language's "assets" forever after, so every
 * subsequent document open (or edit, though edits never re-trigger a load
 * at all — see above) of that language silently gets no highlighting, with
 * no repeat warning, ever again for the life of this service instance.
 */

import type { Disposable, DocumentChangeEvent, Event, Listener, TextEdit, Uri } from "@tecode/api";
import type { CoreDocument } from "../buffer/document";
import type { DocumentManager } from "../buffer/documentManager";
import { createLineBuffer, type LineBuffer } from "../buffer/lineBuffer";
import { comparePositions } from "../editor/positionTransform";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import type { AssetResolver } from "./assetResolver";
import { PLAINTEXT_LANGUAGE_ID, type LanguageRegistry } from "./languageRegistry";
import {
  createWebTreeSitterParserBackend,
  type ParserBackend,
  type ParserLanguageHandle,
  type ParserQuery,
  type ParserTree,
} from "./parserBackend";

/** One highlighted span within a single document line — the shape
 * `EditorView`'s `buildLineRuns` merges into its selection/cursor/find
 * overlay (`ui/editorView.tsx`). `startCol`/`endCol` are UTF-16
 * code-unit columns (half-open `[startCol, endCol)`, matching
 * `Position.character`); `capture` is the `.scm` query's capture name
 * (e.g. `"function"`, `"function.builtin"`), resolved to a style via
 * `themeLoader.ts`'s `resolveCaptureStyle` longest-prefix fallback. */
export interface HighlightSpan {
  startCol: number;
  endCol: number;
  capture: string;
}

/** One language's loaded, ready-to-query assets — cached per language id
 * (this module's TSDoc's "Per-language asset cache"). */
interface LanguageAssets {
  language: ParserLanguageHandle;
  query: ParserQuery;
}

/** Per-document tracked state. */
interface DocState {
  languageId: string;
  /** `true` once this document is (permanently) treated as plaintext —
   * either its `languageId` genuinely IS `"plaintext"`, or its language's
   * assets failed to load (this module's TSDoc's "Failure degradation").
   * A bypassed document has no `onDidChange` subscription and
   * `getSpansForLine` always returns `[]` for it. */
  bypass: boolean;
  documentSub?: Disposable;
  /** This document's language's loaded assets, once its (shared,
   * per-language) load has settled successfully — `undefined` while still
   * loading OR after a failed load (in the latter case `bypass` is also
   * `true`; this stays `undefined` rather than caching the failure locally
   * too, since {@link getOrLoadLanguageAssets}'s own cache is already the
   * single source of truth for "did this language's load fail"). */
  assets?: LanguageAssets;
  tree?: ParserTree;
  /** The text this document's `tree` currently reflects — the "pre-edit"
   * snapshot `handleChange` computes each `TextEdit`'s offsets against
   * (this module's TSDoc). Updated to the document's current text after
   * every successful parse. */
  lastText: string;
  /** Per-line highlight spans, rebuilt on every (re)parse. `undefined`
   * until the first parse for this document has settled (grammar still
   * loading, or about to fail) — `getSpansForLine` reads `[]` in that
   * window, same as a bypassed document. */
  lineSpans?: Map<number, HighlightSpan[]>;
}

/** Dependencies for {@link createHighlightService}. */
export interface HighlightServiceDeps {
  /** Tracks every open document (this module's TSDoc). Narrowed to a
   * `Pick` (matches `findService.ts`'s `FindServiceDeps` narrowing) so a
   * test can inject a minimal fake `DocumentManager`. */
  documents: Pick<DocumentManager, "onDidOpen" | "onDidClose" | "documents">;
  /** Resolves a document's `languageId` to its `LanguageContribution` +
   * owning extension directory (`languageRegistry.ts`). */
  languageRegistry: Pick<LanguageRegistry, "getLanguage" | "getBaseDir">;
  /** Reads a language's grammar WASM / `.scm` query text
   * (`assetResolver.ts`). */
  assetResolver: Pick<AssetResolver, "resolveGrammar" | "resolveHighlights">;
  /** The tree-sitter adapter (`parserBackend.ts`). Defaults to
   * {@link createWebTreeSitterParserBackend}'s real `web-tree-sitter`-backed
   * implementation; every test injects a hand-rolled mock instead (this
   * module's TSDoc: "ALL tests use hand-rolled mock backends"). */
  backend?: ParserBackend;
  /** Structured log for grammar/query load failures (design.md §14). Same
   * DI shape as `documentManager.ts`'s `DocumentManagerDeps`. */
  log: HostLog;
  /** Where the one-time "language degraded to plaintext" warning is
   * surfaced (design.md §14). */
  sink: StatusSink;
}

/** The highlight service's public surface (Req 8.1-8.3). */
export interface HighlightService {
  /** Every current highlight span on `line` of the document at `uri` — `[]`
   * for an unknown uri, a bypassed (plaintext or degraded) document, a
   * document whose language is still loading, or a line with no captures.
   * Never throws. */
  getSpansForLine(uri: Uri, line: number): readonly HighlightSpan[];
  /** Fires whenever ANY tracked document's spans change (a parse settling,
   * an incremental reparse after an edit) — a line-invalidation signal, not
   * a diff: a consumer re-fetches whatever `getSpansForLine` calls it
   * needs. Carries no payload, same "just re-render/re-check" shape as
   * `ThemeRegistry.onDidChange`/`FindService.onDidChange`. */
  onDidChange: Event<void>;
  /**
   * Resolves once every per-language asset load that is currently tracked
   * (in-flight OR already settled) in {@link getOrLoadLanguageAssets}'s
   * cache has settled — added for Finding 3 of Issue #35's PR review: `cli`'s
   * headless exit path (`main.ts`'s `runTecode`) needs to know grammar/
   * highlight loading has genuinely finished (successfully, or via the
   * one-time degradation warning — this module's TSDoc's "Failure
   * degradation") before it reports `HostLog` counts or exits, rather than
   * racing the fire-and-forget load `documents.onDidOpen`'s handler kicks
   * off and never itself awaits (this module's TSDoc's "Per-language asset
   * cache"). Safe to call, and await, unconditionally: the underlying
   * per-language promise never rejects (a load failure is caught
   * internally by {@link getOrLoadLanguageAssets} and warned exactly once),
   * so this can never reject either. Only a snapshot at call time — a load
   * that starts AFTER this is called (e.g. a document opened later) is not
   * covered; headless mode's single up-front `openDocument` call means
   * that's never an issue there.
   */
  whenIdle(): Promise<void>;
  /** Unsubscribe from `documents` and every tracked document, and clear
   * all `onDidChange` listeners. Idempotent. */
  dispose(): void;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches every other module's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Build a {@link HighlightService} (Req 8.1-8.3, design.md §10, §14). */
export function createHighlightService(deps: HighlightServiceDeps): HighlightService {
  const { documents, languageRegistry, assetResolver, log, sink } = deps;
  const backend = deps.backend ?? createWebTreeSitterParserBackend();

  const states = new Map<Uri, DocState>();
  const languageAssets = new Map<string, Promise<LanguageAssets | undefined>>();
  const warnedLanguages = new Set<string>();
  const listeners = new Set<Listener<void>>();
  let disposed = false;

  function fireChange(): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener(undefined);
      } catch {
        // Isolate listener failures — matches every other `onDidChange` in
        // this codebase.
      }
    }
  }

  /** Guarded `log.append`/`sink.error` (matches `documentManager.ts`'s
   * `logSafely`/`notifySafely`) — a broken log/sink must never break the
   * pipeline it's reporting on. */
  function reportSafely(err: HostError): void {
    try {
      log.append("warning", err);
    } catch {
      // Swallowed — reporting a reporting failure has nowhere left to go.
    }
    try {
      sink.error(err);
    } catch {
      // Swallowed — see above.
    }
  }

  /** Warn exactly once per language (this module's TSDoc's "Failure
   * degradation") — every load attempt for a language beyond the first
   * shares the SAME cached `Promise` ({@link loadLanguageAssets}'s caller),
   * so this only ever actually runs once per language id regardless of how
   * many documents/edits arrive for it. */
  function warnOnce(languageId: string, cause: unknown): void {
    if (warnedLanguages.has(languageId)) return;
    warnedLanguages.add(languageId);
    reportSafely({
      message: `Language "${languageId}" failed to load its grammar/highlights; highlighting is disabled for it (falling back to plaintext): ${describeError(cause)}`,
    });
  }

  /** Load+compile one language's assets (grammar WASM + `.scm` query),
   * caching the in-flight/settled `Promise` itself so concurrent opens of
   * the same language share one load (this module's TSDoc). `undefined`
   * on any failure — warned exactly once ({@link warnOnce}) — or when the
   * language isn't actually registered (a `resolveLanguageId` match with
   * no backing `getLanguage` entry should not happen in practice, and is
   * silently treated as "nothing to highlight", not a reportable
   * failure). */
  function getOrLoadLanguageAssets(languageId: string): Promise<LanguageAssets | undefined> {
    const cached = languageAssets.get(languageId);
    if (cached) return cached;

    const load = (async (): Promise<LanguageAssets | undefined> => {
      const contribution = languageRegistry.getLanguage(languageId);
      if (!contribution) return undefined;
      const baseDir = languageRegistry.getBaseDir(languageId);
      try {
        await backend.init();
        const grammarBytes = await assetResolver.resolveGrammar(contribution.grammar, baseDir);
        const language = await backend.loadLanguage(grammarBytes);
        const highlightsSource = await assetResolver.resolveHighlights(contribution.highlights, baseDir);
        const query = backend.compileQuery(language, highlightsSource);
        return { language, query };
      } catch (cause) {
        warnOnce(languageId, cause);
        return undefined;
      }
    })();
    languageAssets.set(languageId, load);
    return load;
  }

  /** Per-line start offset table for one `recomputeLineSpans` call —
   * `starts[i]` is line `i`'s own UTF-16 offset into `buf.getText()`.
   * Built in one O(line count) pass over `buf` so every capture below
   * resolves its line via {@link findLineForOffset}'s O(log line count)
   * binary search instead of `LineBuffer.positionAt`'s O(line count) linear
   * scan from the document start (this module's Finding, below). Mirrors
   * `lineBuffer.ts`'s own `positionAtIn`: each line separator counts as
   * exactly one UTF-16 code unit, matching `buf`'s hardcoded `"\n"` `eol`
   * (`recomputeLineSpans`'s own `createLineBuffer(text || "\n", "\n")`
   * below) regardless of the document's real line endings — so `starts`
   * reproduces the exact same (CRLF-naive) offset math `buf.positionAt`
   * always has, not a stricter one. */
  function buildLineStarts(buf: LineBuffer): number[] {
    const starts: number[] = new Array(buf.lineCount);
    starts[0] = 0;
    for (let i = 1; i < buf.lineCount; i++) {
      starts[i] = starts[i - 1]! + buf.getLine(i - 1).length + 1;
    }
    return starts;
  }

  /** The last line index `i` with `lineStarts[i] <= offset` — binary search
   * over the strictly-increasing table {@link buildLineStarts} produces
   * (same technique as `parserBackend.ts`'s own `findLineForOffset` over
   * its byte-offset index). `lineStarts` always has at least one entry
   * (`[0]`, line 0 always exists), so this never runs on an empty array. */
  function findLineForOffset(lineStarts: readonly number[], offset: number): number {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** `character - lineStart`, clamped into `[0, lineLength]` — matches
   * `lineBuffer.ts`'s `positionAtIn`'s own clamping (an offset can only
   * ever land at or before a line's own EOL character, never past it). */
  function clampColumn(character: number, lineLength: number): number {
    return Math.max(0, Math.min(character, lineLength));
  }

  /**
   * Recompute `state.lineSpans` from `tree`'s current captures — called
   * after every (re)parse. Multi-line captures are split per-line (a
   * capture spanning lines N..M contributes one `HighlightSpan` to each).
   *
   * **Finding (measured on a 10,000-line file, `typingBenchmark.test.ts`):**
   * this used to call `LineBuffer.positionAt` — `lineBuffer.ts`'s
   * `positionAtIn`, an O(line count) linear scan from line 0 — TWICE per
   * capture. A generated 10,000-line file produces ~60,000 captures per
   * keystroke, so that was ~60,000 × 2 × O(10,000) ≈ 1.2 billion scan steps
   * per keystroke (median ≈ 7.0-7.6s, p95 ≈ 7.2-8.2s against a 16ms
   * target), even though `query.captures()` itself and tree-sitter's
   * incremental `parse()` were both already cheap (~350-400ms and ~4-5ms
   * respectively). The fix: build the {@link buildLineStarts} offset table
   * ONCE per recompute (O(line count) total, not per capture) and resolve
   * each capture's line via {@link findLineForOffset}'s O(log line count)
   * binary search instead. (A later fix went further still: edits no
   * longer take this full pass at all — see {@link spliceLineSpans} — so
   * this function now runs only for a document's initial parse and for
   * backends without `changedRanges`.)
   *
   * **Why not just use `capture.startPosition`/`endPosition` directly**
   * (`ParserCapture` already carries `{ row, column }` points computed by
   * the real backend): those points are resolved against tree-sitter's own
   * `\r\n|\n`-aware line split, not against `buf`'s hardcoded single-UTF-16-
   * unit `"\n"` `eol` assumption above — using them directly would give a
   * DIFFERENT (arguably more correct, but different) answer for CRLF
   * documents than this function has always returned, and every hand-rolled
   * mock `ParserBackend` in `highlightService.test.ts` fabricates
   * placeholder positions it never bothered to keep accurate (since nothing
   * read them before). Resolving purely from `capture.startIndex`/
   * `endIndex` against `buf`'s own offset table keeps this function's
   * output bit-for-bit identical to before, for both real and mock
   * backends.
   */
  function recomputeLineSpans(state: DocState, assets: LanguageAssets, text: string): void {
    const buf = createLineBuffer(text || "\n", "\n");
    const lineStarts = buildLineStarts(buf);
    const captures = assets.query.captures(state.tree!);
    const lineSpans = new Map<number, HighlightSpan[]>();
    for (const capture of captures) {
      appendCaptureSpans(lineSpans, capture, lineStarts, buf, 0, buf.lineCount - 1);
    }
    state.lineSpans = lineSpans;
  }

  /** Split one capture into per-line {@link HighlightSpan}s and append them
   * to `lineSpans` — but ONLY for the capture's lines within `[fromLine,
   * toLine]`. The full recompute ({@link recomputeLineSpans}) passes the
   * whole document as the window; the ranged recompute
   * ({@link spliceLineSpans}) passes just its dirty line range, which is
   * both what makes it cheap AND what makes tree-sitter's superset-shaped
   * ranged query results safe (`ParserQuery.captures`'s TSDoc: a ranged
   * query returns every capture INTERSECTING the range — including ones
   * starting before it — and possibly extra captures outside it entirely;
   * clamping the written lines to the dirty window means an intersecting
   * capture updates exactly its dirty lines while its untouched lines keep
   * their cached spans, and an entirely-outside capture writes nothing).
   * Extracted from `recomputeLineSpans`'s old inline body so both paths
   * share one bit-for-bit identical span computation (the differential
   * tests' baseline requirement). */
  function appendCaptureSpans(
    lineSpans: Map<number, HighlightSpan[]>,
    capture: { name: string; startIndex: number; endIndex: number },
    lineStarts: readonly number[],
    buf: LineBuffer,
    fromLine: number,
    toLine: number,
  ): void {
    const startLine = findLineForOffset(lineStarts, capture.startIndex);
    const endLine = findLineForOffset(lineStarts, capture.endIndex);
    const from = Math.max(startLine, fromLine);
    const to = Math.min(endLine, toLine);
    for (let line = from; line <= to; line++) {
      const lineLength = buf.getLine(line).length;
      const startCol = line === startLine ? clampColumn(capture.startIndex - lineStarts[startLine]!, lineLength) : 0;
      const endCol = line === endLine ? clampColumn(capture.endIndex - lineStarts[endLine]!, lineLength) : lineLength;
      if (endCol <= startCol) continue;
      const existing = lineSpans.get(line);
      const span: HighlightSpan = { startCol, endCol, capture: capture.name };
      if (existing) existing.push(span);
      else lineSpans.set(line, [span]);
    }
  }

  /**
   * The ranged, per-edit replacement for a full {@link recomputeLineSpans}
   * pass (Req 13.1: per-keystroke highlight cost proportional to the EDIT,
   * not the document — measured, the full pass's `query.captures()` over
   * ~60,000 captures was ~350-400ms per keystroke on a 10,000-line file,
   * see `typingBenchmark.test.ts`): recompute spans ONLY for the dirty
   * line range, splicing the result into the cached per-line map. `false`
   * when the ranged path can't run (backend without
   * {@link ParserBackend.changedRanges}, no cached spans yet, or an empty
   * edit batch) — the caller then falls back to the full pass.
   *
   * **The dirty range** (in NEW-text line numbers) is the UNION of:
   *
   * 1. The edits' own extent: from the topmost edit's start line (identical
   *    in old and new coordinates — every other edit in the batch is
   *    strictly below it, and edits below a line never renumber it) down to
   *    the bottommost edit's OLD end line shifted by the batch's total line
   *    delta (lines below every edit shift by exactly that total).
   * 2. Tree-sitter's own changed ranges between the edited old tree and the
   *    re-parsed new tree ({@link ParserBackend.changedRanges}) — the
   *    robust catch for captures whose extent GROWS beyond the edited lines
   *    (the classic trap: typing the opening backtick of an unterminated
   *    template literal recolors the rest of the file; the edit itself is
   *    one character, but the changed ranges cover everything recolored).
   *
   * ...expanded to whole lines (the recompute always covers full lines, so
   * `getSpansForLine` output for a dirty line is complete, not partial).
   *
   * **Line-shift bookkeeping**: cached spans for lines ABOVE the dirty
   * range keep their keys; lines BELOW it (old line > the dirty range's
   * old-coordinate end) shift by the batch's line delta; dirty lines are
   * dropped and rebuilt from a ranged `captures()` call. When the delta is
   * 0 (the plain-character-typing steady state) the existing map is
   * updated IN PLACE — deleting just the dirty keys — instead of copying
   * all ~O(line count) entries (measured ~3.7ms per copy on a 10,000-line
   * file, a fifth of the whole 16ms budget).
   */
  function spliceLineSpans(
    state: DocState,
    assets: LanguageAssets,
    text: string,
    sortedEdits: readonly TextEdit[],
    oldLineCount: number,
    oldTree: ParserTree,
  ): boolean {
    const previous = state.lineSpans;
    if (!backend.changedRanges || !previous || sortedEdits.length === 0) return false;

    const buf = createLineBuffer(text || "\n", "\n");
    const lineStarts = buildLineStarts(buf);
    const lineDelta = buf.lineCount - oldLineCount;

    let dirtyStart = Number.MAX_SAFE_INTEGER;
    let editsOldEnd = -1;
    for (const edit of sortedEdits) {
      dirtyStart = Math.min(dirtyStart, edit.range.start.line);
      editsOldEnd = Math.max(editsOldEnd, edit.range.end.line);
    }
    let dirtyEnd = Math.max(dirtyStart, editsOldEnd + lineDelta);

    for (const range of backend.changedRanges(oldTree, state.tree!)) {
      dirtyStart = Math.min(dirtyStart, findLineForOffset(lineStarts, range.startIndex));
      dirtyEnd = Math.max(dirtyEnd, findLineForOffset(lineStarts, range.endIndex));
    }
    dirtyStart = Math.max(0, Math.min(dirtyStart, buf.lineCount - 1));
    dirtyEnd = Math.max(dirtyStart, Math.min(dirtyEnd, buf.lineCount - 1));
    // The dirty range's bottom in OLD line numbers — the last old line
    // whose cached spans must be dropped rather than kept/shifted.
    const dirtyEndOld = dirtyEnd - lineDelta;

    let next: Map<number, HighlightSpan[]>;
    if (lineDelta === 0) {
      // In-place: only the dirty keys change (this function's TSDoc).
      next = previous;
      for (let line = dirtyStart; line <= dirtyEnd; line++) next.delete(line);
    } else {
      next = new Map<number, HighlightSpan[]>();
      for (const [line, spans] of previous) {
        if (line < dirtyStart) next.set(line, spans);
        else if (line > dirtyEndOld) next.set(line + lineDelta, spans);
        // Lines within [dirtyStart, dirtyEndOld] are dropped — rebuilt below.
      }
    }

    // Both `ParserRange` forms describe the same whole-line window
    // (`parserBackend.ts`'s `ParserRange` TSDoc: offsets for backends that
    // filter by offset — the test mocks — and points for the real backend,
    // which restricts by position only).
    const dirtyEndLineLength = buf.getLine(dirtyEnd).length;
    const captures = assets.query.captures(state.tree!, {
      startIndex: lineStarts[dirtyStart]!,
      endIndex: lineStarts[dirtyEnd]! + dirtyEndLineLength,
      startPosition: { row: dirtyStart, column: 0 },
      endPosition: { row: dirtyEnd, column: dirtyEndLineLength },
    });
    for (const capture of captures) {
      appendCaptureSpans(next, capture, lineStarts, buf, dirtyStart, dirtyEnd);
    }
    state.lineSpans = next;
    return true;
  }

  /** Run a full (non-incremental) parse for `document` against `assets` —
   * used both for a document's first parse (once its language's assets
   * settle) and as the reparse step after applying a batch of edits to the
   * existing tree (`handleChange`, this module's TSDoc's "Incremental
   * edits"). */
  function parseDocument(uri: Uri, document: CoreDocument, state: DocState, assets: LanguageAssets): void {
    const text = document.getText();
    state.tree = backend.parse(assets.language, text, state.tree);
    state.lastText = text;
    recomputeLineSpans(state, assets, text);
    fireChange();
  }

  function handleChange(uri: Uri, document: CoreDocument, event: DocumentChangeEvent): void {
    const state = states.get(uri);
    if (!state || state.bypass) return;
    const assets = state.assets;
    // Assets not ready yet (still loading, or this event raced the load's
    // own completion): nothing to incrementally edit against — once the
    // load settles, `attachDocument`'s own continuation runs a full parse
    // of the document's THEN-current text anyway, so this edit is not
    // lost, just folded into that first parse.
    if (!assets || !state.tree) return;

    const oldBuffer = createLineBuffer(state.lastText || "\n", "\n");
    // Bottom-up (descending start position) — matches `document.ts`'s own
    // `buffer.applyEdits` order, and is what makes every edit's pre-batch
    // offsets valid to apply in sequence (this module's TSDoc's
    // "Incremental edits").
    const sortedEdits = Array.from(event.edits).sort((a: TextEdit, b: TextEdit) =>
      comparePositions(b.range.start, a.range.start),
    );
    for (const edit of sortedEdits) {
      state.tree.edit({
        startIndex: oldBuffer.offsetAt(edit.range.start),
        oldEndIndex: oldBuffer.offsetAt(edit.range.end),
        insertedText: edit.newText,
        startPosition: { row: edit.range.start.line, column: edit.range.start.character },
        oldEndPosition: { row: edit.range.end.line, column: edit.range.end.character },
      });
    }

    // Re-parse incrementally, then recompute spans for ONLY the dirty line
    // range when the backend supports it ({@link spliceLineSpans}), falling
    // back to the full-document pass otherwise — the initial parse on
    // document open always takes the full pass ({@link parseDocument}).
    const oldTree = state.tree;
    const text = document.getText();
    state.tree = backend.parse(assets.language, text, oldTree);
    state.lastText = text;
    try {
      if (!spliceLineSpans(state, assets, text, sortedEdits, oldBuffer.lineCount, oldTree)) {
        recomputeLineSpans(state, assets, text);
      }
    } finally {
      // Dispose the OLD tree now that both the ranged splice (which still
      // needs it, for `backend.changedRanges(oldTree, state.tree!)`) and
      // the full-recompute fallback have run — in `finally` so a thrown
      // exception from either path can never leak it (Req 13.1 finding:
      // `web-tree-sitter`'s `Tree#delete` frees WASM memory immediately;
      // relying on GC alone lets it grow unboundedly under per-keystroke
      // re-parses). `backend.parse` above always hands back a NEW tree
      // object distinct from `oldTree` (real tree-sitter's own `parse`
      // never mutates/reuses the old tree in place — only `oldTree.edit()`
      // does, which already happened above), so this never disposes the
      // tree `state.tree` still points at; the equality guard exists only
      // for a hypothetical backend/mock that reused the same object.
      if (oldTree !== state.tree) oldTree.dispose?.();
    }
    fireChange();
  }

  function attachDocument(document: CoreDocument): void {
    const uri = document.uri;
    if (states.has(uri)) return;
    const languageId = document.languageId;

    if (languageId === PLAINTEXT_LANGUAGE_ID) {
      states.set(uri, { languageId, bypass: true, lastText: "" });
      return;
    }

    const state: DocState = { languageId, bypass: false, lastText: document.getText() };
    states.set(uri, state);

    void getOrLoadLanguageAssets(languageId).then((assets) => {
      if (disposed || states.get(uri) !== state) return; // Closed/detached before the load settled.
      if (!assets) {
        state.bypass = true;
        return;
      }
      state.assets = assets;
      // Subscribe to live edits now, only once assets are actually ready —
      // an edit landing before this point is folded into this first parse
      // below (`document.getText()` already reflects it).
      state.documentSub = document.onDidChange((event) => handleChange(uri, document, event));
      parseDocument(uri, document, state, assets);
    });
  }

  function detachDocument(uri: Uri): void {
    const state = states.get(uri);
    if (!state) return;
    state.documentSub?.dispose();
    // Free this document's tree immediately rather than waiting on GC
    // (this module's TSDoc / `parserBackend.ts`'s `ParserTree.dispose`
    // TSDoc, Req 13.1 finding).
    state.tree?.dispose?.();
    states.delete(uri);
  }

  // Pick up any document already open at construction time (this module's
  // TSDoc's "tracks ALL open documents" — mirrors `findService.ts`'s own
  // "cover a caller built after a document was already active" reasoning).
  for (const document of documents.documents) attachDocument(document);

  const openSub = documents.onDidOpen((document) => {
    if (!disposed) attachDocument(document);
  });
  const closeSub = documents.onDidClose((document) => {
    if (!disposed) detachDocument(document.uri);
  });

  function getSpansForLine(uri: Uri, line: number): readonly HighlightSpan[] {
    const state = states.get(uri);
    if (!state || state.bypass || !state.lineSpans) return [];
    return state.lineSpans.get(line) ?? [];
  }

  function onDidChange(listener: Listener<void>): Disposable {
    listeners.add(listener);
    let listenerDisposed = false;
    return {
      dispose() {
        if (listenerDisposed) return;
        listenerDisposed = true;
        listeners.delete(listener);
      },
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    openSub.dispose();
    closeSub.dispose();
    for (const state of states.values()) {
      state.documentSub?.dispose();
      // Same "free now, don't wait on GC" reasoning as `detachDocument`.
      state.tree?.dispose?.();
    }
    states.clear();
    listeners.clear();
  }

  function whenIdle(): Promise<void> {
    // `getOrLoadLanguageAssets`'s returned promise never rejects (its own
    // try/catch always resolves to `undefined` on failure — this
    // function's TSDoc), so no `.catch` is needed here either.
    return Promise.all(Array.from(languageAssets.values())).then(() => undefined);
  }

  return { getSpansForLine, onDidChange, whenIdle, dispose };
}
