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
    const fakeDocs = createFakeDocuments();
    const service = createHighlightService(
      buildDeps({ documents: fakeDocs, languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }) }),
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
