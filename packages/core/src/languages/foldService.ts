/**
 * `FoldService` (Issue #150) — the code-folding counterpart to
 * `highlightService.ts`: it tracks every open document, keeps a tree-sitter
 * parse tree per non-plaintext document in sync with that document's
 * `onDidChange` edits, and serves the document's foldable line ranges
 * ({@link FoldRange}) to `ui/editorView.tsx` and `ui/foldController.ts`.
 *
 * **Deliberately a SECOND, independent service, not an extension of
 * `HighlightService`**: folding and highlighting have different
 * granularities (whole lines vs. columns), different query files
 * (`<lang>.folds.scm` vs. `<lang>.scm`), different failure consequences (a
 * broken fold query must never cost a document its syntax colors), and
 * different consumers. Mirroring `HighlightService`'s lifecycle rather than
 * reaching into it keeps this feature's blast radius to this one file plus
 * its own wiring, which is the same reasoning `findService.ts`/
 * `highlightService.ts` are already separately injected into `EditorView`
 * for.
 *
 * **`"plaintext"`, and any language with no `folds` declaration, bypass the
 * pipeline entirely** — no grammar load, no `onDidChange` subscription, no
 * tree; {@link FoldService.getFoldRanges} reports the shared empty array for
 * them forever. The same permanent bypass applies to any language whose
 * grammar or fold-query load/compile fails (warned exactly once, then
 * treated as "this language has no folds"), so a malformed `.scm` degrades
 * folding alone and leaves highlighting untouched.
 *
 * **Whole-document requery, deliberately**: unlike `highlightService.ts`'s
 * `spliceLineSpans` dirty-range optimization, an edit here re-runs the fold
 * query over the whole tree. Fold captures are per-CONTAINER (a handful per
 * file, not the ~60,000-per-keystroke `highlightService.ts` measured), and a
 * container's end row moves whenever anything inside it grows or shrinks —
 * so a dirty-range splice would have to re-examine most of the results
 * anyway for a fraction of the saving.
 */

import type { Disposable, DocumentChangeEvent, Event, FoldRange, Listener, TextEdit, Uri } from "@tecode/api";
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

/** A shared, permanently-empty ranges array — what {@link FoldService.getFoldRanges}
 * returns for a bypassed/not-yet-parsed document. Its identity is
 * load-bearing the same way `highlightService.ts`'s `EMPTY_SPANS` is: a
 * caller may compare references to decide whether anything changed. */
const EMPTY_RANGES: readonly FoldRange[] = [];

/** One language's loaded, ready-to-query fold assets. */
interface FoldLanguageAssets {
  language: ParserLanguageHandle;
  query: ParserQuery;
}

/** Per-document tracked state (mirrors `highlightService.ts`'s `DocState`). */
interface FoldDocState {
  languageId: string;
  /** `true` once this document is (permanently) treated as unfoldable:
   * plaintext, a language with no `folds` declaration, or a language whose
   * assets failed to load. */
  bypass: boolean;
  documentSub?: Disposable;
  assets?: FoldLanguageAssets;
  tree?: ParserTree;
  /** The text this document's `tree` currently reflects — the pre-edit
   * snapshot each `TextEdit`'s offsets are computed against. */
  lastText: string;
  /** Fold ranges from the most recent parse. `undefined` until the first
   * parse settles. */
  ranges?: readonly FoldRange[];
}

/** Dependencies for {@link createFoldService}. */
export interface FoldServiceDeps {
  documents: Pick<DocumentManager, "onDidOpen" | "onDidClose" | "documents">;
  languageRegistry: Pick<LanguageRegistry, "getLanguage" | "getBaseDir">;
  assetResolver: Pick<AssetResolver, "resolveGrammar" | "resolveFolds">;
  /** The tree-sitter adapter (`parserBackend.ts`). Defaults to the real
   * `web-tree-sitter`-backed implementation; tests inject a mock, exactly
   * as `highlightService.ts`'s own tests do. */
  backend?: ParserBackend;
  log: HostLog;
  sink: StatusSink;
}

/** The fold service's public surface (Issue #150) — a mirror of
 * {@link HighlightService}'s own shape. */
export interface FoldService {
  /**
   * Every foldable region of `uri`'s current text, in document order
   * (outermost regions first, since tree-sitter yields captures in tree
   * order). Empty for an unknown/bypassed document, and for one whose
   * first parse has not settled yet.
   *
   * **Reference stability**: the returned array is only ever a NEW array
   * when this document's fold ranges actually changed, so a caller may
   * compare references to skip work.
   */
  getFoldRanges(uri: Uri): readonly FoldRange[];
  /** Fires after any document's fold ranges are recomputed. Carries no
   * payload — same coarse shape as `HighlightService.onDidChange`. */
  onDidChange: Event<void>;
  /** Resolves once every language asset load started so far has settled —
   * the test/startup seam `HighlightService.whenIdle` provides. */
  whenIdle(): Promise<void>;
  dispose(): void;
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches every other module's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Whether `a` and `b` hold the same ranges in the same order — the guard
 * that keeps {@link FoldService.getFoldRanges}' reference-stability contract
 * meaningful across a re-parse that changed nothing foldable (every
 * keystroke inside a function body, say). */
function rangesEqual(a: readonly FoldRange[], b: readonly FoldRange[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startLine !== b[i]!.startLine || a[i]!.endLine !== b[i]!.endLine) return false;
  }
  return true;
}

/** Build a {@link FoldService} (Issue #150). */
export function createFoldService(deps: FoldServiceDeps): FoldService {
  const { documents, languageRegistry, assetResolver, log, sink } = deps;
  const backend = deps.backend ?? createWebTreeSitterParserBackend();

  const states = new Map<Uri, FoldDocState>();
  const languageAssets = new Map<string, Promise<FoldLanguageAssets | undefined>>();
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

  /** Guarded `log.append`/`sink.error` — a broken log/sink must never break
   * the pipeline it is reporting on. */
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

  function warnOnce(languageId: string, cause: unknown): void {
    if (warnedLanguages.has(languageId)) return;
    warnedLanguages.add(languageId);
    reportSafely({
      message: `Language "${languageId}" failed to load its fold query; code folding is disabled for it (syntax highlighting is unaffected): ${describeError(cause)}`,
    });
  }

  /** Load+compile one language's fold assets, caching the in-flight/settled
   * `Promise` itself so concurrent opens of the same language share one
   * load. `undefined` when the language is unregistered, declares no
   * `folds` query (not a failure — just "nothing folds here"), or fails to
   * load (warned exactly once). */
  function getOrLoadFoldAssets(languageId: string): Promise<FoldLanguageAssets | undefined> {
    const cached = languageAssets.get(languageId);
    if (cached) return cached;

    const load = (async (): Promise<FoldLanguageAssets | undefined> => {
      const contribution = languageRegistry.getLanguage(languageId);
      if (!contribution) return undefined;
      const foldsPath = contribution.folds;
      if (foldsPath === undefined || foldsPath === "") return undefined;
      const baseDir = languageRegistry.getBaseDir(languageId);
      try {
        await backend.init();
        const grammarBytes = await assetResolver.resolveGrammar(contribution.grammar, baseDir);
        const language = await backend.loadLanguage(grammarBytes);
        const foldsSource = await assetResolver.resolveFolds(foldsPath, baseDir);
        const query = backend.compileQuery(language, foldsSource);
        return { language, query };
      } catch (cause) {
        warnOnce(languageId, cause);
        return undefined;
      }
    })();
    languageAssets.set(languageId, load);
    return load;
  }

  /**
   * Recompute `state.ranges` from `tree`'s current fold captures.
   *
   * Rows come straight from each capture's `startPosition.row`/
   * `endPosition.row` — whole-line granularity is all folding needs, so
   * (unlike `highlightService.ts`, whose column math has to agree
   * bit-for-bit with `LineBuffer`'s own `"\n"`-only offset model) there is
   * no offset-to-column conversion to keep consistent here.
   *
   * A capture ending at column 0 of its end row (a `}` on its own line is
   * NOT this case; a node whose text ends exactly at a line break is)
   * would otherwise claim a row it does not actually occupy, so such a
   * capture is pulled back one row. Single-row ranges are then dropped:
   * collapsing one would hide nothing.
   */
  function recomputeRanges(state: FoldDocState, assets: FoldLanguageAssets, text: string): void {
    const lineCount = createLineBuffer(text || "\n", "\n").lineCount;
    const maxLine = Math.max(0, lineCount - 1);
    const captures = assets.query.captures(state.tree!);
    const seen = new Set<string>();
    const ranges: FoldRange[] = [];
    for (const capture of captures) {
      const startLine = Math.max(0, Math.min(capture.startPosition.row, maxLine));
      const rawEndLine = capture.endPosition.column === 0 ? capture.endPosition.row - 1 : capture.endPosition.row;
      const endLine = Math.max(0, Math.min(rawEndLine, maxLine));
      if (endLine <= startLine) continue;
      const key = `${startLine}:${endLine}`;
      // Two different capture patterns can match the same node span (a
      // `class_body` inside a `class_declaration`, say) — one fold region
      // per distinct line span is what a gutter marker and a toggle both
      // mean by "this fold".
      if (seen.has(key)) continue;
      seen.add(key);
      ranges.push({ startLine, endLine });
    }
    ranges.sort((a, b) => (a.startLine - b.startLine) || (b.endLine - a.endLine));
    // Preserve the previous array's identity when nothing actually changed
    // ({@link FoldService.getFoldRanges}' reference-stability contract).
    const previous = state.ranges;
    state.ranges = previous && rangesEqual(previous, ranges) ? previous : ranges;
  }

  function parseDocument(document: CoreDocument, state: FoldDocState, assets: FoldLanguageAssets): void {
    const text = document.getText();
    state.tree = backend.parse(assets.language, text, state.tree);
    state.lastText = text;
    recomputeRanges(state, assets, text);
    fireChange();
  }

  function handleChange(document: CoreDocument, uri: Uri, event: DocumentChangeEvent): void {
    const state = states.get(uri);
    if (!state || state.bypass) return;
    const assets = state.assets;
    // Assets not ready yet: once the load settles, `attachDocument`'s own
    // continuation runs a full parse of the THEN-current text, so this
    // edit is folded into that first parse rather than lost.
    if (!assets || !state.tree) return;

    const oldBuffer = createLineBuffer(state.lastText || "\n", "\n");
    // Bottom-up (descending start position) — the same order
    // `document.ts`'s `buffer.applyEdits` and `highlightService.ts`'s
    // `handleChange` both use, and what makes every edit's pre-batch
    // offsets valid to apply in sequence.
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

    const oldTree = state.tree;
    const text = document.getText();
    state.tree = backend.parse(assets.language, text, oldTree);
    state.lastText = text;
    try {
      recomputeRanges(state, assets, text);
    } finally {
      // Free the old tree now rather than waiting on GC (Req 13.1's
      // finding, documented on `ParserTree.dispose`). The equality guard
      // exists only for a hypothetical backend/mock that reused the same
      // object.
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

    const state: FoldDocState = { languageId, bypass: false, lastText: document.getText() };
    states.set(uri, state);

    void getOrLoadFoldAssets(languageId).then((assets) => {
      if (disposed || states.get(uri) !== state) return; // Closed/detached before the load settled.
      if (!assets) {
        state.bypass = true;
        return;
      }
      state.assets = assets;
      state.documentSub = document.onDidChange((event) => handleChange(document, uri, event));
      parseDocument(document, state, assets);
    });
  }

  function detachDocument(uri: Uri): void {
    const state = states.get(uri);
    if (!state) return;
    state.documentSub?.dispose();
    state.tree?.dispose?.();
    states.delete(uri);
  }

  // Pick up any document already open at construction time (mirrors
  // `highlightService.ts`).
  for (const document of documents.documents) attachDocument(document);

  const openSub = documents.onDidOpen((document) => {
    if (!disposed) attachDocument(document);
  });
  const closeSub = documents.onDidClose((document) => {
    if (!disposed) detachDocument(document.uri);
  });

  function getFoldRanges(uri: Uri): readonly FoldRange[] {
    const state = states.get(uri);
    if (!state || state.bypass || !state.ranges) return EMPTY_RANGES;
    return state.ranges;
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

  function whenIdle(): Promise<void> {
    // `getOrLoadFoldAssets`' returned promise never rejects (its own
    // try/catch always resolves to `undefined` on failure).
    return Promise.all(Array.from(languageAssets.values())).then(() => undefined);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    openSub.dispose();
    closeSub.dispose();
    for (const state of states.values()) {
      state.documentSub?.dispose();
      state.tree?.dispose?.();
    }
    states.clear();
    listeners.clear();
  }

  return { getFoldRanges, onDidChange, whenIdle, dispose };
}
