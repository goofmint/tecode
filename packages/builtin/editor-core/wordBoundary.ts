/**
 * Word-boundary computation for `editor.action.cursorWordLeft`/
 * `cursorWordRight` (Req 11.1; design.md §13's "pure command handlers over
 * `tecode.editor`"), over a single line of text.
 *
 * A line is first split into grapheme clusters via `Intl.Segmenter`
 * (`granularity: "grapheme"`) so a multi-code-unit glyph (a surrogate-pair
 * emoji, a combining-mark sequence) always moves as one unit rather than
 * splitting mid-glyph — the same "walk `Intl.Segmenter` grapheme clusters"
 * approach `@tecode/core`'s `ui/cellWidth.ts` uses for cell-width
 * measurement (duplicated in spirit, not in code: `editor-core` cannot
 * import `@tecode/core` — the ESLint layering rule in `eslint.config.mjs`
 * — so this is its own small, self-contained implementation).
 *
 * Each grapheme is then classified into one of four VS Code-style classes
 * (this module's `CharClass`), and word-left/right walk a maximal run of
 * one class, then any trailing/leading whitespace, landing at the boundary
 * of the next/previous token — the standard "ctrl+arrow" word-navigation
 * convention. `"cjk"` is deliberately its OWN singleton class (never grouped
 * with an adjacent character of the same class, even another `cjk`
 * character) since CJK text has no spaces between words — each ideograph is
 * its own stop, matching how most editors navigate CJK text one character
 * at a time.
 */

/** One grapheme's word-navigation class. `"word"` is letters/digits/
 * underscore (Unicode-aware — `\p{L}`/`\p{N}` cover non-Latin word
 * scripts); `"cjk"` is any Unicode Ideographic character (CJK Han
 * ideographs); `"punct"` is everything else that isn't whitespace. */
export type CharClass = "space" | "word" | "cjk" | "punct";

/** Classify a single Unicode code point (this module's TSDoc). Order
 * matters: Ideographic must be checked before the general "word" test,
 * since Han ideographs also match `\p{L}`. */
function classifyCodePoint(codePoint: number): CharClass {
  const ch = String.fromCodePoint(codePoint);
  if (/\s/u.test(ch)) return "space";
  if (/\p{Ideographic}/u.test(ch)) return "cjk";
  if (/[\p{L}\p{N}_]/u.test(ch)) return "word";
  return "punct";
}

/** One grapheme cluster's span within a line, plus its {@link CharClass}. */
interface Grapheme {
  start: number;
  end: number;
  cls: CharClass;
}

/** A shared, stateless grapheme segmenter (Intl.Segmenter instances are
 * expensive to construct repeatedly and hold no per-call state worth
 * isolating). */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Split `line` into its grapheme clusters, each classified (this module's
 * TSDoc). Exported for {@link module:./movement} and {@link
 * module:./editing}, which need the same grapheme stepping for plain
 * left/right cursor movement and backspace/delete. */
export function toGraphemes(line: string): Grapheme[] {
  if (line.length === 0) return [];
  const result: Grapheme[] = [];
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(line)) {
    const codePoint = segment.codePointAt(0) ?? 0;
    result.push({ start: index, end: index + segment.length, cls: classifyCodePoint(codePoint) });
  }
  return result;
}

/**
 * The character offset one grapheme to the LEFT of `character` in `line`,
 * or `0` if `character` is already at (or before) the line's start.
 * Grapheme-aware (this module's TSDoc): a multi-code-unit glyph steps as
 * one unit, not one UTF-16 code unit at a time.
 */
export function previousGraphemeStart(line: string, character: number): number {
  if (character <= 0) return 0;
  const graphemes = toGraphemes(line);
  for (let i = graphemes.length - 1; i >= 0; i--) {
    if (graphemes[i]!.end <= character) return graphemes[i]!.start;
  }
  return 0;
}

/**
 * The character offset one grapheme to the RIGHT of `character` in `line`,
 * or `line.length` if `character` is already at (or past) the line's end.
 * Grapheme-aware — see {@link previousGraphemeStart}.
 */
export function nextGraphemeEnd(line: string, character: number): number {
  if (character >= line.length) return line.length;
  const graphemes = toGraphemes(line);
  for (const g of graphemes) {
    if (g.start >= character) return g.end;
  }
  return line.length;
}

/**
 * Word-right (this module's TSDoc): from `character` in `line`, consume the
 * rest of the current token (if `character` sits inside/at the start of
 * one — a run of the same {@link CharClass}, a lone character for `"cjk"`),
 * THEN any following whitespace, landing at the start of whatever token
 * comes next (or `line.length` if none) — matching VS Code's default
 * `cursorWordRight`: from the start of `"foo bar"`, one word-right lands
 * right before `"bar"`, not right after `"foo"`. If `character` is already
 * inside a whitespace run, only the whitespace-skipping step runs, landing
 * at the start of the next token. Never moves past `line.length` — crossing
 * to the next line is the caller's job (`movement.ts`).
 */
export function wordBoundaryRight(line: string, character: number): number {
  const graphemes = toGraphemes(line);
  if (graphemes.length === 0 || character >= line.length) return line.length;

  let idx = graphemes.findIndex((g) => g.start >= character);
  if (idx === -1) return line.length;

  const currentClass = graphemes[idx]!.cls;
  if (currentClass !== "space") {
    idx++;
    if (currentClass !== "cjk") {
      while (idx < graphemes.length && graphemes[idx]!.cls === currentClass) idx++;
    }
  }
  while (idx < graphemes.length && graphemes[idx]!.cls === "space") idx++;

  return idx < graphemes.length ? graphemes[idx]!.start : line.length;
}

/**
 * Word-left — the mirror of {@link wordBoundaryRight}: from `character`,
 * skip any whitespace immediately to the left, then consume the rest of
 * the previous token (a run of one {@link CharClass}, a lone character for
 * `"cjk"`), and return that token's start (or `0` if none). Never moves
 * before `0` — crossing to the previous line is the caller's job
 * (`movement.ts`).
 */
export function wordBoundaryLeft(line: string, character: number): number {
  const graphemes = toGraphemes(line);
  if (graphemes.length === 0 || character <= 0) return 0;

  let idx = graphemes.length - 1;
  while (idx >= 0 && graphemes[idx]!.start >= character) idx--;
  if (idx < 0) return 0;

  while (idx >= 0 && graphemes[idx]!.cls === "space") idx--;
  if (idx < 0) return 0;

  const currentClass = graphemes[idx]!.cls;
  if (currentClass !== "cjk") {
    while (idx > 0 && graphemes[idx - 1]!.cls === currentClass) idx--;
  }

  return graphemes[idx]!.start;
}
