/**
 * Real-grammar differential tests for `highlightService.ts`'s RANGED
 * incremental recompute (Req 13.1; `spliceLineSpans`'s TSDoc): after each
 * of a battery of edits — single-line edit, newline insertion, line
 * deletion, edits INSIDE multi-line captures (a block comment and a
 * template literal spanning the edited lines), and edits that MOVE a
 * multi-line capture's boundaries (deleting/re-adding a template
 * literal's closing backtick, opening an unterminated one mid-file) —
 * `getSpansForLine` for EVERY line of the incrementally-edited document
 * must equal a fresh-parse full recompute of the same final text.
 *
 * Like `languagesBasicHighlights.test.ts` (whose asset-loading seams this
 * file reuses verbatim), this deliberately runs the REAL
 * `web-tree-sitter` backend against the REAL vendored `typescript.wasm` +
 * `typescript.scm` — the mock-level differential coverage in
 * `highlightService.test.ts` proves the service's splice bookkeeping
 * against a hand-rolled backend, but only a real grammar exercises the
 * genuinely load-bearing backend behaviors the ranged path depends on:
 * tree-sitter's intersecting-capture range semantics
 * (`ParserQuery.captures`'s superset contract) and `getChangedRanges`'s
 * cascading-recolor reporting (an unterminated template literal
 * recoloring everything after it).
 *
 * The real backend is WRAPPED to record whether each `captures()` call
 * carried a range — every edit here must go through the ranged path
 * (never the full-recompute fallback), so a silent fallback regression
 * can't fake a differential pass.
 */

import { describe, expect, test } from "bun:test";
import {
  builtinLanguageGrammarAssets,
  builtinLanguageQueryAssets,
  builtinManifests,
  LANGUAGES_BASIC_EXTENSION_ID,
} from "@tecode/builtin";
import type { Disposable, Listener, TextEdit } from "@tecode/api";
import {
  createAssetResolver,
  createDocument,
  createHighlightService,
  createHostLog,
  createWebTreeSitterParserBackend,
  type CoreDocument,
  type ParserBackend,
  type ParserRange,
  type ParserTree,
} from "@tecode/core";
import { createBuiltinLanguageAssetsFs } from "./languageAssetsFs";
import { builtinExtensionDir } from "./main";

const languagesBasicManifest = builtinManifests.find((m) => m.id === LANGUAGES_BASIC_EXTENSION_ID)!;
const typescriptContribution = (languagesBasicManifest.contributes.languages ?? []).find((l) => l.id === "typescript")!;

const assetResolver = createAssetResolver({
  fs: createBuiltinLanguageAssetsFs(builtinLanguageGrammarAssets, builtinLanguageQueryAssets),
});
const baseDir = builtinExtensionDir(LANGUAGES_BASIC_EXTENSION_ID);

function createRecordingSink() {
  const errors: string[] = [];
  return { errors, error: (err: { message: string }) => errors.push(err.message) };
}

function createTestDocument(uri: string, text: string): CoreDocument {
  return createDocument({ uri, languageId: "typescript", text, sink: createRecordingSink(), log: createHostLog() });
}

/** A minimal fake `documents` manager (hand-rolled per house convention —
 * kept as a separate copy of `highlightService.test.ts`'s own helper, not
 * an import, since test files are not meant to be imported as modules;
 * same reasoning as `editingHarness.tsx`'s `createHermeticDiscoveryFs`
 * copy). */
function createFakeDocuments() {
  const docs = new Map<string, CoreDocument>();
  const openListeners = new Set<Listener<CoreDocument>>();
  const closeListeners = new Set<Listener<CoreDocument>>();
  return {
    get documents(): readonly CoreDocument[] {
      return Array.from(docs.values());
    },
    onDidOpen(listener: Listener<CoreDocument>): Disposable {
      openListeners.add(listener);
      return { dispose: () => openListeners.delete(listener) };
    },
    onDidClose(listener: Listener<CoreDocument>): Disposable {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    open(document: CoreDocument): void {
      docs.set(document.uri, document);
      for (const listener of Array.from(openListeners)) listener(document);
    },
    close(document: CoreDocument): void {
      docs.delete(document.uri);
      for (const listener of Array.from(closeListeners)) listener(document);
    },
  };
}

/** Wrap the real backend so every `captures()` call's range argument is
 * recorded (this file's TSDoc: proves the ranged path actually ran). */
function instrumentBackend(real: ParserBackend): { backend: ParserBackend; capturesCalls: Array<ParserRange | undefined> } {
  const capturesCalls: Array<ParserRange | undefined> = [];
  const backend: ParserBackend = {
    init: () => real.init(),
    loadLanguage: (bytes) => real.loadLanguage(bytes),
    compileQuery(language, querySource) {
      const query = real.compileQuery(language, querySource);
      return {
        captures(tree: ParserTree, range?: ParserRange) {
          capturesCalls.push(range);
          return query.captures(tree, range);
        },
      };
    },
    parse: (language, text, oldTree) => real.parse(language, text, oldTree),
    changedRanges: (oldTree, newTree) => real.changedRanges!(oldTree, newTree),
  };
  return { backend, capturesCalls };
}

const languageRegistry = {
  getLanguage: (id: string) => (id === "typescript" ? typescriptContribution : undefined),
  getBaseDir: () => baseDir,
};

function buildService(backend: ParserBackend) {
  const fakeDocs = createFakeDocuments();
  const service = createHighlightService({
    documents: fakeDocs,
    languageRegistry,
    assetResolver,
    backend,
    log: createHostLog(),
    sink: createRecordingSink(),
  });
  return { fakeDocs, service };
}

/** Poll until `predicate` holds (the real grammar load + first parse cross
 * real macrotasks, so microtask flushing alone is not enough). */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A fixture with real multi-line captures: a block comment (lines 1-3)
 * and a template literal (lines 4-6), plus ordinary statements around
 * them. */
const FIXTURE =
  [
    'const title = "hello";', // 0
    "/*", // 1
    " * block comment interior", // 2
    " */", // 3
    "const tpl = `first line", // 4
    "second ${title} line", // 5
    "third line`;", // 6
    "export function fn(a: number): number {", // 7
    "  const scaled = a * 2;", // 8
    "  return scaled + 1;", // 9
    "}", // 10
    "const tail = fn(4);", // 11
  ].join("\n") + "\n";

// ONE long-lived instrumented live service (the document under incremental
// edits) and ONE oracle service (fresh full parses of final texts) — both
// share a single real backend instance, so the grammar WASM compiles once.
const realBackend = createWebTreeSitterParserBackend();
const { backend: liveBackend, capturesCalls } = instrumentBackend(realBackend);
const live = buildService(liveBackend);
const oracle = buildService(realBackend);
let uriCounter = 0;

/** Open a live document on {@link FIXTURE} and wait out its first full
 * parse. */
async function openLiveFixture(): Promise<CoreDocument> {
  const uri = `file:///live-${uriCounter++}.ts`;
  const document = createTestDocument(uri, FIXTURE);
  live.fakeDocs.open(document);
  await waitFor(() => live.service.getSpansForLine(uri, 0).length > 0, `first parse of ${uri}`);
  return document;
}

/** THE differential: every line of the incrementally-edited live document
 * (plus two lines past its end, which must be empty on both sides) must
 * have spans identical to a fresh oracle document full-parsed from the
 * live document's CURRENT text. */
async function expectAllLinesMatchFreshParse(document: CoreDocument): Promise<void> {
  const uri = `file:///oracle-${uriCounter++}.ts`;
  const oracleDoc = createTestDocument(uri, document.getText());
  oracle.fakeDocs.open(oracleDoc);
  await waitFor(() => oracle.service.getSpansForLine(uri, 0).length > 0, `oracle parse of ${uri}`);
  const lineCount = document.lineCount + 2;
  const fresh = Array.from({ length: lineCount }, (_, line) => oracle.service.getSpansForLine(uri, line));
  const spans = Array.from({ length: lineCount }, (_, line) => live.service.getSpansForLine(document.uri, line));
  expect(spans).toEqual(fresh);
  oracle.fakeDocs.close(oracleDoc);
}

/** Apply `edits` to the live document and assert the recompute they
 * triggered went through the RANGED path (this file's TSDoc). */
function applyEditsRanged(document: CoreDocument, edits: TextEdit[]): void {
  const callsBefore = capturesCalls.length;
  document.applyEdits(edits);
  expect(capturesCalls.length).toBe(callsBefore + 1);
  expect(capturesCalls[callsBefore], "expected the edit's recompute to use a range-restricted captures() call").toBeDefined();
}

describe("ranged incremental recompute == fresh full parse, on the real typescript grammar (Req 13.1)", () => {
  test("single-line edit", async () => {
    const document = await openLiveFixture();
    applyEditsRanged(document, [
      { range: { start: { line: 8, character: 21 }, end: { line: 8, character: 22 } }, newText: "20" },
    ]);
    await expectAllLinesMatchFreshParse(document);
  });

  test("newline insertion (lines below shift down)", async () => {
    const document = await openLiveFixture();
    applyEditsRanged(document, [
      { range: { start: { line: 8, character: 23 }, end: { line: 8, character: 23 } }, newText: "\n  const extra = 7;" },
    ]);
    expect(document.lineCount).toBe(FIXTURE.split("\n").length + 1);
    await expectAllLinesMatchFreshParse(document);
  });

  test("line deletion (lines below shift up)", async () => {
    const document = await openLiveFixture();
    applyEditsRanged(document, [
      { range: { start: { line: 9, character: 0 }, end: { line: 10, character: 0 } }, newText: "" },
    ]);
    await expectAllLinesMatchFreshParse(document);
  });

  test("edit INSIDE the block comment's interior line (a multi-line capture spans the edited line)", async () => {
    const document = await openLiveFixture();
    applyEditsRanged(document, [
      { range: { start: { line: 2, character: 3 }, end: { line: 2, character: 8 } }, newText: "edited" },
    ]);
    await expectAllLinesMatchFreshParse(document);
    // The trap made explicit: the comment's OTHER lines kept their spans.
    expect(live.service.getSpansForLine(document.uri, 1)).toEqual([{ startCol: 0, endCol: 2, capture: "comment" }]);
    expect(live.service.getSpansForLine(document.uri, 3).some((s) => s.capture === "comment")).toBe(true);
  });

  test("edit INSIDE the template literal's middle line", async () => {
    const document = await openLiveFixture();
    applyEditsRanged(document, [
      { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 6 } }, newText: "SECOND" },
    ]);
    await expectAllLinesMatchFreshParse(document);
    // Lines 4 and 6 still carry their template-string spans.
    expect(live.service.getSpansForLine(document.uri, 4).some((s) => s.capture === "string")).toBe(true);
    expect(live.service.getSpansForLine(document.uri, 6).some((s) => s.capture === "string")).toBe(true);
  });

  test("edit that MOVES a multi-line capture's end: deleting then restoring the template literal's closing backtick", async () => {
    const document = await openLiveFixture();
    // Delete the closing backtick on line 6 — the template literal now
    // swallows the rest of the file (tree-sitter's error recovery decides
    // exactly how far; the differential doesn't care, it only demands
    // live == fresh).
    const backtickCol = "third line".length;
    applyEditsRanged(document, [
      { range: { start: { line: 6, character: backtickCol }, end: { line: 6, character: backtickCol + 1 } }, newText: "" },
    ]);
    await expectAllLinesMatchFreshParse(document);

    // Restore it — everything below must recolor back.
    applyEditsRanged(document, [
      { range: { start: { line: 6, character: backtickCol }, end: { line: 6, character: backtickCol } }, newText: "`" },
    ]);
    await expectAllLinesMatchFreshParse(document);
    expect(live.service.getSpansForLine(document.uri, 9).some((s) => s.capture === "keyword")).toBe(true);
  });

  test("edit that OPENS an unterminated template literal mid-file (cascading recolor far past the edited line)", async () => {
    const document = await openLiveFixture();
    applyEditsRanged(document, [
      { range: { start: { line: 8, character: 2 }, end: { line: 8, character: 2 } }, newText: "`" },
    ]);
    await expectAllLinesMatchFreshParse(document);

    // And close it again two lines down — another boundary move.
    applyEditsRanged(document, [
      { range: { start: { line: 10, character: 0 }, end: { line: 10, character: 0 } }, newText: "` + " },
    ]);
    await expectAllLinesMatchFreshParse(document);
  });

  test("multi-byte content: spans land at UTF-16 columns (where UTF-8 byte offsets would diverge), before and after an edit", async () => {
    // "café" = 4 UTF-16 units but 5 UTF-8 bytes; the emoji = 2 units but 4
    // bytes — golden column assertions here would fail under any UTF-8
    // interpretation of web-tree-sitter's offsets (the coordinate-space
    // bug `parserBackend.ts`'s module TSDoc records removing), which the
    // live-vs-fresh differential alone could never catch (both sides would
    // be wrong identically).
    const uri = `file:///live-mb-${uriCounter++}.ts`;
    const text = 'const café = "😀 naïve";\nconst après = café;\n';
    const document = createTestDocument(uri, text);
    live.fakeDocs.open(document);
    await waitFor(() => live.service.getSpansForLine(uri, 0).length > 0, `first parse of ${uri}`);

    // Line 0: `café` at UTF-16 columns 6-10 (bytes: 6-11); the string
    // `"😀 naïve"` at columns 13-23 (bytes: 13-26).
    expect(live.service.getSpansForLine(uri, 0)).toContainEqual({ startCol: 6, endCol: 10, capture: "variable" });
    expect(live.service.getSpansForLine(uri, 0)).toContainEqual({ startCol: 13, endCol: 23, capture: "string" });

    // Edit line 1 THROUGH the ranged path: rename `après` (columns 6-11).
    applyEditsRanged(document, [
      { range: { start: { line: 1, character: 6 }, end: { line: 1, character: 11 } }, newText: "aprèsX" },
    ]);
    await expectAllLinesMatchFreshParse(document);
    expect(live.service.getSpansForLine(uri, 1)).toContainEqual({ startCol: 6, endCol: 12, capture: "variable" });
    // Line 0 untouched — its multi-byte spans kept their cached columns.
    expect(live.service.getSpansForLine(uri, 0)).toContainEqual({ startCol: 13, endCol: 23, capture: "string" });
  });

  test("multi-edit batch (replace + newline insertion in one event)", async () => {
    const document = await openLiveFixture();
    applyEditsRanged(document, [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "heading" },
      { range: { start: { line: 9, character: 20 }, end: { line: 9, character: 20 } }, newText: "\n  // trailing note" },
    ]);
    await expectAllLinesMatchFreshParse(document);
  });
});
