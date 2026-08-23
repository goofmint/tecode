/**
 * `EditorView` tests (Req 6.5, 6.6, 13.1; design.md §8.3): gutter/selection/
 * cursor rendering via `@opentui/react/test-utils`'s headless renderer (see
 * `shell.test.tsx`'s top-of-file TSDoc for the full writeup of this API),
 * the dirty-range-only re-render guarantee, and the `editorTextFocus`
 * context-key wiring.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { CapturedFrame } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { Selection } from "@tecode/api";
import { createBaseTheme } from "../api/stubs";
import { createHostLog } from "../host/errors";
import { createDocument, type CoreDocument } from "../buffer/document";
import { toColorInput } from "./theme";
import { createInitialEditorState, type EditorState } from "./editorState";
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

/** First `focusable` descendant, depth-first (mirrors shell.test.tsx's
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
