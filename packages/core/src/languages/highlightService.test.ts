/**
 * Tests for {@link createHighlightService} (Req 8.1-8.3, design.md §10,
 * §14). ALL of these use a hand-rolled mock {@link ParserBackend} — never
 * the real `web-tree-sitter`-backed one, and no real grammar/`.scm` files
 * (this task's "no real WASM in tests" constraint).
 */

import { describe, expect, test } from "bun:test";
import type { Disposable, LanguageContribution, Listener } from "@tecode/api";
import { createDocument, type CoreDocument } from "../buffer/document";
import { createHostLog } from "../host/errors";
import { createHighlightService, type HighlightServiceDeps } from "./highlightService";
import type {
  ParserBackend,
  ParserCapture,
  ParserEditDescriptor,
  ParserLanguageHandle,
  ParserRange,
  ParserTree,
} from "./parserBackend";

/** Flush a handful of microtask ticks — enough for the highlight service's
 * `init -> loadLanguage -> resolveHighlights -> compileQuery -> parse`
 * async chain (this module's own mocks are all single-microtask-deep, so
 * a handful of ticks is comfortably enough) to settle. */
async function tick(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function createRecordingSink() {
  const errors: string[] = [];
  return { errors, error: (err: { message: string }) => errors.push(err.message) };
}

function createTestDocument(uri: string, languageId: string, text: string): CoreDocument {
  return createDocument({
    uri,
    languageId,
    text,
    sink: createRecordingSink(),
    log: createHostLog(),
  });
}

/** A minimal fake `documents: Pick<DocumentManager, "onDidOpen" |
 * "onDidClose" | "documents">` — hand-rolled, per house convention (no mock
 * libraries). `open`/`close` are test-only driver methods. */
function createFakeDocuments(initial: readonly CoreDocument[] = []) {
  const docs = new Map<string, CoreDocument>(initial.map((d) => [d.uri, d]));
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

function fakeLanguageRegistry(languages: Record<string, LanguageContribution>) {
  return {
    getLanguage: (id: string) => languages[id],
    getBaseDir: () => undefined,
  };
}

/** A hand-rolled mock backend: `compileQuery`'s `captures` tokenizes
 * whatever text the tree was last `parse()`d with — words as `"variable"`,
 * digit runs as `"number"` — completely ignoring `edit()`'s payload for the
 * RESULT (`edit()` calls are still recorded, for tests that want to assert
 * on them). This is what makes the differential test meaningful: the mock
 * backend's output depends only on the text `highlightService.ts` actually
 * hands to `parse()`, so "spans after an incremental edit" and "spans from
 * a fresh parse of the same final text" can only agree if the service
 * itself correctly threads the document's current text through every
 * parse/reparse call. */
function tokenize(text: string): ParserCapture[] {
  const captures: ParserCapture[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*|\d+/g;
  let match: RegExpExecArray | null;
  const zero = { row: 0, column: 0 };
  while ((match = re.exec(text))) {
    captures.push({
      name: /^\d/.test(match[0]) ? "number" : "variable",
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      startPosition: zero,
      endPosition: zero,
    });
  }
  return captures;
}

interface MockBackend extends ParserBackend {
  parseCount: number;
  loadCount: number;
  editCalls: ParserEditDescriptor[];
}

function createMockBackend(): MockBackend {
  let parseCount = 0;
  let loadCount = 0;
  const editCalls: ParserEditDescriptor[] = [];
  const backend = {
    get parseCount() {
      return parseCount;
    },
    get loadCount() {
      return loadCount;
    },
    editCalls,
    async init() {},
    async loadLanguage(bytes: Uint8Array): Promise<ParserLanguageHandle> {
      loadCount += 1;
      return { bytes };
    },
    compileQuery() {
      return {
        captures(tree: ParserTree) {
          return tokenize((tree as unknown as { text: string }).text);
        },
      };
    },
    parse(_language: ParserLanguageHandle, text: string): ParserTree {
      parseCount += 1;
      return {
        text,
        edit(edit: ParserEditDescriptor) {
          editCalls.push(edit);
        },
      } as unknown as ParserTree;
    },
  };
  return backend as MockBackend;
}

function buildDeps(overrides: Partial<HighlightServiceDeps> = {}): HighlightServiceDeps {
  return {
    documents: createFakeDocuments(),
    languageRegistry: fakeLanguageRegistry({}),
    assetResolver: {
      resolveGrammar: async () => new Uint8Array([1]),
      resolveHighlights: async () => "(identifier) @variable",
    },
    backend: createMockBackend(),
    log: createHostLog(),
    sink: createRecordingSink(),
    ...overrides,
  };
}

const tsContribution: LanguageContribution = {
  id: "typescript",
  extensions: [".ts"],
  grammar: "ts.wasm",
  highlights: "ts.scm",
};

describe("createHighlightService — basic parse + getSpansForLine (Req 8.1)", () => {
  test("a non-plaintext document gets spans once its language's assets load", async () => {
    const fakeDocs = createFakeDocuments();
    const deps = buildDeps({ documents: fakeDocs, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) });
    const service = createHighlightService(deps);
    const document = createTestDocument("file:///a.ts", "typescript", "let x = 1;");
    fakeDocs.open(document);
    await tick();

    const spans = service.getSpansForLine(document.uri, 0);
    expect(spans).toEqual([
      { startCol: 0, endCol: 3, capture: "variable" }, // "let"
      { startCol: 4, endCol: 5, capture: "variable" }, // "x"
      { startCol: 8, endCol: 9, capture: "number" }, // "1"
    ]);
  });

  test("plaintext bypasses the pipeline entirely — no spans, no backend calls", async () => {
    const backend = createMockBackend();
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(buildDeps({ documents: fakeDocs, backend }));
    const document = createTestDocument("file:///a.txt", "plaintext", "let x = 1;");
    fakeDocs.open(document);
    await tick();

    expect(service.getSpansForLine(document.uri, 0)).toEqual([]);
    expect(backend.parseCount).toBe(0);
    expect(backend.loadCount).toBe(0);
  });

  test("an unknown uri or out-of-range line returns []", async () => {
    const service = createHighlightService(buildDeps());
    expect(service.getSpansForLine("file:///nope.ts", 0)).toEqual([]);
  });

  test("a language id resolved with no registered contribution silently yields no spans (no warning)", async () => {
    const sink = createRecordingSink();
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(buildDeps({ documents: fakeDocs, sink, languageRegistry: fakeLanguageRegistry({}) }));
    const document = createTestDocument("file:///a.ts", "typescript", "let x = 1;");
    fakeDocs.open(document);
    await tick();

    expect(service.getSpansForLine(document.uri, 0)).toEqual([]);
    expect(sink.errors).toEqual([]);
  });

  test("multi-line captures split into one span per line", async () => {
    // A single capture spanning BOTH lines ("foo\nbar", indices 0..7) —
    // rather than `tokenize`'s usual per-word captures — so this actually
    // exercises `recomputeLineSpans`'s multi-line splitting (a single
    // capture contributing one `HighlightSpan` to each line it crosses),
    // not just two independent single-line captures that happen to land on
    // different lines.
    const backend = createMockBackend();
    backend.compileQuery = () => ({
      captures: () => [
        {
          name: "variable",
          startIndex: 0,
          endIndex: 7,
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 1, column: 3 },
        },
      ],
    });
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, backend, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", "foo\nbar");
    fakeDocs.open(document);
    await tick();

    expect(service.getSpansForLine(document.uri, 0)).toEqual([{ startCol: 0, endCol: 3, capture: "variable" }]);
    expect(service.getSpansForLine(document.uri, 1)).toEqual([{ startCol: 0, endCol: 3, capture: "variable" }]);
  });

  test("onDidChange fires once the first parse settles", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    let fired = 0;
    service.onDidChange(() => {
      fired += 1;
    });
    fakeDocs.open(createTestDocument("file:///a.ts", "typescript", "x"));
    await tick();
    expect(fired).toBe(1);
  });
});

describe("createHighlightService — per-language asset cache", () => {
  test("two documents of the same language share one grammar/query load", async () => {
    const backend = createMockBackend();
    const fakeDocs = createFakeDocuments();
    let resolveGrammarCalls = 0;
    createHighlightService(
      buildDeps({
        documents: fakeDocs,
        backend,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
        assetResolver: {
          resolveGrammar: async () => {
            resolveGrammarCalls += 1;
            return new Uint8Array([1]);
          },
          resolveHighlights: async () => "query",
        },
      }),
    );
    fakeDocs.open(createTestDocument("file:///a.ts", "typescript", "a"));
    fakeDocs.open(createTestDocument("file:///b.ts", "typescript", "b"));
    await tick();

    expect(resolveGrammarCalls).toBe(1);
    expect(backend.loadCount).toBe(1);
  });
});

describe("createHighlightService — incremental edits (Req 8.1, design.md §10)", () => {
  test("an edit updates the spans for the touched line", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", "let x = 1;");
    fakeDocs.open(document);
    await tick();

    document.applyEdits([
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } }, newText: "count" },
    ]);
    // Synchronous: the mock backend's parse/captures involve no awaits.
    expect(service.getSpansForLine(document.uri, 0)).toEqual([
      { startCol: 0, endCol: 3, capture: "variable" }, // "let"
      { startCol: 4, endCol: 9, capture: "variable" }, // "count"
      { startCol: 12, endCol: 13, capture: "number" }, // "1"
    ]);
  });

  test("differential: spans after an incremental multi-edit == spans from a fresh parse of the same final text", async () => {
    // Service A: build up the content through a sequence of edits.
    const fakeDocsA = createFakeDocuments();
    const serviceA = createHighlightService(
      buildDeps({ documents: fakeDocsA, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const documentA = createTestDocument("file:///a.ts", "typescript", "let x = 1;\nfoo(bar);");
    fakeDocsA.open(documentA);
    await tick();

    // Multi-edit batch (both edits in ONE applyEdits call — exercises the
    // bottom-up multi-edit ordering this module's TSDoc describes) followed
    // by a second, separate edit.
    documentA.applyEdits([
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } }, newText: "count" },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: "baz" },
    ]);
    documentA.applyEdits([
      { range: { start: { line: 1, character: 8 }, end: { line: 1, character: 8 } }, newText: "42" },
    ]);

    const finalText = documentA.getText();
    const spansA = [0, 1].map((line) => serviceA.getSpansForLine(documentA.uri, line));

    // Service B: a completely independent service/document, parsed fresh
    // from the FINAL text directly.
    const fakeDocsB = createFakeDocuments();
    const serviceB = createHighlightService(
      buildDeps({ documents: fakeDocsB, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const documentB = createTestDocument("file:///b.ts", "typescript", finalText);
    fakeDocsB.open(documentB);
    await tick();

    const spansB = [0, 1].map((line) => serviceB.getSpansForLine(documentB.uri, line));

    expect(spansA).toEqual(spansB);
  });

  test("closing a document stops further edits from being processed", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", "let x = 1;");
    fakeDocs.open(document);
    await tick();
    fakeDocs.close(document);

    expect(() =>
      document.applyEdits([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "z" }]),
    ).not.toThrow();
    expect(service.getSpansForLine(document.uri, 0)).toEqual([]);
  });
});

/** A hand-rolled mock backend (house convention: no mock libraries) whose
 * `parse()` result carries a real, counting `dispose()` — everything else
 * behaves like {@link createMockBackend} (tokenize-based captures, no
 * `changedRanges`, so every edit takes the full-recompute path). Lets a
 * test assert exactly which trees `highlightService.ts` disposes and when
 * (Req 13.1 finding: deterministic `ParserTree` disposal), and that a tree
 * already disposed is never disposed a second time. */
interface DisposalTrackingMockBackend extends ParserBackend {
  /** Every tree `parse()` has produced, in creation order — each entry's
   * own `disposeCount` is mutated in place as `dispose()` is (or isn't)
   * called on it. */
  trees: Array<{ tree: ParserTree; disposeCount: number }>;
}

function createDisposalTrackingMockBackend(): DisposalTrackingMockBackend {
  const trees: Array<{ tree: ParserTree; disposeCount: number }> = [];
  const backend = {
    trees,
    async init() {},
    async loadLanguage(bytes: Uint8Array): Promise<ParserLanguageHandle> {
      return { bytes };
    },
    compileQuery() {
      return {
        captures(tree: ParserTree) {
          return tokenize((tree as unknown as { text: string }).text);
        },
      };
    },
    parse(_language: ParserLanguageHandle, text: string): ParserTree {
      const entry = { tree: undefined as unknown as ParserTree, disposeCount: 0 };
      entry.tree = {
        text,
        edit() {},
        dispose() {
          entry.disposeCount += 1;
        },
      } as unknown as ParserTree;
      trees.push(entry);
      return entry.tree;
    },
  };
  return backend as DisposalTrackingMockBackend;
}

describe("createHighlightService — deterministic ParserTree disposal (Req 13.1 finding)", () => {
  test("an incremental re-parse disposes the OLD tree exactly once, leaving the new tree undisposed", async () => {
    const fakeDocs = createFakeDocuments();
    const backend = createDisposalTrackingMockBackend();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, backend, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", "let x = 1;");
    fakeDocs.open(document);
    await tick();
    expect(backend.trees).toHaveLength(1); // the initial full parse

    document.applyEdits([
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } }, newText: "count" },
    ]);
    expect(backend.trees).toHaveLength(2); // the re-parse produced a second tree
    expect(backend.trees[0]!.disposeCount).toBe(1); // the OLD tree was disposed...
    expect(backend.trees[1]!.disposeCount).toBe(0); // ...but the tree now in use was not

    // A second edit disposes the (now-old) second tree, and only it.
    document.applyEdits([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "z" },
    ]);
    expect(backend.trees).toHaveLength(3);
    expect(backend.trees[0]!.disposeCount).toBe(1);
    expect(backend.trees[1]!.disposeCount).toBe(1);
    expect(backend.trees[2]!.disposeCount).toBe(0);
    expect(service.getSpansForLine(document.uri, 0)).not.toEqual([]); // still fully functional
  });

  test("closing a document disposes its current tree exactly once", async () => {
    const fakeDocs = createFakeDocuments();
    const backend = createDisposalTrackingMockBackend();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, backend, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", "let x = 1;");
    fakeDocs.open(document);
    await tick();
    expect(backend.trees).toHaveLength(1);
    expect(backend.trees[0]!.disposeCount).toBe(0);

    fakeDocs.close(document);
    expect(backend.trees[0]!.disposeCount).toBe(1);
    expect(service.getSpansForLine(document.uri, 0)).toEqual([]); // untracked once closed

    // Re-closing the same, already-untracked uri is a no-op
    // (`detachDocument`'s own `if (!state) return;` guard) — confirms this
    // isn't relying on the service happening to double-dispose harmlessly.
    fakeDocs.close(document);
    expect(backend.trees[0]!.disposeCount).toBe(1);
  });

  test("service dispose() disposes every tracked document's current tree exactly once", async () => {
    const fakeDocs = createFakeDocuments();
    const backend = createDisposalTrackingMockBackend();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, backend, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const documentA = createTestDocument("file:///a.ts", "typescript", "let x = 1;");
    const documentB = createTestDocument("file:///b.ts", "typescript", "let y = 2;");
    fakeDocs.open(documentA);
    fakeDocs.open(documentB);
    await tick();
    expect(backend.trees).toHaveLength(2);
    expect(backend.trees.every((t) => t.disposeCount === 0)).toBe(true);

    service.dispose();
    expect(backend.trees.every((t) => t.disposeCount === 1)).toBe(true);

    // Idempotent: a second `dispose()` call never double-disposes anything.
    expect(() => service.dispose()).not.toThrow();
    expect(backend.trees.every((t) => t.disposeCount === 1)).toBe(true);
  });
});

/** `tokenize`, plus multi-line `"comment"` captures over every
 * `/* ... *``/` region (an unterminated `/*` runs to the end of the text) —
 * a hand-rolled stand-in for a real grammar's multi-line constructs
 * (template literals, block comments), giving the ranged-recompute
 * differential tests below a capture that SPANS lines, starts BEFORE an
 * edit's dirty range while extending into it, and whose extent GROWS to
 * the end of the file when its terminator is deleted. Captures come out in
 * document order, same as a real query's. */
function tokenizeWithComments(text: string): ParserCapture[] {
  const captures: ParserCapture[] = [];
  const zero = { row: 0, column: 0 };
  let pos = 0;
  for (;;) {
    const open = text.indexOf("/*", pos);
    const stretchEnd = open === -1 ? text.length : open;
    for (const token of tokenize(text.slice(pos, stretchEnd))) {
      captures.push({ ...token, startIndex: token.startIndex + pos, endIndex: token.endIndex + pos });
    }
    if (open === -1) break;
    const close = text.indexOf("*/", open + 2);
    const end = close === -1 ? text.length : close + 2;
    captures.push({ name: "comment", startIndex: open, endIndex: end, startPosition: zero, endPosition: zero });
    if (close === -1) break;
    pos = end;
  }
  return captures;
}

/** The ordered sequence of comment delimiters in `text` — the ranged
 * mock's stand-in for "did the SYNTACTIC STRUCTURE beyond the edit
 * change": while an edit leaves this sequence intact (typing inside a
 * comment, or outside every comment), highlight effects cannot cascade
 * past the edited region in this mock language; when it changes (deleting
 * a terminator), they can — mirroring what makes real tree-sitter's
 * `getChangedRanges` report a range far wider than the edit. */
function commentMarkerSignature(text: string): string {
  return Array.from(text.matchAll(/\/\*|\*\//g), (m) => m[0]).join(",");
}

interface RangedMockBackend extends ParserBackend {
  /** One entry per `captures()` call: the range it was (or wasn't) given —
   * lets a test assert the service actually took the ranged path. */
  capturesCalls: Array<ParserRange | undefined>;
}

/**
 * A hand-rolled mock backend (house convention: no mock libraries) that —
 * unlike {@link createMockBackend} — implements the OPTIONAL parts of the
 * `ParserBackend` contract the ranged-recompute path needs, so it
 * exercises `highlightService.ts`'s `spliceLineSpans` instead of the
 * full-recompute fallback:
 *
 * - `captures(tree, range?)` honors the range by filtering to captures
 *   INTERSECTING it (the guaranteed-included part of the real backend's
 *   superset contract, `ParserQuery.captures`'s TSDoc), preserving
 *   document order, and records every call's range for assertions.
 * - `changedRanges` compares the two trees' texts: their common-prefix/
 *   common-suffix diff as the changed range — extended to the end of the
 *   text when {@link commentMarkerSignature} differs (the cascading-recolor
 *   model; a plain `tokenize` language passes `signature: undefined` and
 *   never cascades, mirroring how a real edit that keeps the syntactic
 *   structure intact yields tightly-local changed ranges).
 *
 * Like {@link createMockBackend}, capture output is a pure function of the
 * text handed to `parse()` — which is exactly what makes the differential
 * tests meaningful (incremental splicing and a fresh full parse can only
 * agree if the service's bookkeeping is right).
 */
function createRangedMockBackend(
  computeCaptures: (text: string) => ParserCapture[],
  signature?: (text: string) => string,
): RangedMockBackend {
  const capturesCalls: Array<ParserRange | undefined> = [];
  const textOf = (tree: ParserTree): string => (tree as unknown as { text: string }).text;
  return {
    capturesCalls,
    async init() {},
    async loadLanguage(bytes: Uint8Array): Promise<ParserLanguageHandle> {
      return { bytes };
    },
    compileQuery() {
      return {
        captures(tree: ParserTree, range?: ParserRange): ParserCapture[] {
          capturesCalls.push(range);
          const all = computeCaptures(textOf(tree));
          if (!range) return all;
          return all.filter((c) => c.endIndex > range.startIndex && c.startIndex < range.endIndex);
        },
      };
    },
    parse(_language: ParserLanguageHandle, text: string): ParserTree {
      return { text, edit() {} } as unknown as ParserTree;
    },
    changedRanges(oldTree: ParserTree, newTree: ParserTree): ParserRange[] {
      const oldText = textOf(oldTree);
      const newText = textOf(newTree);
      if (oldText === newText) return [];
      const minLen = Math.min(oldText.length, newText.length);
      let prefix = 0;
      while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix++;
      let suffix = 0;
      while (
        suffix < minLen - prefix &&
        oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
      ) {
        suffix++;
      }
      const startIndex = prefix;
      let endIndex = newText.length - suffix;
      if (signature && signature(oldText) !== signature(newText)) endIndex = newText.length;
      endIndex = Math.max(startIndex, endIndex);
      const pointAt = (offset: number) => {
        const before = newText.slice(0, offset).split(/\r\n|\n/);
        return { row: before.length - 1, column: before[before.length - 1]!.length };
      };
      return [{ startIndex, endIndex, startPosition: pointAt(startIndex), endPosition: pointAt(endIndex) }];
    },
  };
}

describe("createHighlightService — ranged incremental recompute (Req 13.1)", () => {
  /** Spin up a live service+document on `initialText` with a fresh ranged
   * mock, awaiting the first (full) parse. */
  async function openLive(initialText: string, computeCaptures: (text: string) => ParserCapture[], signature?: (text: string) => string) {
    const backend = createRangedMockBackend(computeCaptures, signature);
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, backend, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const document = createTestDocument("file:///live.ts", "typescript", initialText);
    fakeDocs.open(document);
    await tick();
    return { backend, service, document };
  }

  /** The differential oracle: `getSpansForLine` for EVERY line of a
   * completely fresh service/document full-parsed from `finalText`
   * directly. */
  async function freshSpansForAllLines(
    finalText: string,
    lineCount: number,
    computeCaptures: (text: string) => ParserCapture[],
  ) {
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(
      buildDeps({
        documents: fakeDocs,
        backend: createRangedMockBackend(computeCaptures),
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
      }),
    );
    const document = createTestDocument("file:///fresh.ts", "typescript", finalText);
    fakeDocs.open(document);
    await tick();
    return Array.from({ length: lineCount }, (_, line) => service.getSpansForLine(document.uri, line));
  }

  /** Assert the live service's spans equal the fresh-parse oracle's on
   * EVERY line (plus a couple past the end, which must be `[]` on both). */
  async function expectAllLinesMatchFresh(
    service: ReturnType<typeof createHighlightService>,
    document: CoreDocument,
    computeCaptures: (text: string) => ParserCapture[],
  ): Promise<void> {
    const lineCount = document.lineCount + 2;
    const fresh = await freshSpansForAllLines(document.getText(), lineCount, computeCaptures);
    const live = Array.from({ length: lineCount }, (_, line) => service.getSpansForLine(document.uri, line));
    expect(live).toEqual(fresh);
  }

  const fourLines = "let alpha = 1;\nlet beta = 22;\nlet gamma = 333;\nlet delta = 4444;";

  test("a single-line edit recomputes via a RANGE-RESTRICTED captures call and matches a fresh full parse on every line", async () => {
    const { backend, service, document } = await openLive(fourLines, tokenize);
    expect(backend.capturesCalls).toEqual([undefined]); // The initial parse is the full pass.

    document.applyEdits([
      { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 8 } }, newText: "renamed" },
    ]);

    // The edit's recompute went through the ranged path, restricted to
    // line 1's own offsets (line 1 starts after "let alpha = 1;\n" = 15).
    expect(backend.capturesCalls).toHaveLength(2);
    const range = backend.capturesCalls[1]!;
    expect(range.startIndex).toBe(15);
    expect(range.endIndex).toBe(15 + "let renamed = 22;".length);
    await expectAllLinesMatchFresh(service, document, tokenize);
  });

  test("a newline insertion shifts cached spans below the edit down and matches a fresh full parse on every line", async () => {
    const { backend, service, document } = await openLive(fourLines, tokenize);

    document.applyEdits([
      { range: { start: { line: 1, character: 14 }, end: { line: 1, character: 14 } }, newText: "\nlet inserted = 55;" },
    ]);

    expect(document.lineCount).toBe(5);
    expect(backend.capturesCalls).toHaveLength(2);
    expect(backend.capturesCalls[1]).toBeDefined();
    await expectAllLinesMatchFresh(service, document, tokenize);
    // Spot-check the shift: old line 2 ("gamma") is now line 3, untouched.
    expect(service.getSpansForLine(document.uri, 3)).toEqual([
      { startCol: 0, endCol: 3, capture: "variable" },
      { startCol: 4, endCol: 9, capture: "variable" },
      { startCol: 12, endCol: 15, capture: "number" },
    ]);
  });

  test("a line deletion shifts cached spans below the edit up and matches a fresh full parse on every line", async () => {
    const { backend, service, document } = await openLive(fourLines, tokenize);

    // Delete line 1 entirely (its text plus its trailing newline).
    document.applyEdits([
      { range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, newText: "" },
    ]);

    expect(document.lineCount).toBe(3);
    expect(backend.capturesCalls).toHaveLength(2);
    expect(backend.capturesCalls[1]).toBeDefined();
    await expectAllLinesMatchFresh(service, document, tokenize);
  });

  test("a multi-edit batch (insert + replace in one event) still matches a fresh full parse on every line", async () => {
    const { service, document } = await openLive(fourLines, tokenize);

    document.applyEdits([
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }, newText: "renamed0" },
      { range: { start: { line: 2, character: 16 }, end: { line: 2, character: 16 } }, newText: "\nlet added = 5;" },
    ]);

    await expectAllLinesMatchFresh(service, document, tokenize);
  });

  test("an edit INSIDE a multi-line capture spanning the edited line keeps every line of the capture correct (the intersecting-capture trap)", async () => {
    // The "comment" capture spans lines 1-3; the edit touches ONLY line 2,
    // so the ranged query's dirty range starts mid-capture — the capture
    // starts BEFORE the range and extends into (and past) it. Lines 1 and
    // 3 must keep their cached full-line comment spans; line 2 must be
    // rebuilt from the intersecting capture.
    const text = "let a = 1;\n/* first\n middle 99\n last */\nlet b = 2;";
    const { backend, service, document } = await openLive(text, tokenizeWithComments, commentMarkerSignature);

    document.applyEdits([
      { range: { start: { line: 2, character: 1 }, end: { line: 2, character: 7 } }, newText: "center" },
    ]);

    expect(backend.capturesCalls).toHaveLength(2);
    expect(backend.capturesCalls[1]).toBeDefined();
    await expectAllLinesMatchFresh(service, document, tokenizeWithComments);
    // The trap's explicit shape: the untouched interior lines of the
    // comment still carry exactly one full-line "comment" span each.
    expect(service.getSpansForLine(document.uri, 1)).toEqual([{ startCol: 0, endCol: 8, capture: "comment" }]);
    expect(service.getSpansForLine(document.uri, 2)).toEqual([{ startCol: 0, endCol: " center 99".length, capture: "comment" }]);
  });

  test("an edit that GROWS a capture's extent past the old dirty range (deleting the comment terminator) recolors the rest of the file (the cascading-recolor trap)", async () => {
    const text = "let a = 1;\n/* short */\nlet b = 2;\nlet c = 3;";
    const { service, document } = await openLive(text, tokenizeWithComments, commentMarkerSignature);
    // Before: lines 2-3 are ordinary tokens.
    expect(service.getSpansForLine(document.uri, 2)[0]).toEqual({ startCol: 0, endCol: 3, capture: "variable" });

    // Delete the "*/" — the comment now runs to the end of the file; the
    // edit touches only line 1, but lines 2-3 must recolor to "comment"
    // (this is exactly what `changedRanges` widening exists to catch).
    const closeCol = text.split("\n")[1]!.indexOf("*/");
    document.applyEdits([
      { range: { start: { line: 1, character: closeCol }, end: { line: 1, character: closeCol + 2 } }, newText: "" },
    ]);

    await expectAllLinesMatchFresh(service, document, tokenizeWithComments);
    expect(service.getSpansForLine(document.uri, 2)).toEqual([{ startCol: 0, endCol: 10, capture: "comment" }]);
    expect(service.getSpansForLine(document.uri, 3)).toEqual([{ startCol: 0, endCol: 10, capture: "comment" }]);

    // And the inverse — re-terminating the comment SHRINKS the capture
    // back, un-recoloring the lines below.
    document.applyEdits([
      { range: { start: { line: 1, character: closeCol }, end: { line: 1, character: closeCol } }, newText: "*/" },
    ]);
    await expectAllLinesMatchFresh(service, document, tokenizeWithComments);
    expect(service.getSpansForLine(document.uri, 2)[0]).toEqual({ startCol: 0, endCol: 3, capture: "variable" });
  });

  test("a backend WITHOUT changedRanges keeps the full-recompute fallback (differential still holds)", async () => {
    // The plain `createMockBackend` has no `changedRanges` — the service
    // must fall back to the full pass on every edit and stay correct.
    const backend = createMockBackend();
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, backend, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const document = createTestDocument("file:///plain.ts", "typescript", fourLines);
    fakeDocs.open(document);
    await tick();

    document.applyEdits([
      { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 8 } }, newText: "renamed" },
    ]);
    await expectAllLinesMatchFresh(service, document, tokenize);
  });
});

describe("createHighlightService — failure degradation (design.md §14)", () => {
  test("a grammar load failure degrades to plaintext with exactly one warning, even across repeated opens/edits", async () => {
    const log = createHostLog();
    const sink = createRecordingSink();
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(
      buildDeps({
        documents: fakeDocs,
        log,
        sink,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
        assetResolver: {
          resolveGrammar: async () => {
            throw new Error("grammar not found");
          },
          resolveHighlights: async () => "query",
        },
      }),
    );

    const documentA = createTestDocument("file:///a.ts", "typescript", "let x = 1;");
    fakeDocs.open(documentA);
    await tick();
    expect(service.getSpansForLine(documentA.uri, 0)).toEqual([]);
    expect(log.entries().filter((e) => e.level === "warning")).toHaveLength(1);
    expect(sink.errors).toHaveLength(1);

    // A second document of the SAME language: no repeat load attempt, no
    // repeat warning (the failed load's Promise is cached).
    const documentB = createTestDocument("file:///b.ts", "typescript", "let y = 2;");
    fakeDocs.open(documentB);
    await tick();
    expect(log.entries().filter((e) => e.level === "warning")).toHaveLength(1);
    expect(sink.errors).toHaveLength(1);

    // Editing either document never throws and never re-triggers anything.
    expect(() =>
      documentA.applyEdits([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "z" }]),
    ).not.toThrow();
    expect(() =>
      documentB.applyEdits([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "z" }]),
    ).not.toThrow();
    expect(log.entries().filter((e) => e.level === "warning")).toHaveLength(1);
    expect(service.getSpansForLine(documentA.uri, 0)).toEqual([]);
    expect(service.getSpansForLine(documentB.uri, 0)).toEqual([]);
  });

  test("a highlight-query compile failure also degrades to plaintext with one warning", async () => {
    const log = createHostLog();
    const fakeDocs = createFakeDocuments();
    const backend = createMockBackend();
    backend.compileQuery = () => {
      throw new Error("bad query syntax");
    };
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, backend, log, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", "let x = 1;");
    fakeDocs.open(document);
    await tick();

    expect(service.getSpansForLine(document.uri, 0)).toEqual([]);
    expect(log.entries().filter((e) => e.level === "warning")).toHaveLength(1);
  });
});

describe("createHighlightService — construction-time documents + dispose", () => {
  test("a document already open at construction time is tracked without waiting for onDidOpen", async () => {
    const document = createTestDocument("file:///a.ts", "typescript", "foo");
    const fakeDocs = createFakeDocuments([document]);
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    await tick();
    expect(service.getSpansForLine(document.uri, 0)).toEqual([{ startCol: 0, endCol: 3, capture: "variable" }]);
  });

  test("dispose() stops onDidChange from firing further but does not throw", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
    );
    let fired = 0;
    service.onDidChange(() => {
      fired += 1;
    });
    service.dispose();
    expect(() => service.dispose()).not.toThrow(); // Idempotent.

    fakeDocs.open(createTestDocument("file:///a.ts", "typescript", "x"));
    await tick();
    expect(fired).toBe(0);
  });
});
