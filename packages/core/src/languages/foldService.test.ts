/**
 * Tests for {@link createFoldService} (Issue #150). Like
 * `highlightService.test.ts`, ALL of these use a hand-rolled mock
 * {@link ParserBackend} — never the real `web-tree-sitter`-backed one, and
 * no real grammar/`.scm` files.
 *
 * The mock's fold query reports one region per INDENTED BLOCK of the text
 * the tree was last `parse()`d with: a line ending in `{` opens a region
 * that closes on the matching `}`. That keeps the assertions readable while
 * still making the results depend only on the text the service actually
 * threads through to `parse()` — so an incremental edit and a fresh parse
 * of the same final text can only agree if the service reparses correctly.
 */

import { describe, expect, test } from "bun:test";
import type { Disposable, LanguageContribution, Listener } from "@tecode/api";
import { createDocument, type CoreDocument } from "../buffer/document";
import { createHostLog } from "../host/errors";
import { createFoldService, type FoldServiceDeps } from "./foldService";
import type {
  ParserBackend,
  ParserCapture,
  ParserEditDescriptor,
  ParserLanguageHandle,
  ParserTree,
} from "./parserBackend";

/** Flush enough microtask ticks for the service's `init -> loadLanguage ->
 * resolveFolds -> compileQuery -> parse` chain to settle (same helper, and
 * same reasoning, as `highlightService.test.ts`'s). */
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

/** A minimal fake `documents` slice, with test-only `open`/`close` drivers
 * (copied in shape from `highlightService.test.ts`'s). */
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

/** Brace-matched block regions of `text`, as `ParserCapture`s carrying only
 * the row/column points the fold service actually reads. */
function braceBlocks(text: string): ParserCapture[] {
  const lines = text.split("\n");
  const captures: ParserCapture[] = [];
  const open: number[] = [];
  lines.forEach((line, row) => {
    if (line.trimEnd().endsWith("{")) open.push(row);
    else if (line.trim() === "}") {
      const start = open.pop();
      if (start === undefined) return;
      captures.push({
        name: "fold",
        startIndex: 0,
        endIndex: 0,
        startPosition: { row: start, column: line.length },
        endPosition: { row, column: 1 },
      });
    }
  });
  // Tree order: outermost first, which is what the real query yields.
  return captures.sort((a, b) => a.startPosition.row - b.startPosition.row);
}

interface MockBackend extends ParserBackend {
  parseCount: number;
  compileCount: number;
  editCalls: ParserEditDescriptor[];
}

function createMockBackend(): MockBackend {
  let parseCount = 0;
  let compileCount = 0;
  const editCalls: ParserEditDescriptor[] = [];
  const backend = {
    get parseCount() {
      return parseCount;
    },
    get compileCount() {
      return compileCount;
    },
    editCalls,
    async init() {},
    async loadLanguage(bytes: Uint8Array): Promise<ParserLanguageHandle> {
      return { bytes };
    },
    compileQuery() {
      compileCount += 1;
      return {
        captures(tree: ParserTree) {
          return braceBlocks((tree as unknown as { text: string }).text);
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

function buildDeps(overrides: Partial<FoldServiceDeps> = {}): FoldServiceDeps {
  return {
    documents: createFakeDocuments(),
    languageRegistry: fakeLanguageRegistry({}),
    assetResolver: {
      resolveGrammar: async () => new Uint8Array([1]),
      resolveFolds: async () => "(statement_block) @fold",
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
  folds: "ts.folds.scm",
};

/** The same language WITHOUT a `folds` declaration — the "this language has
 * nothing foldable" case, which must bypass the pipeline entirely. */
const noFoldsContribution: LanguageContribution = {
  id: "typescript",
  extensions: [".ts"],
  grammar: "ts.wasm",
  highlights: "ts.scm",
};

const SOURCE = ["function a() {", "  const x = 1;", "  return x;", "}", "", "const z = 2;"].join("\n");

describe("createFoldService — fold ranges from the query (Issue #150)", () => {
  test("a document with a fold query reports its regions once assets load", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
      }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", SOURCE);
    fakeDocs.open(document);
    await tick();

    expect(service.getFoldRanges(document.uri)).toEqual([{ startLine: 0, endLine: 3 }]);
  });

  test("plaintext bypasses the pipeline entirely — no ranges, no parse", async () => {
    const backend = createMockBackend();
    const fakeDocs = createFakeDocuments();
    const service = createFoldService(buildDeps({ documents: fakeDocs, backend }));
    const document = createTestDocument("file:///a.txt", "plaintext", SOURCE);
    fakeDocs.open(document);
    await tick();

    expect(service.getFoldRanges(document.uri)).toEqual([]);
    expect(backend.parseCount).toBe(0);
  });

  test("a language that declares no `folds` query is bypassed too — no grammar load", async () => {
    const backend = createMockBackend();
    const fakeDocs = createFakeDocuments();
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        backend,
        languageRegistry: fakeLanguageRegistry({ typescript: noFoldsContribution }),
      }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", SOURCE);
    fakeDocs.open(document);
    await tick();

    expect(service.getFoldRanges(document.uri)).toEqual([]);
    expect(backend.parseCount).toBe(0);
    expect(backend.compileCount).toBe(0);
  });

  test("an unknown document reports the same shared empty array", async () => {
    const service = createFoldService(buildDeps());
    expect(service.getFoldRanges("file:///never-opened.ts")).toBe(
      service.getFoldRanges("file:///other.ts"),
    );
  });

  test("a two-line region survives, and a line with no block produces none", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
      }),
    );
    // `{` and the matching `}` sit on adjacent lines, so the region spans
    // rows 0..1 — the narrowest span that still hides something. The
    // trailing statement produces no capture at all.
    const document = createTestDocument("file:///b.ts", "typescript", ["a {", "}", "b;"].join("\n"));
    fakeDocs.open(document);
    await tick();

    expect(service.getFoldRanges(document.uri)).toEqual([{ startLine: 0, endLine: 1 }]);
  });

  // `braceBlocks` can produce neither a single-ROW capture nor one ending at
  // column 0, so on its own it never reaches `recomputeRanges`' two
  // normalizations (CodeRabbit, PR #155). Both are load-bearing for the
  // `FoldRange` contract every consumer relies on — `endLine` strictly
  // greater than `startLine` — so they are pinned here by feeding the
  // service fixed captures directly.
  test("normalizes captures: an equal-row capture is dropped, a column-0 end row is pulled back", async () => {
    const fakeDocs = createFakeDocuments();
    const backend = createMockBackend();
    backend.compileQuery = () => ({
      captures: (): ParserCapture[] => [
        // Starts and ends on the same row: collapsing it would hide
        // nothing, so it must not survive at all.
        {
          name: "fold",
          startIndex: 0,
          endIndex: 0,
          startPosition: { row: 1, column: 0 },
          endPosition: { row: 1, column: 5 },
        },
        // Ends at column 0 of row 3 — the node stops at the line break, so
        // it does not actually occupy row 3 and is pulled back to row 2.
        // This is the shape Markdown `(section)` and YAML `(block_mapping)`
        // really produce.
        {
          name: "fold",
          startIndex: 0,
          endIndex: 0,
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 3, column: 0 },
        },
      ],
    });
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        backend,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
      }),
    );
    const document = createTestDocument("file:///c.ts", "typescript", SOURCE);
    fakeDocs.open(document);
    await tick();

    const ranges = service.getFoldRanges(document.uri);
    expect(ranges).toEqual([{ startLine: 0, endLine: 2 }]);
    // The contract `ui/foldMapping.ts` depends on, asserted directly.
    expect(ranges.every((range) => range.endLine > range.startLine)).toBe(true);
  });
});

describe("createFoldService — edits and lifecycle (Issue #150)", () => {
  test("an edit that grows a block moves its end line", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
      }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", SOURCE);
    fakeDocs.open(document);
    await tick();
    expect(service.getFoldRanges(document.uri)).toEqual([{ startLine: 0, endLine: 3 }]);

    // Insert one more statement line inside the block.
    document.applyEdits([
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, newText: "  y();\n" },
    ]);
    await tick();

    expect(service.getFoldRanges(document.uri)).toEqual([{ startLine: 0, endLine: 4 }]);
  });

  test("an edit that changes nothing foldable keeps the SAME array reference", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
      }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", SOURCE);
    fakeDocs.open(document);
    await tick();
    const before = service.getFoldRanges(document.uri);

    // A same-line edit well inside the block — the region's own rows are
    // unchanged, so the reference-stability contract says the array must
    // not be replaced.
    document.applyEdits([
      { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, newText: "/*x*/" },
    ]);
    await tick();

    expect(service.getFoldRanges(document.uri)).toBe(before);
  });

  test("onDidChange fires after a reparse, and stops once disposed", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
      }),
    );
    let fired = 0;
    const sub = service.onDidChange(() => {
      fired += 1;
    });
    const document = createTestDocument("file:///a.ts", "typescript", SOURCE);
    fakeDocs.open(document);
    await tick();
    expect(fired).toBeGreaterThan(0);

    const afterOpen = fired;
    sub.dispose();
    document.applyEdits([
      { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, newText: "z" },
    ]);
    await tick();
    expect(fired).toBe(afterOpen);
  });

  test("closing a document drops its ranges", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
      }),
    );
    const document = createTestDocument("file:///a.ts", "typescript", SOURCE);
    fakeDocs.open(document);
    await tick();
    expect(service.getFoldRanges(document.uri).length).toBe(1);

    fakeDocs.close(document);
    expect(service.getFoldRanges(document.uri)).toEqual([]);
  });

  test("a document already open at construction time is picked up", async () => {
    const document = createTestDocument("file:///a.ts", "typescript", SOURCE);
    const fakeDocs = createFakeDocuments([document]);
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
      }),
    );
    await tick();
    expect(service.getFoldRanges(document.uri)).toEqual([{ startLine: 0, endLine: 3 }]);
  });
});

describe("createFoldService — failure degradation (Issue #150)", () => {
  test("a fold query that fails to load disables folding for that language, warned once", async () => {
    const fakeDocs = createFakeDocuments();
    const sink = createRecordingSink();
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        sink,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
        assetResolver: {
          resolveGrammar: async () => new Uint8Array([1]),
          resolveFolds: async () => {
            throw new Error("nope.scm missing");
          },
        },
      }),
    );
    fakeDocs.open(createTestDocument("file:///a.ts", "typescript", SOURCE));
    fakeDocs.open(createTestDocument("file:///b.ts", "typescript", SOURCE));
    await tick();

    expect(service.getFoldRanges("file:///a.ts")).toEqual([]);
    expect(sink.errors.length).toBe(1);
    expect(sink.errors[0]).toContain("code folding is disabled");
    // The wording must make clear highlighting is NOT affected — the whole
    // reason this is a separate service.
    expect(sink.errors[0]).toContain("syntax highlighting is unaffected");
  });

  test("whenIdle resolves even after a failed load", async () => {
    const fakeDocs = createFakeDocuments();
    const service = createFoldService(
      buildDeps({
        documents: fakeDocs,
        languageRegistry: fakeLanguageRegistry({ typescript: tsContribution }),
        assetResolver: {
          resolveGrammar: async () => {
            throw new Error("no grammar");
          },
          resolveFolds: async () => "",
        },
      }),
    );
    fakeDocs.open(createTestDocument("file:///a.ts", "typescript", SOURCE));
    await service.whenIdle();
    expect(service.getFoldRanges("file:///a.ts")).toEqual([]);
  });
});
