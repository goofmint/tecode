/**
 * `ParserBackend` (Req 8.1; design.md §10's "THE system SHALL use OpenTUI's
 * web-tree-sitter integration; the core's responsibility SHALL be limited
 * to loading grammars and applying `tokenColors` to captures"): the narrow
 * adapter interface between `highlightService.ts` and whatever actually
 * runs tree-sitter — parser runtime init, grammar loading
 * (`Language.load(bytes)`-style), highlight-query compilation from `.scm`
 * text, incremental `tree.edit()` + re-parse, capture extraction (whole
 * document or range-restricted), and changed-range reporting.
 *
 * **Coordinate space: UTF-16 code units, end to end** (Req 13.1 finding,
 * recorded here because it CORRECTS this module's earlier design): every
 * offset/position this interface exposes — {@link ParserEditDescriptor},
 * {@link ParserCapture}, {@link ParserRange} — is in the SAME terms
 * `@tecode/api`'s `Position` and `buffer/lineBuffer.ts`'s
 * `offsetAt`/`positionAt` already use: 0-based UTF-16 code-unit offsets and
 * `{ line, character }`-shaped points (named `row`/`column` here to match
 * tree-sitter's own vocabulary). Crucially, `web-tree-sitter`'s JS-facing
 * API is ALSO in UTF-16 code units, despite its `.d.ts` documenting every
 * index as "the byte offset": its WASM glue parses JS strings as
 * `TSInputEncodingUTF16LE` and converts every internal byte offset at the
 * boundary (`lib/tree-sitter.c`'s `code_unit_to_byte`/`byte_to_code_unit`
 * — applied to node indexes, point columns, edit fields, and
 * `getChangedRanges` results alike; every UTF-16LE code unit is exactly 2
 * bytes, so the conversion is exact). Verified empirically in this repo:
 * parsing `const café = "😀"; …` puts the `café` identifier capture at
 * code-unit offsets 6-10 (UTF-8 bytes would be 6-11) and the emoji string
 * at 13-17. This module therefore passes offsets/points STRAIGHT THROUGH —
 * an earlier revision converted everything to UTF-8 bytes
 * (`utf16OffsetToUtf8Byte` and friends, now removed), which happened to
 * work for pure-ASCII documents (where the two spaces coincide) but was
 * wrong for any multi-byte document AND cost an O(document) offset-index
 * build on every `captures()` call.
 *
 * **One `web-tree-sitter@0.25.10` bug shapes the ranged-query wiring**:
 * `QueryOptions.startIndex`/`endIndex` are fed to
 * `ts_query_cursor_set_byte_range` WITHOUT the code-unit conversion the
 * glue applies everywhere else (`lib/tree-sitter.c`'s
 * `ts_query_matches_wasm`/`ts_query_captures_wasm`), so index-restricted
 * queries silently restrict to HALF the intended range.
 * `QueryOptions.startPosition`/`endPosition` ARE converted correctly, so
 * {@link createWebTreeSitterParserBackend} restricts ranged `captures()`
 * calls by POSITION only (a {@link ParserRange} carries both forms; mock
 * backends in tests are free to use the index form).
 *
 * **Production wiring choice**: `web-tree-sitter@0.25.10` is a peer
 * dependency of `@opentui/core` (its own `package.json`) but was not
 * resolvable from `@tecode/core` until this task added it as a direct
 * dependency too — `@opentui/core` exposes no tree-sitter integration of
 * its own to route through (no such export exists on its public API), so
 * this module imports `web-tree-sitter` directly. Verified to load under
 * Bun (`bun -e "import('web-tree-sitter')"` resolves `Parser`/`Language`/
 * `Query`/`Tree` with no native-binding errors).
 */

import { Language, Parser, Query, type Node as TSNode, type Tree as TSTree } from "web-tree-sitter";

/** A row/column point, in UTF-16 terms (this module's TSDoc) — `row` is a
 * 0-based line number (matches `Position.line`), `column` a 0-based UTF-16
 * code-unit offset within that line (matches `Position.character`). Named
 * `row`/`column` (tree-sitter's own vocabulary) rather than `line`/
 * `character` so a `ParserPoint` is never mistaken for an `@tecode/api`
 * `Position` — this interface is core-internal, one layer below it. */
export interface ParserPoint {
  row: number;
  column: number;
}

/** One text-document edit, in UTF-16 terms (this module's TSDoc), ready for
 * {@link ParserTree.edit}. `insertedText` is the text that now occupies
 * `[startIndex, startIndex + insertedText.length)` — carrying it directly
 * (rather than a separate `newEndIndex`/`newEndPosition` the caller would
 * have to compute) is what lets `highlightService.ts` build this straight
 * from a `TextEdit`'s own `range`/`newText`, and lets
 * {@link createWebTreeSitterParserBackend} derive the post-edit end
 * offset/position itself via {@link computeInsertedEndPoint} — nothing
 * else needs the OLD tree's post-edit state to already be known. */
export interface ParserEditDescriptor {
  /** UTF-16 offset where the edit starts, into the text the tree currently
   * reflects. */
  startIndex: number;
  /** UTF-16 offset where the REPLACED range ends, into the text the tree
   * currently reflects (before this edit). */
  oldEndIndex: number;
  /** The text that now occupies `[startIndex, oldEndIndex)`. */
  insertedText: string;
  startPosition: ParserPoint;
  oldEndPosition: ParserPoint;
}

/** A half-open range `[start, end)` into a tree's current text, in UTF-16
 * terms (this module's TSDoc), described BOTH as code-unit offsets and as
 * points — the same dual shape as real tree-sitter's own `Range` struct.
 * Both forms MUST describe the same two locations; which form a backend
 * consumes is its own business ({@link createWebTreeSitterParserBackend}
 * restricts queries by position only, because of the
 * `startIndex`-conversion bug this module's TSDoc records; the hand-rolled
 * mock backends in tests filter by offset). Used to restrict a
 * {@link ParserQuery.captures} call and to report
 * {@link ParserBackend.changedRanges} (Req 13.1: per-keystroke highlight
 * cost proportional to the edit, not the document). */
export interface ParserRange {
  startIndex: number;
  endIndex: number;
  startPosition: ParserPoint;
  endPosition: ParserPoint;
}

/** One syntax-highlight capture, in UTF-16 terms (this module's TSDoc) —
 * `name` is the capture's name from the `.scm` query (e.g. `"function"`,
 * `"function.builtin"`), resolved to a style via `themeLoader.ts`'s
 * `resolveCaptureStyle` longest-prefix fallback (design.md §9, §10). */
export interface ParserCapture {
  name: string;
  startIndex: number;
  endIndex: number;
  startPosition: ParserPoint;
  endPosition: ParserPoint;
}

/** A compiled tree-sitter syntax tree, kept in sync with its document via
 * {@link edit} (incremental) + a fresh {@link ParserBackend.parse} call
 * (this module's TSDoc). Opaque to `highlightService.ts` beyond this one
 * method — everything else (captures, node access) goes through
 * {@link ParserQuery.captures}/{@link ParserBackend.changedRanges}. */
export interface ParserTree {
  /** Apply one text edit's effect to this tree's internal node offsets
   * (real tree-sitter's `Tree#edit`) — MUST be followed by a
   * {@link ParserBackend.parse} call passing this tree back as `oldTree`
   * before the tree is queried again; a queried-but-not-reparsed tree
   * after an edit has undefined capture results (mirrors real
   * tree-sitter's own contract). */
  edit(edit: ParserEditDescriptor): void;
}

/** A compiled highlight query, bound to one {@link ParserLanguageHandle}
 * (real tree-sitter queries are per-language — running a query compiled
 * for a different language than the tree it's given throws, matching
 * `web-tree-sitter`'s own behavior). */
export interface ParserQuery {
  /** Every capture in `tree`, in tree/document order (this module's TSDoc).
   *
   * `range`, when given, restricts the query to `range`'s neighborhood
   * (real tree-sitter's query-cursor range restriction): the result is
   * guaranteed to include EVERY capture intersecting `range` — including
   * ones that merely START before it and extend into it (verified
   * empirically against `web-tree-sitter@0.25.10`: a template-literal
   * `string` capture spanning the range's start is returned) — but is a
   * SUPERSET, not an exact filter: tree-sitter may also return nearby
   * captures entirely outside `range` (also observed empirically), so a
   * caller must clamp what it does with the results to the region it asked
   * about (`highlightService.ts`'s ranged recompute does exactly that).
   * Captures keep the same relative (tree/document) order as an unranged
   * call. */
  captures(tree: ParserTree, range?: ParserRange): ParserCapture[];
}

/** An opaque, backend-defined handle to one loaded grammar — passed back
 * into {@link ParserBackend.compileQuery}/{@link ParserBackend.parse}
 * unchanged; `highlightService.ts` never inspects its shape. */
export type ParserLanguageHandle = object;

/** The parser backend's public surface (Req 8.1, design.md §10). */
export interface ParserBackend {
  /** Idempotent runtime initialization (real tree-sitter's `Parser.init()`
   * — must settle before any grammar is loaded or parsed). Safe to call
   * more than once; concurrent callers share the same in-flight
   * initialization. */
  init(): Promise<void>;
  /** Load one grammar from its WASM bytes (real tree-sitter's
   * `Language.load(bytes)`, Req 8.2's "`grammar` (path to a tree-sitter
   * WASM grammar)"). */
  loadLanguage(bytes: Uint8Array): Promise<ParserLanguageHandle>;
  /** Compile one language's `highlights.scm` query text (Req 8.2's
   * "`highlights` (query file)"). */
  compileQuery(language: ParserLanguageHandle, querySource: string): ParserQuery;
  /** Parse `text` for `language`. `oldTree`, when given, must have already
   * had every edit since it was produced applied via
   * {@link ParserTree.edit} (real tree-sitter's incremental reparse
   * contract) — omitted for a document's first parse. */
  parse(language: ParserLanguageHandle, text: string, oldTree?: ParserTree): ParserTree;
  /** The ranges whose syntactic structure changed between `oldTree` (the
   * tree that was passed to {@link parse} as its `oldTree`, AFTER its
   * {@link ParserTree.edit} calls) and `newTree` (that `parse` call's
   * result) — real tree-sitter's `Tree#getChangedRanges`, with both ends
   * of each range expressed in the NEW text's coordinates (both trees are
   * aligned to it once the edits have been applied). This is what lets
   * `highlightService.ts` catch cascading recolors — an edit whose
   * highlight effect extends far beyond the edited lines (e.g. opening an
   * unterminated template literal recolors the rest of the file) — and
   * widen its ranged recompute accordingly (Req 13.1). Note the converse
   * does NOT hold: an edit that only stretches a single token (typing
   * inside an identifier or literal) can yield NO changed ranges at all
   * (observed empirically), which is why the service always unions these
   * with the edit's own dirty range. OPTIONAL: a backend without it (e.g.
   * a minimal test mock) simply causes the service to fall back to a
   * full-document recompute on every edit — correct, just slow. */
  changedRanges?(oldTree: ParserTree, newTree: ParserTree): ParserRange[];
}

/** Split `text` into lines the same way `buffer/lineBuffer.ts`'s
 * `splitIntoLines` does (on any of `\r\n`/`\n`) — duplicated here rather
 * than imported since `lineBuffer.ts` does not export it, and this
 * production-only adapter should not widen that module's surface just for
 * this. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\n/);
}

/**
 * The {@link ParserPoint} immediately after `insertedText` has been
 * spliced in starting at `startPoint` — the `newEndPosition` a
 * {@link ParserTree.edit} call must hand real tree-sitter, derived here so
 * callers only ever describe an edit by its start + inserted text
 * ({@link ParserEditDescriptor}'s TSDoc). Pure UTF-16 arithmetic (this
 * module's TSDoc: no byte conversion exists anywhere in this space).
 * Exported for testing only — nothing outside this module has any other
 * reason to import it.
 */
export function computeInsertedEndPoint(startPoint: ParserPoint, insertedText: string): ParserPoint {
  const parts = splitLines(insertedText);
  if (parts.length === 1) {
    return { row: startPoint.row, column: startPoint.column + insertedText.length };
  }
  return { row: startPoint.row + parts.length - 1, column: parts[parts.length - 1]!.length };
}

/** {@link ParserTree} plus the underlying `web-tree-sitter` tree it wraps —
 * the state {@link createWebTreeSitterParserBackend}'s `edit`/`parse`/
 * `captures`/`changedRanges` all close over. (An earlier revision also
 * carried the tree's source text plus lazily-built line/offset indexes for
 * UTF-8 byte conversion — all removed with the conversion layer itself,
 * this module's TSDoc.) */
interface TreeState {
  tsTree: TSTree;
}

function wrapTree(state: TreeState): ParserTree & { readonly state: TreeState } {
  return {
    state,
    edit(edit: ParserEditDescriptor): void {
      // Offsets and points pass straight through — `web-tree-sitter`'s
      // JS-facing `Edit` fields are UTF-16 code units (this module's
      // TSDoc), the exact space `ParserEditDescriptor` is specified in.
      state.tsTree.edit({
        startIndex: edit.startIndex,
        oldEndIndex: edit.oldEndIndex,
        newEndIndex: edit.startIndex + edit.insertedText.length,
        startPosition: edit.startPosition,
        oldEndPosition: edit.oldEndPosition,
        newEndPosition: computeInsertedEndPoint(edit.startPosition, edit.insertedText),
      });
    },
  };
}

function toParserCapture(name: string, node: TSNode): ParserCapture {
  // Direct field mapping — node indexes/point columns are already UTF-16
  // code units (this module's TSDoc), so no per-capture conversion (and no
  // O(document) offset index to build) exists on this path at all.
  return {
    name,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    startPosition: { row: node.startPosition.row, column: node.startPosition.column },
    endPosition: { row: node.endPosition.row, column: node.endPosition.column },
  };
}

/** Dependencies for {@link createWebTreeSitterParserBackend}. */
export interface WebTreeSitterParserBackendDeps {
  /**
   * `web-tree-sitter`'s OWN Emscripten-compiled runtime wasm
   * (`node_modules/web-tree-sitter/tree-sitter.wasm` — the tree-sitter C
   * library itself, distinct from any grammar's `.wasm`), pre-supplied as
   * raw bytes so `Parser.init()` never needs to resolve a `tree-sitter.wasm`
   * path off the real filesystem. Bytes (not a path/`locateFile` callback)
   * because that's deterministic under Bun (`NOTICE.md`'s "Compiled-mode
   * finding for Task 4.4"): a relocated-path callback still has to resolve
   * to something readable, which is exactly what fails inside a `bun build
   * --compile` binary (`/$bunfs/root/tree-sitter.wasm` `ENOENT`) — bytes
   * sidestep the lookup entirely, in BOTH `bun run` and a compiled binary.
   * A thunk (not just `Uint8Array`) so a caller can defer the actual read
   * (`Bun.file(path).bytes()`) until `init()` is first called, matching
   * `assets.ts`'s own "only read what's actually used" shape — resolved at
   * most once, the first time {@link ParserBackend.init} runs (this
   * function's `init`'s own in-flight-promise caching already guarantees
   * that). Omitted entirely (the pre-existing behavior): `Parser.init()`
   * runs with no module options, which resolves `tree-sitter.wasm` from
   * `node_modules` under plain `bun run`/`bun test` but fails inside a
   * compiled binary — `packages/cli`'s composition root is the one place
   * that supplies this, embedding `web-tree-sitter/tree-sitter.wasm` the
   * same way `languages-basic/assets.ts` embeds grammar wasms (`@tecode/
   * core` cannot carry the asset itself — it has no bundler-visible file to
   * embed from its own package).
   */
  runtimeWasm?: Uint8Array | (() => Promise<Uint8Array>);
}

/**
 * The production {@link ParserBackend} (Req 8.1, design.md §10), delegating
 * to `web-tree-sitter` (this module's TSDoc for the wiring choice). Every
 * grammar gets its own cached `Parser` instance (`web-tree-sitter`'s
 * `Parser#setLanguage` is per-instance state, so reusing one `Parser` across
 * documents of the SAME language is safe — `parse` is synchronous and this
 * codebase's host is single-threaded — while different languages need
 * their own).
 */
export function createWebTreeSitterParserBackend(deps: WebTreeSitterParserBackendDeps = {}): ParserBackend {
  const { runtimeWasm } = deps;
  let initPromise: Promise<void> | undefined;
  const parsersByLanguage = new Map<Language, Parser>();

  function init(): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        if (!runtimeWasm) {
          await Parser.init();
          return;
        }
        // `web-tree-sitter`'s own `.d.ts` types `Parser.init`'s parameter as
        // an ambient `EmscriptenModule` this codebase pulls in no type
        // package for; `wasmBinary` is real, documented Emscripten-module
        // config (`web-tree-sitter`'s compiled glue reads `Module
        // ["wasmBinary"]` directly, this module's TSDoc) that the narrowed
        // local type below is enough to invoke it with.
        const wasmBinary = typeof runtimeWasm === "function" ? await runtimeWasm() : runtimeWasm;
        const initWithWasmBinary = Parser.init as (moduleOptions?: { wasmBinary: Uint8Array }) => Promise<void>;
        await initWithWasmBinary({ wasmBinary });
      })();
    }
    return initPromise;
  }

  async function loadLanguage(bytes: Uint8Array): Promise<ParserLanguageHandle> {
    return Language.load(bytes);
  }

  function compileQuery(language: ParserLanguageHandle, querySource: string): ParserQuery {
    const query = new Query(language as Language, querySource);
    return {
      captures(tree: ParserTree, range?: ParserRange): ParserCapture[] {
        const state = (tree as ReturnType<typeof wrapTree>).state;
        // Range restriction by POSITION only — `QueryOptions.startIndex`/
        // `endIndex` hit the code-unit-conversion bug this module's TSDoc
        // records (they'd restrict to half the intended range), while
        // `startPosition`/`endPosition` are converted correctly by the
        // glue.
        const raw = range
          ? query.captures(state.tsTree.rootNode, {
              startPosition: range.startPosition,
              endPosition: range.endPosition,
            })
          : query.captures(state.tsTree.rootNode);
        return raw.map((c) => toParserCapture(c.name, c.node));
      },
    };
  }

  function changedRanges(oldTree: ParserTree, newTree: ParserTree): ParserRange[] {
    const oldState = (oldTree as ReturnType<typeof wrapTree>).state;
    const newState = (newTree as ReturnType<typeof wrapTree>).state;
    // Per real tree-sitter's contract (`Tree#getChangedRanges`'s own docs:
    // "call it on the old tree that was passed to parse, and pass the new
    // tree that was returned"). The glue converts each reported range's
    // offsets and point columns to UTF-16 code units on the way out
    // (`lib/tree-sitter.c`'s `unmarshal_range` path — this module's TSDoc),
    // so the fields map straight through.
    return oldState.tsTree.getChangedRanges(newState.tsTree).map((r) => ({
      startIndex: r.startIndex,
      endIndex: r.endIndex,
      startPosition: { row: r.startPosition.row, column: r.startPosition.column },
      endPosition: { row: r.endPosition.row, column: r.endPosition.column },
    }));
  }

  function getOrCreateParser(language: Language): Parser {
    let parser = parsersByLanguage.get(language);
    if (!parser) {
      parser = new Parser();
      parser.setLanguage(language);
      parsersByLanguage.set(language, parser);
    }
    return parser;
  }

  function parse(languageHandle: ParserLanguageHandle, text: string, oldTree?: ParserTree): ParserTree {
    const language = languageHandle as Language;
    const parser = getOrCreateParser(language);
    const rawOldTree = oldTree ? (oldTree as ReturnType<typeof wrapTree>).state.tsTree : null;
    const tsTree = parser.parse(text, rawOldTree);
    if (!tsTree) {
      // Per web-tree-sitter's own contract, `parse()` returns `null` only
      // when no language has been assigned yet or a progress callback
      // cancelled — neither applies here (`setLanguage` always precedes
      // this call, and no progress callback is ever passed) — surfaced as
      // a thrown error rather than silently returning a garbage tree, so
      // `highlightService.ts`'s own try/catch degrades the language to
      // plaintext with its one-time warning (design.md §14) instead of a
      // confusing downstream crash.
      throw new Error("web-tree-sitter: parse() returned null");
    }
    return wrapTree({ tsTree });
  }

  return { init, loadLanguage, compileQuery, parse, changedRanges };
}
