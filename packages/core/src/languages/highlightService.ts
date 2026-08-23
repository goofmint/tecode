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
import { createLineBuffer } from "../buffer/lineBuffer";
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

  /** Recompute `state.lineSpans` from `tree`'s current captures — called
   * after every (re)parse. Multi-line captures are split per-line
   * (`buffer/lineBuffer.ts`'s `positionAt` already gives `{ line,
   * character }` boundaries; a capture spanning lines N..M contributes one
   * `HighlightSpan` to each). */
  function recomputeLineSpans(state: DocState, assets: LanguageAssets, text: string): void {
    const buf = createLineBuffer(text || "\n", "\n");
    const captures = assets.query.captures(state.tree!);
    const lineSpans = new Map<number, HighlightSpan[]>();
    for (const capture of captures) {
      const start = buf.positionAt(capture.startIndex);
      const end = buf.positionAt(capture.endIndex);
      for (let line = start.line; line <= end.line; line++) {
        const lineLength = buf.getLine(line).length;
        const startCol = line === start.line ? start.character : 0;
        const endCol = line === end.line ? end.character : lineLength;
        if (endCol <= startCol) continue;
        const existing = lineSpans.get(line);
        const span: HighlightSpan = { startCol, endCol, capture: capture.name };
        if (existing) existing.push(span);
        else lineSpans.set(line, [span]);
      }
    }
    state.lineSpans = lineSpans;
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
    parseDocument(uri, document, state, assets);
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
    for (const state of states.values()) state.documentSub?.dispose();
    states.clear();
    listeners.clear();
  }

  return { getSpansForLine, onDidChange, dispose };
}
