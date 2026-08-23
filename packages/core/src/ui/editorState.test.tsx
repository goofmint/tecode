/**
 * `useLineTicks` tests (Req 13.1, design.md §8.3): per-line revision bumps
 * from `onDidChange`'s `dirtyRange`, including the `lineCountDelta` shift
 * case, exercised against a real `CoreDocument` (not a fake event bus) so
 * this proves the hook against `document.ts`'s actual `dirtyRange` shape.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createHostLog } from "../host/errors";
import { createDocument, type CoreDocument } from "../buffer/document";
import { createInitialEditorState, useLineTicks, type LineTicks } from "./editorState";

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

/** A minimal harness rendering `useLineTicks` and exposing its latest
 * result to the test via `onTicks` on every render (mirrors focus.test.tsx's
 * `<Probe>` pattern for exercising a hook that must run inside a real React
 * tree). */
function Harness(props: { document: CoreDocument | undefined; onTicks: (ticks: LineTicks) => void }) {
  const ticks = useLineTicks(props.document);
  props.onTicks(ticks);
  return <text>harness</text>;
}

describe("createInitialEditorState (design.md §8.3)", () => {
  test("starts with one collapsed selection at the document origin", () => {
    const state = createInitialEditorState("file:///a.txt");
    expect(state.documentUri).toBe("file:///a.txt");
    expect(state.scrollTop).toBe(0);
    expect(state.selections).toHaveLength(1);
    expect(state.selections[0]).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
      anchor: { line: 0, character: 0 },
      active: { line: 0, character: 0 },
    });
  });
});

describe("useLineTicks (Req 13.1, design.md §8.3)", () => {
  test("every line reads tick 0 before any change", async () => {
    const document = createTestDocument("a\nb\nc\nd");
    let latest: LineTicks | undefined;
    const { renderOnce } = await testRender(
      <Harness document={document} onTicks={(t) => (latest = t)} />,
      { width: 20, height: 5 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(latest!.getLineTick(0)).toBe(0);
    expect(latest!.getLineTick(3)).toBe(0);
  });

  test("a same-line edit (no lineCountDelta) bumps only the touched line", async () => {
    const document = createTestDocument("a\nb\nc\nd");
    let latest: LineTicks | undefined;
    const { renderOnce } = await testRender(
      <Harness document={document} onTicks={(t) => (latest = t)} />,
      { width: 20, height: 5 },
    );
    await act(async () => {
      await renderOnce();
    });
    const before = { l0: latest!.getLineTick(0), l1: latest!.getLineTick(1), l2: latest!.getLineTick(2) };

    act(() => {
      document.applyEdits([
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: "B" },
      ]);
    });
    await act(async () => {
      await renderOnce();
    });

    expect(latest!.getLineTick(1)).toBe(before.l1 + 1);
    // Unrelated lines are untouched — still whatever they were before.
    expect(latest!.getLineTick(0)).toBe(before.l0);
    expect(latest!.getLineTick(2)).toBe(before.l2);
  });

  test("a multi-line insert (lineCountDelta > 0) shifts ticks of lines below the edit", async () => {
    const document = createTestDocument("a\nb\nc");
    let latest: LineTicks | undefined;
    const { renderOnce } = await testRender(
      <Harness document={document} onTicks={(t) => (latest = t)} />,
      { width: 20, height: 5 },
    );
    await act(async () => {
      await renderOnce();
    });

    // Bump line 2's tick once via an isolated edit first, so we can prove
    // it travels to line 3 (not line 2) once a line is inserted above it.
    act(() => {
      document.applyEdits([
        { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, newText: "C" },
      ]);
    });
    await act(async () => {
      await renderOnce();
    });
    const line2TickBeforeShift = latest!.getLineTick(2);
    expect(line2TickBeforeShift).toBeGreaterThan(0);

    // Insert a new line between line 0 and line 1 (delta +1): old line 1
    // ("b") and old line 2 ("c") both shift down by one.
    act(() => {
      document.applyEdits([
        { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: "\nNEW" },
      ]);
    });
    await act(async () => {
      await renderOnce();
    });

    // Old line 2's tick moved to line 3.
    expect(latest!.getLineTick(3)).toBe(line2TickBeforeShift);
    // Line 0 (above the edit) is untouched by the shift itself, but IS
    // within this edit's own dirtyRange (it's a same-line insert starting
    // at line 0), so it gets a fresh bump — assert only that the document
    // is now materially longer, which the shift assertion above already
    // establishes correctness for.
    expect(document.lineCount).toBe(4);
  });
});
