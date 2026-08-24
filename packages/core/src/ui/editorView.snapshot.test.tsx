/**
 * `EditorView` tests (Req 6.5, 6.6, 13.1; design.md §8.3): gutter/selection/
 * cursor rendering via `@opentui/react/test-utils`'s headless renderer (see
 * `shell.snapshot.test.tsx`'s top-of-file TSDoc for the full writeup of this API),
 * the dirty-range-only re-render guarantee, and the `editorTextFocus`
 * context-key wiring.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { CapturedFrame } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { Disposable, ResolvedTheme, Selection } from "@tecode/api";
import { createBaseTheme } from "../api/stubs";
import { createHostLog } from "../host/errors";
import { createDocument, type CoreDocument } from "../buffer/document";
import type { HighlightSpan } from "../languages/highlightService";
import type { ConfigService } from "../config/service";
import { ThemeProvider, toColorInput } from "./theme";
import { createInitialEditorState, createInitialFindState, type EditorState, type FindState } from "./editorState";
import { EditorView } from "./editorView";

function createRecordingSink() {
  return { error() {} };
}

function createTestDocument(text: string): CoreDocument {
  return createDocument({
    uri: "file:///a.txt",
    languageId: "plaintext",
    text,
    sink: createRecordingSink(),
    log: createHostLog(),
  });
}

function cursorAt(line: number, character: number): Selection {
  const pos = { line, character };
  return { start: pos, end: pos, anchor: pos, active: pos };
}

/** A left-to-right selection with `active` at the end (the common case: the
 * caret trails the selection, as it does after shift-selecting forward). */
function selectionAt(startLine: number, startChar: number, endLine: number, endChar: number): Selection {
  const start = { line: startLine, character: startChar };
  const end = { line: endLine, character: endChar };
  return { start, end, anchor: start, active: end };
}

function stateWith(documentUri: string, selections: Selection[], scrollTop = 0): EditorState {
  return { documentUri, selections, scrollTop };
}

/** {@link stateWith} plus an open `find` state — for the find-match overlay
 * tests below (Req 11.1). */
function stateWithFind(
  documentUri: string,
  selections: Selection[],
  find: Partial<FindState>,
): EditorState {
  return { ...stateWith(documentUri, selections), find: { ...createInitialFindState(), isOpen: true, ...find } };
}

/** All spans across every row of a captured frame, flattened with their row
 * index — convenient for "find the span covering column X on row Y"
 * assertions without hand-walking `frame.lines`. */
function flatten(frame: CapturedFrame): Array<{ row: number; col: number; text: string; fg: unknown; bg: unknown }> {
  const out: Array<{ row: number; col: number; text: string; fg: unknown; bg: unknown }> = [];
  frame.lines.forEach((line, row) => {
    let col = 0;
    for (const span of line.spans) {
      out.push({ row, col, text: span.text, fg: span.fg, bg: span.bg });
      col += span.width;
    }
  });
  return out;
}

const baseTheme = createBaseTheme();

describe("EditorView — basic rendering (Req 6.5)", () => {
  test("renders visible line text with a line-number gutter", async () => {
    const document = createTestDocument("first\nsecond\nthird");
    const state = createInitialEditorState(document.uri);

    const { renderOnce, captureCharFrame } = await testRender(
      <EditorView document={document} state={state} viewportHeight={5} />,
      { width: 40, height: 6 },
    );
    await act(async () => {
      await renderOnce();
    });

    const frame = captureCharFrame();
    expect(frame).toContain("first");
    expect(frame).toContain("second");
    expect(frame).toContain("third");
    // 3 lines -> 1-digit gutter + 1 padding space.
    expect(frame).toMatch(/1 first/);
    expect(frame).toMatch(/2 second/);
    expect(frame).toMatch(/3 third/);
  });

  test("editor.lineNumbers can be hidden via a config seam", async () => {
    const document = createTestDocument("alpha\nbeta");
    const state = createInitialEditorState(document.uri);
    const fakeConfig = { get: () => false } as unknown as import("../config/service").ConfigService;

    const { renderOnce, captureCharFrame } = await testRender(
      <EditorView document={document} state={state} viewportHeight={4} config={fakeConfig} />,
      { width: 40, height: 5 },
    );
    await act(async () => {
      await renderOnce();
    });

    const frame = captureCharFrame();
    expect(frame).toContain("alpha");
    expect(frame).not.toMatch(/1 alpha/);
  });
});

describe("EditorView — gutter digit-count boundaries (design.md §8.3, 9/10/100 lines)", () => {
  test("9 lines -> 1-digit gutter", async () => {
    const document = createTestDocument(Array.from({ length: 9 }, (_, i) => `L${i}`).join("\n"));
    const state = createInitialEditorState(document.uri);
    const { renderOnce, captureCharFrame } = await testRender(
      <EditorView document={document} state={state} viewportHeight={9} />,
      { width: 30, height: 10 },
    );
    await act(async () => {
      await renderOnce();
    });
    const frame = captureCharFrame();
    expect(frame).toMatch(/1 L0/);
    expect(frame).toMatch(/9 L8/);
  });

  test("10 lines -> 2-digit gutter", async () => {
    const document = createTestDocument(Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n"));
    const state = createInitialEditorState(document.uri);
    const { renderOnce, captureCharFrame } = await testRender(
      <EditorView document={document} state={state} viewportHeight={10} />,
      { width: 30, height: 11 },
    );
    await act(async () => {
      await renderOnce();
    });
    const frame = captureCharFrame();
    expect(frame).toMatch(/ 1 L0/);
    expect(frame).toMatch(/10 L9/);
  });

  test("100 lines -> 3-digit gutter (visible without scrolling to line 100)", async () => {
    const document = createTestDocument(Array.from({ length: 100 }, (_, i) => `L${i}`).join("\n"));
    const state = createInitialEditorState(document.uri);
    const { renderOnce, captureCharFrame } = await testRender(
      <EditorView document={document} state={state} viewportHeight={3} />,
      { width: 30, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });
    const frame = captureCharFrame();
    expect(frame).toMatch(/ {2}1 L0/);
  });
});

describe("EditorView — selection rendering (Req 6.6, design.md §8.3's selection layer)", () => {
  test("a selection range paints the inactive selection background when unfocused", async () => {
    const document = createTestDocument("hello world");
    const state = stateWith(document.uri, [selectionAt(0, 0, 0, 5)]);

    const { renderOnce, captureSpans } = await testRender(
      <EditorView document={document} state={state} viewportHeight={3} />,
      { width: 40, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });

    const spans = flatten(captureSpans());
    const inactiveBg = toColorInput(baseTheme.colors["editor.inactiveSelectionBackground"]);
    const highlighted = spans.filter((s) => JSON.stringify(s.bg) === JSON.stringify(inactiveBg));
    // Exactly the selected "hello" text carries the highlight — " world"
    // (unselected) does not.
    expect(highlighted.map((s) => s.text).join("")).toBe("hello");
  });
});

describe("EditorView — find-match highlighting (Req 11.1, design.md §13)", () => {
  test("the active match gets findMatchBackground; other matches get findMatchHighlightBackground", async () => {
    const document = createTestDocument("foo bar foo baz foo");
    const matches = [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } },
      { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } },
    ];
    const state = stateWithFind(document.uri, [cursorAt(0, 5)], {
      query: "foo",
      matches,
      activeMatchIndex: 1,
    });

    const { renderOnce, captureSpans } = await testRender(
      <EditorView document={document} state={state} viewportHeight={3} />,
      { width: 40, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });

    const spans = flatten(captureSpans());
    const activeBg = toColorInput(baseTheme.colors["editor.findMatchBackground"]);
    const otherBg = toColorInput(baseTheme.colors["editor.findMatchHighlightBackground"]);
    const activeSpans = spans.filter((s) => JSON.stringify(s.bg) === JSON.stringify(activeBg));
    const otherSpans = spans.filter((s) => JSON.stringify(s.bg) === JSON.stringify(otherBg));

    // Exactly the SECOND "foo" (the active match, index 1) carries the
    // active color...
    expect(activeSpans.map((s) => s.text).join("")).toBe("foo");
    expect(activeSpans.length).toBe(1);
    // ...and the OTHER two "foo"s carry the dimmer highlight color, not the
    // active one and not plain selection background.
    expect(otherSpans.map((s) => s.text).sort()).toEqual(["foo", "foo"]);
  });

  test("closing the find widget (isOpen: false) hides all match highlighting", async () => {
    const document = createTestDocument("foo bar foo");
    const matches = [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } },
    ];
    const state = stateWithFind(document.uri, [cursorAt(0, 0)], {
      query: "foo",
      matches,
      activeMatchIndex: 0,
      isOpen: false,
    });

    const { renderOnce, captureSpans } = await testRender(
      <EditorView document={document} state={state} viewportHeight={3} />,
      { width: 40, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });

    const spans = flatten(captureSpans());
    const activeBg = toColorInput(baseTheme.colors["editor.findMatchBackground"]);
    const otherBg = toColorInput(baseTheme.colors["editor.findMatchHighlightBackground"]);
    expect(spans.some((s) => JSON.stringify(s.bg) === JSON.stringify(activeBg))).toBe(false);
    expect(spans.some((s) => JSON.stringify(s.bg) === JSON.stringify(otherBg))).toBe(false);
  });

  test("an open find widget reveals the active match's line even when the cursor is elsewhere", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => (i === 40 ? "target foo" : `line${i}`));
    const document = createTestDocument(lines.join("\n"));
    const match = { start: { line: 40, character: 7 }, end: { line: 40, character: 10 } };
    const state = stateWithFind(document.uri, [cursorAt(0, 0)], {
      query: "foo",
      matches: [match],
      activeMatchIndex: 0,
    });

    const { renderOnce, captureCharFrame } = await testRender(
      <EditorView document={document} state={state} viewportHeight={5} />,
      { width: 30, height: 6 },
    );
    await act(async () => {
      await renderOnce();
    });

    // The cursor sits on line 0, but the viewport scrolled to reveal the
    // active match on line 40 instead — proof `EditorView`'s reveal
    // derivation follows the active find match, not the (unmoved) cursor.
    expect(captureCharFrame()).toContain("target foo");
  });
});

describe("EditorView — multi-cursor rendering (Req 6.6, 11.1)", () => {
  test("two collapsed cursors each render a cursor-colored cell", async () => {
    const document = createTestDocument("aaaa\nbbbb\ncccc");
    const state = stateWith(document.uri, [cursorAt(0, 1), cursorAt(2, 2)]);

    const { renderOnce, captureSpans } = await testRender(
      <EditorView document={document} state={state} viewportHeight={3} />,
      { width: 30, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });

    const spans = flatten(captureSpans());
    const cursorBg = toColorInput(baseTheme.colors["editorCursor.foreground"]);
    const cursorSpans = spans.filter((s) => JSON.stringify(s.bg) === JSON.stringify(cursorBg));
    // Exactly one cursor-colored cell per cursor (both are single-character
    // collapsed selections).
    expect(cursorSpans.length).toBe(2);
  });
});

describe("EditorView — CJK/emoji lines (design.md §8.3's cell-width mapping)", () => {
  test("renders a CJK line and places a cursor after a wide character without crashing", async () => {
    const document = createTestDocument("a古b\nsecond");
    const state = stateWith(document.uri, [cursorAt(0, 2)]); // caret right after "古", before "b"

    const { renderOnce, captureCharFrame, captureSpans } = await testRender(
      <EditorView document={document} state={state} viewportHeight={3} />,
      { width: 30, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(captureCharFrame()).toContain("古");
    const cursorBg = toColorInput(baseTheme.colors["editorCursor.foreground"]);
    const spans = flatten(captureSpans());
    const cursorSpan = spans.find((s) => JSON.stringify(s.bg) === JSON.stringify(cursorBg));
    expect(cursorSpan?.text).toBe("b");
  });

  test("renders an emoji line without crashing", async () => {
    const document = createTestDocument("hi 😀 there");
    const state = createInitialEditorState(document.uri);
    const { renderOnce, captureCharFrame } = await testRender(
      <EditorView document={document} state={state} viewportHeight={3} />,
      { width: 30, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(captureCharFrame()).toContain("😀");
  });
});

describe("EditorView — dirty-range re-render (Req 13.1, design.md §7.1)", () => {
  test("editing one line does not re-execute the render of unrelated visible lines", async () => {
    const document = createTestDocument("a\nb\nc\nd\ne");
    const state = stateWith(document.uri, [cursorAt(0, 0)]);
    const seen: number[] = [];

    const { renderOnce } = await testRender(
      <EditorView
        document={document}
        state={state}
        viewportHeight={5}
        onDebugLineRender={(line) => seen.push(line)}
      />,
      { width: 20, height: 6 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4]);

    seen.length = 0;
    act(() => {
      // Same-line replace on line 2 — no line-count delta.
      document.applyEdits([
        { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, newText: "C" },
      ]);
    });
    await act(async () => {
      await renderOnce();
    });

    expect(seen).toContain(2);
    expect(seen).not.toContain(0);
    expect(seen).not.toContain(1);
    expect(seen).not.toContain(3);
    expect(seen).not.toContain(4);
  });

  test("a multi-line insertion above unobserved rows does not leave them showing stale content", async () => {
    // Regression test: `useLineTicks`' shifting can only carry forward
    // ticks it already holds (its TSDoc's "known limitation"), so a row
    // that was never individually edited before — every row, on a
    // document's very first edit — shifts to a new index with no tick
    // change at all. `EditorLineRow`'s memo must fall back to comparing
    // `text` directly, or the shifted-in row keeps rendering whatever the
    // row at that screen position showed before the edit.
    const document = createTestDocument("a\nb\nc\nd\ne");
    const state = stateWith(document.uri, [cursorAt(0, 0)]);

    const { renderOnce, captureCharFrame } = await testRender(
      <EditorView document={document} state={state} viewportHeight={5} />,
      { width: 20, height: 6 },
    );
    await act(async () => {
      await renderOnce();
    });
    const before = captureCharFrame();
    // 5 lines -> 1-digit gutter; row at screen position 3 (0-based) shows
    // document line "d" as line number 4.
    expect(before).toMatch(/4 d/);

    act(() => {
      // Insert two new lines before line 0 — every row below the edit
      // (including "d", never individually edited before now) shifts down
      // by 2 with no prior tick to carry forward.
      document.applyEdits([
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "X\nY\n" },
      ]);
    });
    await act(async () => {
      await renderOnce();
    });

    const after = captureCharFrame();
    // Screen position 3 (0-based, still visible under a 5-row viewport)
    // now holds document line "b" (line number 4) — "d" moved off-screen
    // to line number 6.
    expect(after).toMatch(/4 b/);
    expect(after).not.toMatch(/4 d/);
    expect(after).not.toContain("d");
  });
});

describe("EditorView — editorTextFocus context key (Req 4.6)", () => {
  test("focusing/blurring the text plane toggles editorTextFocus", async () => {
    const { ContextFocusTracker } = await import("./focus");
    const { createContextService } = await import("../keymap/context");
    const context = createContextService();
    const document = createTestDocument("hello");
    const state = createInitialEditorState(document.uri);

    const { renderOnce, renderer } = await testRender(
      <ContextFocusTracker context={context}>
        <EditorView document={document} state={state} viewportHeight={3} />
      </ContextFocusTracker>,
      { width: 20, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(context.get<boolean>("editorTextFocus")).toBeUndefined();

    const focusable = findFocusable(renderer.root) as { focus(): void; blur(): void } | undefined;
    expect(focusable).toBeDefined();

    focusable!.focus();
    expect(context.get<boolean>("editorTextFocus")).toBe(true);

    focusable!.blur();
    expect(context.get<boolean>("editorTextFocus")).toBe(false);
  });
});

/** First `focusable` descendant, depth-first (mirrors shell.snapshot.test.tsx's
 * `findAllFocusable`, narrowed to "first" since `EditorView` has exactly
 * one focusable node). */
function findFocusable(node: unknown): unknown {
  const candidate = node as { focusable?: boolean; getChildren?: () => unknown[] };
  if (candidate?.focusable) return candidate;
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findFocusable(child);
    if (found) return found;
  }
  return undefined;
}

/** A `config` that hides line numbers (matches "editor.lineNumbers can be
 * hidden via a config seam" above) — used by the highlighting tests below
 * so expected columns don't need to account for the gutter's width. */
const noLineNumbersConfig = { get: () => false } as unknown as ConfigService;

/** A minimal fake `highlightService` (Req 8.1, design.md §10) — hand-rolled
 * per house convention. `spansByLine` is looked up by line only (every test
 * below renders exactly one document, so no per-uri branching is needed).
 * `fire()` lets a test simulate the service's `onDidChange` (a line-
 * invalidation signal, `highlightService.ts`'s TSDoc) without a real
 * parse/edit pipeline behind it. */
function createFakeHighlightService(spansByLine: Record<number, HighlightSpan[]>) {
  const listeners = new Set<() => void>();
  return {
    getSpansForLine: (_uri: string, line: number): readonly HighlightSpan[] => spansByLine[line] ?? [],
    onDidChange: (listener: () => void): Disposable => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire(): void {
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

describe("EditorView — syntax highlighting (Req 8.1-8.3, design.md §10)", () => {
  test("a highlight span colors its own segment; a selection overlay still wins the background", async () => {
    const document = createTestDocument("let x = 1;");
    // Selects "x = 1" (columns 4..9) — overlaps the "x" highlight span at
    // columns 4..5, and extends past it into unhighlighted text.
    const state = stateWith(document.uri, [selectionAt(0, 4, 0, 9)]);
    const highlightService = createFakeHighlightService({
      0: [{ startCol: 4, endCol: 5, capture: "variable" }],
    });
    const theme: ResolvedTheme = {
      ...createBaseTheme(),
      tokens: { variable: { foreground: { r: 200, g: 10, b: 10 } } },
    };

    const { renderOnce, captureSpans } = await testRender(
      <ThemeProvider theme={theme}>
        <EditorView
          document={document}
          state={state}
          viewportHeight={3}
          config={noLineNumbersConfig}
          highlightService={highlightService}
        />
      </ThemeProvider>,
      { width: 30, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });

    const spans = flatten(captureSpans());
    const highlightFg = toColorInput({ r: 200, g: 10, b: 10 });
    // The text plane is never `.focus()`ed in this test, so the INACTIVE
    // selection background is what actually renders (Req 4.6,
    // `editorView.tsx`'s `colors` memo).
    const selectionBg = toColorInput(theme.colors["editor.inactiveSelectionBackground"]);

    // "x" (highlighted AND selected): highlight foreground, selection
    // background — the overlay's background wins, but the syntax color
    // still shows through it (Req 8's "highlight foreground sits at the
    // base-text tier").
    const xRun = spans.find((s) => s.row === 0 && s.text === "x");
    expect(xRun).toBeDefined();
    expect(xRun!.fg).toEqual(highlightFg);
    expect(xRun!.bg).toEqual(selectionBg);

    // " = 1" (selected, NOT highlighted): base foreground, selection
    // background.
    const restRun = spans.find((s) => s.row === 0 && s.text === " = 1");
    expect(restRun).toBeDefined();
    expect(restRun!.fg).toEqual(toColorInput(theme.colors["editor.foreground"]));
    expect(restRun!.bg).toEqual(selectionBg);

    // "let " (neither): base foreground, no selection background override
    // (the renderer reports SOME default `bg` for a run with no explicit
    // color — asserted here by inequality with `selectionBg`, matching
    // this file's existing "selection rendering" test's own comparison
    // style, rather than assuming a literal `undefined`).
    const leadingRun = spans.find((s) => s.row === 0 && s.text === "let ");
    expect(leadingRun).toBeDefined();
    expect(leadingRun!.fg).toEqual(toColorInput(theme.colors["editor.foreground"]));
    expect(JSON.stringify(leadingRun!.bg)).not.toEqual(JSON.stringify(selectionBg));
  });

  test("longest-prefix fallback: a 'function.builtin' capture resolves via the theme's 'function' style", async () => {
    // A second line keeps the initial collapsed cursor off line 0 (it
    // would otherwise split "foo" into its own single-character run at
    // column 0, same as `EditorLineRow`'s cursor-cell boundary for any
    // other line).
    const document = createTestDocument("foo()\nx");
    const state = stateWith(document.uri, [cursorAt(1, 0)]);
    const highlightService = createFakeHighlightService({
      0: [{ startCol: 0, endCol: 3, capture: "function.builtin" }],
    });
    const theme: ResolvedTheme = {
      ...createBaseTheme(),
      tokens: { function: { foreground: { r: 1, g: 2, b: 3 } } },
    };

    const { renderOnce, captureSpans } = await testRender(
      <ThemeProvider theme={theme}>
        <EditorView
          document={document}
          state={state}
          viewportHeight={2}
          config={noLineNumbersConfig}
          highlightService={highlightService}
        />
      </ThemeProvider>,
      { width: 20, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });

    const fooRun = flatten(captureSpans()).find((s) => s.row === 0 && s.text === "foo");
    expect(fooRun).toBeDefined();
    expect(fooRun!.fg).toEqual(toColorInput({ r: 1, g: 2, b: 3 }));
  });

  test("omitting highlightService renders exactly as before (no spans, base foreground)", async () => {
    // A second line keeps the initial collapsed cursor off line 0 — see
    // the previous test's comment.
    const document = createTestDocument("abc\nx");
    const state = stateWith(document.uri, [cursorAt(1, 0)]);

    const { renderOnce, captureSpans } = await testRender(
      <EditorView document={document} state={state} viewportHeight={2} config={noLineNumbersConfig} />,
      { width: 20, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });

    const abcRun = flatten(captureSpans()).find((s) => s.row === 0 && s.text === "abc");
    expect(abcRun).toBeDefined();
    expect(abcRun!.fg).toEqual(toColorInput(baseTheme.colors["editor.foreground"]));
  });

  test("a highlightService.onDidChange fire re-renders visible lines with no other state change", async () => {
    const document = createTestDocument("abc");
    const state = createInitialEditorState(document.uri);
    const highlightService = createFakeHighlightService({});
    const renderedLines: number[] = [];

    const { renderOnce } = await testRender(
      <EditorView
        document={document}
        state={state}
        viewportHeight={2}
        highlightService={highlightService}
        onDebugLineRender={(line) => renderedLines.push(line)}
      />,
      { width: 20, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });
    const before = renderedLines.length;
    expect(before).toBeGreaterThan(0);

    act(() => {
      highlightService.fire();
    });
    await act(async () => {
      await renderOnce();
    });

    expect(renderedLines.length).toBeGreaterThan(before);
  });
});
