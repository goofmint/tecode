/**
 * `ParserBackend` (Req 8.1; design.md §10's "THE system SHALL use OpenTUI's
 * web-tree-sitter integration; the core's responsibility SHALL be limited
 * to loading grammars and applying `tokenColors` to captures"): the narrow
 * adapter interface between `highlightService.ts` and whatever actually
 * runs tree-sitter — parser runtime init, grammar loading
 * (`Language.load(bytes)`-style), highlight-query compilation from `.scm`
 * text, incremental `tree.edit()` + re-parse, and capture extraction.
 *
 * **UTF-16 in, UTF-8 hidden inside** (this task's plan: "add a UTF-16→UTF-8
 * byte offset helper if the backend needs byte offsets"): every offset/
 * position this interface exposes — {@link ParserEditDescriptor},
 * {@link ParserCapture} — is in the SAME terms `@tecode/api`'s `Position`
 * and `buffer/lineBuffer.ts`'s `offsetAt`/`positionAt` already use: 0-based
 * UTF-16 code-unit offsets and `{ line, character }`-shaped points (named
 * `row`/`column` here to match tree-sitter's own vocabulary). Real
 * tree-sitter — `web-tree-sitter`'s WASM binding — operates on UTF-8 BYTE
 * offsets internally (its own `.d.ts`: "Parse a slice of UTF8 text", every
 * `Node`/`Edit` field documented as "the byte index/offset"). Rather than
 * leak that detail into `highlightService.ts` (which would then need its
 * own byte-conversion logic ANYWHERE it touches a capture or builds an
 * edit), the conversion is isolated entirely inside
 * {@link createWebTreeSitterParserBackend} — the one module the task's plan
 * calls for ("keep it isolated in this one module") — via
 * {@link utf16OffsetToUtf8Byte}/{@link utf8ByteOffsetToUtf16}. A mock test
 * backend (`highlightService.test.ts`) never needs these at all: it can
 * treat "index"/"position" as whatever unit it likes, since nothing outside
 * this module interprets them.
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

import { Buffer } from "node:buffer";
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
 * {@link createWebTreeSitterParserBackend} derive the post-edit byte
 * offset/position itself from `insertedText`'s own byte length — nothing
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
 * {@link ParserQuery.captures}. */
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
  /** Every capture in `tree`, in tree/document order (this module's
   * TSDoc). */
  captures(tree: ParserTree): ParserCapture[];
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
}

/**
 * The UTF-16 -> UTF-8 byte-offset conversion {@link createWebTreeSitterParserBackend}
 * needs (this module's TSDoc). `utf16Offset` is clamped to `[0,
 * text.length]`. Pure and independently testable without any WASM runtime.
 */
export function utf16OffsetToUtf8Byte(text: string, utf16Offset: number): number {
  const clamped = Math.max(0, Math.min(utf16Offset, text.length));
  return Buffer.byteLength(text.slice(0, clamped), "utf8");
}

/**
 * The inverse of {@link utf16OffsetToUtf8Byte}: the UTF-16 code-unit offset
 * whose UTF-8 byte-encoding prefix length is `byteOffset` into `text`.
 * Iterates by Unicode code point (`for...of` over a string yields one code
 * point per step, correctly grouping surrogate pairs) so astral characters
 * (e.g. emoji) round-trip correctly. Assumes `byteOffset` lands on a code
 * point boundary — guaranteed for any offset tree-sitter itself reports,
 * since it only ever parses valid UTF-8. Out-of-range input clamps to
 * `text.length`.
 */
export function utf8ByteOffsetToUtf16(text: string, byteOffset: number): number {
  const target = Math.max(0, byteOffset);
  let utf16Index = 0;
  let byteCount = 0;
  for (const ch of text) {
    if (byteCount >= target) break;
    byteCount += Buffer.byteLength(ch, "utf8");
    utf16Index += ch.length;
  }
  return utf16Index;
}

/** Split `text` into lines the same way `buffer/lineBuffer.ts`'s
 * `splitIntoLines` does (on any of `\r\n`/`\n`) — duplicated here rather
 * than imported since `lineBuffer.ts` does not export it, and this
 * production-only adapter should not widen that module's surface just for
 * this. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\n/);
}

/** The tree-sitter (byte-based) `Point` for a UTF-16 `ParserPoint` into
 * `text`'s pre-split `lines` — extracts line `point.row` and measures its
 * UTF-8 byte length up to `point.column` UTF-16 units in. Takes the
 * already-split `lines` array (rather than `text` itself) so a caller with
 * several points to convert against the SAME text (`wrapTree.edit`, below)
 * splits it exactly once. */
function toBytePoint(lines: readonly string[], point: ParserPoint): { row: number; column: number } {
  const lineText = lines[point.row] ?? "";
  const col = Math.max(0, Math.min(point.column, lineText.length));
  return { row: point.row, column: Buffer.byteLength(lineText.slice(0, col), "utf8") };
}

/** The tree-sitter (byte-based) `Point` immediately after `insertedText`
 * has been spliced in starting at `startPoint` (both in `lines`' terms,
 * `lines` being the PRE-edit source `startPoint` was resolved against). */
function computeNewEndBytePoint(
  lines: readonly string[],
  startPoint: ParserPoint,
  insertedText: string,
): { row: number; column: number } {
  const startBytePoint = toBytePoint(lines, startPoint);
  const parts = splitLines(insertedText);
  if (parts.length === 1) {
    return { row: startBytePoint.row, column: startBytePoint.column + Buffer.byteLength(insertedText, "utf8") };
  }
  const lastPart = parts[parts.length - 1]!;
  return { row: startBytePoint.row + parts.length - 1, column: Buffer.byteLength(lastPart, "utf8") };
}

/**
 * A one-pass-built offset index over one document text (Finding: "per
 * `captures()` invocation, build ONE offset index... then resolve each
 * capture's start/end via binary search over the line tables + a
 * within-line scan only"). Parallel arrays, one entry per line:
 * `lines[i]` is line `i`'s own text (no line-break characters, matching
 * {@link splitLines}); `utf16LineStarts[i]`/`utf8LineByteStarts[i]` are
 * that line's starting offset in UTF-16 code units / UTF-8 bytes into the
 * WHOLE document. Both start-offset arrays are strictly increasing, so a
 * target offset's line is found by binary search rather than a linear scan
 * from the document start — the fix for `toParserCapture`'s old O(n) per
 * conversion (four conversions per capture, `captures()` mapping over every
 * capture, made highlighting an open document O(n^2) in its length).
 *
 * Exported (alongside {@link buildTextIndex}/{@link resolveByteOffset})
 * purely so `parserBackend.test.ts` can differentially test the indexed
 * path against {@link utf16OffsetToUtf8Byte}/{@link utf8ByteOffsetToUtf16}
 * on multi-byte content, the same "exported for testing, otherwise
 * module-private" treatment those two already get (this module's TSDoc for
 * them) — nothing outside this module has any other reason to import it.
 */
export interface TextIndex {
  lines: readonly string[];
  utf16LineStarts: readonly number[];
  utf8LineByteStarts: readonly number[];
}

/** Build a {@link TextIndex} for `text` in one pass: `\n`/`\r\n` are the
 * only line-break bytes tree-sitter/`lineBuffer.ts` recognize here, and
 * both are pure ASCII, so a break's UTF-16 length (`match[0].length`, 1 or
 * 2) equals its UTF-8 byte length — no separate byte-measuring pass over
 * the breaks themselves is needed. */
export function buildTextIndex(text: string): TextIndex {
  const lines: string[] = [];
  const utf16LineStarts: number[] = [0];
  const utf8LineByteStarts: number[] = [0];
  const breakRe = /\r\n|\n/g;
  let lineStartUtf16 = 0;
  let byteOffset = 0;
  let match: RegExpExecArray | null;
  while ((match = breakRe.exec(text))) {
    const lineText = text.slice(lineStartUtf16, match.index);
    lines.push(lineText);
    byteOffset += Buffer.byteLength(lineText, "utf8") + match[0].length;
    lineStartUtf16 = match.index + match[0].length;
    utf16LineStarts.push(lineStartUtf16);
    utf8LineByteStarts.push(byteOffset);
  }
  lines.push(text.slice(lineStartUtf16));
  return { lines, utf16LineStarts, utf8LineByteStarts };
}

/** The last line index `i` with `starts[i] <= target` (binary search over
 * the strictly-increasing `starts` — {@link TextIndex.utf8LineByteStarts}).
 * `starts` always has at least one entry (`[0]`), so this never runs on an
 * empty array. */
function findLineForOffset(starts: readonly number[], target: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The UTF-16 code-unit offset, within one line's own text, whose UTF-8
 * byte-encoding prefix length is `byteCol` — the same code-point iteration
 * {@link utf8ByteOffsetToUtf16} uses, scoped to a single line (the
 * "within-line scan only" the index above exists to make possible) rather
 * than the whole document. */
function byteColumnToUtf16Column(lineText: string, byteCol: number): number {
  let utf16Index = 0;
  let byteCount = 0;
  for (const ch of lineText) {
    if (byteCount >= byteCol) break;
    byteCount += Buffer.byteLength(ch, "utf8");
    utf16Index += ch.length;
  }
  return utf16Index;
}

/** Resolve one UTF-8 `byteOffset` (a tree-sitter node's `startIndex`/
 * `endIndex`) against `index` into BOTH its UTF-16 offset and its `{ row,
 * column }` point in a single binary search + within-line scan — the two
 * results {@link toParserCapture} needs are computed together here so
 * neither is derived twice (the old code called `utf8ByteOffsetToUtf16`
 * once for the offset and again, redundantly, inside
 * `utf16OffsetToPoint`). Exported for testing only (see {@link TextIndex}'s
 * TSDoc). */
export function resolveByteOffset(index: TextIndex, byteOffset: number): { utf16Offset: number; point: ParserPoint } {
  const target = Math.max(0, byteOffset);
  const row = findLineForOffset(index.utf8LineByteStarts, target);
  const lineText = index.lines[row] ?? "";
  const maxLineBytes = Buffer.byteLength(lineText, "utf8");
  const byteCol = Math.max(0, Math.min(target - index.utf8LineByteStarts[row]!, maxLineBytes));
  const column = byteColumnToUtf16Column(lineText, byteCol);
  return { utf16Offset: index.utf16LineStarts[row]! + column, point: { row, column } };
}

/** {@link ParserTree} plus the (mutable, edit-updated) text it currently
 * reflects — the state {@link createWebTreeSitterParserBackend}'s `edit`/
 * `parse`/`captures` all close over. */
interface TreeState {
  tsTree: TSTree;
  /** The text this tree was last built FROM (the argument to the `parse()`
   * call that produced `tsTree`) — `edit()` needs this to convert its
   * UTF-16 offsets/points to tree-sitter's byte terms (this module's
   * TSDoc); never mutated by `edit()` itself (a stale post-edit-pre-reparse
   * tree is documented as unqueryable, {@link ParserTree.edit}'s TSDoc), so
   * every `edit()` call in a batch converts against the SAME pre-batch
   * text, which is exactly correct as long as the caller applies a batch's
   * edits bottom-up against pre-batch offsets (`highlightService.ts`'s own
   * TSDoc explains why that holds). */
  text: string;
  /** `text` split into lines, lazily computed and cached the first time
   * `edit()` needs it, then reused by every further `edit()` call in the
   * same batch — `text` is never mutated after this `TreeState` is built
   * (a fresh one is created per {@link ParserBackend.parse} call, this
   * field's own TSDoc above), so a cached split is valid for this state's
   * entire lifetime; no invalidation beyond that is needed. Fixes
   * `wrapTree.edit`'s old 3x-`splitLines`(whole document)-per-edit cost. */
  lines?: readonly string[];
}

/** `state.lines`, computing (and caching on `state`) it on first use. */
function getCachedLines(state: TreeState): readonly string[] {
  if (!state.lines) state.lines = splitLines(state.text);
  return state.lines;
}

function wrapTree(state: TreeState): ParserTree & { readonly state: TreeState } {
  return {
    state,
    edit(edit: ParserEditDescriptor): void {
      const startByte = utf16OffsetToUtf8Byte(state.text, edit.startIndex);
      const oldEndByte = utf16OffsetToUtf8Byte(state.text, edit.oldEndIndex);
      const insertedByteLength = Buffer.byteLength(edit.insertedText, "utf8");
      const lines = getCachedLines(state);
      state.tsTree.edit({
        startIndex: startByte,
        oldEndIndex: oldEndByte,
        newEndIndex: startByte + insertedByteLength,
        startPosition: toBytePoint(lines, edit.startPosition),
        oldEndPosition: toBytePoint(lines, edit.oldEndPosition),
        newEndPosition: computeNewEndBytePoint(lines, edit.startPosition, edit.insertedText),
      });
    },
  };
}

function toParserCapture(index: TextIndex, name: string, node: TSNode): ParserCapture {
  const start = resolveByteOffset(index, node.startIndex);
  const end = resolveByteOffset(index, node.endIndex);
  return {
    name,
    startIndex: start.utf16Offset,
    endIndex: end.utf16Offset,
    startPosition: start.point,
    endPosition: end.point,
  };
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
export function createWebTreeSitterParserBackend(): ParserBackend {
  let initPromise: Promise<void> | undefined;
  const parsersByLanguage = new Map<Language, Parser>();

  function init(): Promise<void> {
    if (!initPromise) initPromise = Parser.init();
    return initPromise;
  }

  async function loadLanguage(bytes: Uint8Array): Promise<ParserLanguageHandle> {
    return Language.load(bytes);
  }

  function compileQuery(language: ParserLanguageHandle, querySource: string): ParserQuery {
    const query = new Query(language as Language, querySource);
    return {
      captures(tree: ParserTree): ParserCapture[] {
        const state = (tree as ReturnType<typeof wrapTree>).state;
        const raw = query.captures(state.tsTree.rootNode);
        // One offset index per `captures()` call (this module's
        // `TextIndex` TSDoc) — shared by every capture below, rather than
        // each capture re-scanning the whole document from its start.
        const index = buildTextIndex(state.text);
        return raw.map((c) => toParserCapture(index, c.name, c.node));
      },
    };
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
    return wrapTree({ tsTree, text });
  }

  return { init, loadLanguage, compileQuery, parse };
}
