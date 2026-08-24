/**
 * End-to-end editing scenario (tasks.md's Task 2.10, Req 13.1; design.md
 * §15, §16 — the "Integration... end-to-end 'open file -> type -> undo ->
 * save' scenario on the headless renderer" §16 calls for, extended per
 * Task 2.10's fuller plan): open a real `.ts` file through the REAL
 * production pipeline (`editingHarness.tsx`'s `buildEditingHarness` — real
 * `AssemblyRoot`, real `themes-default`/`languages-basic`/`editor-core`,
 * real `web-tree-sitter` grammar) -> assert a genuine highlighted render
 * appears -> create two cursors via `editor.action.addSelectionToNextFindMatch`
 * -> type through the real key-routing pipeline -> undo -> redo -> save,
 * asserting the document's `dirty` flag at every step. This closes Phase
 * 2's exit criterion (tasks.md: "editing a single file with highlighting,
 * themes, undo, find/replace, and multi-cursor works end to end").
 *
 * **Fixture content**: a small, real TypeScript function with the
 * identifier `value` appearing twice (parameter declaration, then use) —
 * enough for `editor.action.addSelectionToNextFindMatch` (ctrl+d) to
 * produce two real cursors: pressed once from a collapsed cursor inside the
 * first `value`, it expands to that whole word (Req 11.1's "an empty
 * primary selection expands to the word at the cursor"); pressed again, it
 * adds the SECOND occurrence as a new primary selection ahead of the first
 * (`multiCursor.ts`'s own contract) — exactly two selections, both
 * `active`-anchored at each occurrence's end.
 *
 * **Why exactly one typed keystroke while multi-cursor**: `document.ts`'s
 * `applyEdits` records ONE undo-stack entry per call, and the router
 * (`inputRouter.ts`) batches every active cursor's edit for one keystroke
 * into a SINGLE `applyEdits` call — so one keystroke with two cursors is
 * already one atomic, single-`undo()`-reversible unit, independent of the
 * 750ms typing-COALESCING window (`undoStack.ts`'s `TYPING_COALESCE_WINDOW_MS`,
 * separately covered by `undoStack.test.ts`, Req 5.4). Coalescing itself
 * only ever applies to a SINGLE-cursor, single-character insert
 * (`document.ts`'s `typingHintFor`: any multi-edit batch — which every
 * multi-cursor keystroke is — is never a coalescing candidate). Typing more
 * than one keystroke here would therefore push a SEPARATE undo entry per
 * keystroke, and a single `editor.action.undo` could only unwind the last
 * one — not "back to original" as this scenario asserts. One multi-cursor
 * keystroke is the correct, honest way to get "two cursors both edited, one
 * undo call fully reverts them".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedFrame } from "@opentui/core";
import { pathToUri, resolveCaptureStyle, toColorInput } from "@tecode/core";
import {
  buildEditingHarness,
  focusEditorText,
  keyOf,
  renderEditingShell,
  sendKey,
  waitForEvent,
  waitForHighlightChange,
  writeFixtureFile,
  type EditingHarness,
} from "./editingHarness";

/** Matches `editorView.snapshot.test.tsx`'s/`themesVisual.snapshot.test.tsx`'s own `flatten`
 * helper: one entry per rendered text span, across every row of the
 * captured frame. */
function flatten(frame: CapturedFrame): Array<{ row: number; text: string; fg: unknown; bg: unknown }> {
  const out: Array<{ row: number; text: string; fg: unknown; bg: unknown }> = [];
  frame.lines.forEach((line, row) => {
    for (const span of line.spans) {
      out.push({ row, text: span.text, fg: span.fg, bg: span.bg });
    }
  });
  return out;
}

const SOURCE_LINES = [
  "function add(value: number, other: number): number {",
  "  const total = value + other;",
  "  // sum values",
  "  return total;",
  "}",
  "",
];
const SOURCE = SOURCE_LINES.join("\n");

describe("End-to-end editing scenario (Task 2.10, Req 13.1, design.md §15, §16)", () => {
  let homeDir: string | undefined;
  let workspaceDir: string | undefined;
  let harness: EditingHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
    homeDir = undefined;
    workspaceDir = undefined;
  });

  test(
    "open .ts -> real highlighted render -> type at two cursors -> undo -> redo -> save, dirty lifecycle throughout",
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), "tecode-e2e-home-"));
      workspaceDir = await mkdtemp(join(tmpdir(), "tecode-e2e-ws-"));
      const filePath = join(workspaceDir, "sample.ts");
      await writeFixtureFile(filePath, SOURCE);

      harness = await buildEditingHarness({ workspaceRoot: workspaceDir, homeDir });
      const { root } = harness;

      // --- Step 1: open the file through the real DocumentManager (real
      // fs read, real language-registry resolution) ---
      // Subscribe BEFORE opening the document, matching
      // `typingBenchmark.test.ts`'s own fix for this same race: the
      // highlight pipeline's first-parse `onDidChange` fires as soon as the
      // open attaches the document, so subscribing first can never miss it
      // — whereas subscribing later (after the intermediate `renderOnce()`
      // below) races a WARM web-tree-sitter runtime whose now-fast first
      // parse can settle during those awaits and leave the later
      // subscription waiting for an event that already fired.
      const highlightReady = waitForHighlightChange(root.highlightService);
      const document = await root.documents.openDocument(pathToUri(filePath));
      expect(document.languageId).toBe("typescript"); // real languages-basic .ts mapping
      expect(document.dirty).toBe(false);

      const { renderOnce, renderer, captureCharFrame, captureSpans } = await renderEditingShell(root, {
        width: 120,
        height: 20,
      });
      await act(async () => {
        await renderOnce();
      });

      const openFrame = captureCharFrame();
      expect(openFrame).toContain("sample.ts"); // tab label
      expect(openFrame).toContain("function add(value: number, other: number): number {");
      expect(document.dirty).toBe(false);

      // Move the (default, line 0 col 0) cursor off the very first
      // character before checking rendered spans below — `EditorView`
      // renders the active cursor's cell as its own inverted-color run
      // (`editorView.snapshot.test.tsx`'s own "keeps the initial collapsed cursor
      // off line 0" idiom), which would otherwise split "function" into
      // "f" (cursor cell) + "unction" (highlighted run) and make the exact-
      // text match below fail for a reason that has nothing to do with
      // highlighting itself.
      const endPos = { line: document.lineCount - 1, character: 0 };
      act(() => {
        root.api.editor.setSelections([{ start: endPos, end: endPos, anchor: endPos, active: endPos }]);
      });

      // --- Step 2: a genuine highlighted render appears (real
      // web-tree-sitter TypeScript grammar + real Dark Modern theme) ---
      await act(async () => {
        await highlightReady;
      });
      await act(async () => {
        await renderOnce();
      });

      const theme = root.themeService.get();
      const keywordFg = toColorInput(resolveCaptureStyle(theme.tokens, "keyword")!.foreground!);
      // `number` (the return-type annotation) is a real TypeScript grammar
      // `predefined_type` node, captured as `@type.builtin` and resolved
      // through `themeLoader.ts`'s longest-prefix fallback to the theme's
      // `type` style — a real second capture category, chosen (rather than
      // `add`'s `@function` capture) because `typescript.scm`'s catch-all
      // `(identifier) @variable` (line 4) ALSO matches the function-name
      // identifier node and, per `buildLineRuns`'s documented "first
      // covering range wins" tie-break, ends up rendering with `variable`'s
      // color instead — a genuine, pre-existing property of this query's
      // capture ordering, not something to work around here.
      const typeFg = toColorInput(resolveCaptureStyle(theme.tokens, "type.builtin")!.foreground!);

      const highlightedSpans = flatten(captureSpans());
      const functionKeywordRun = highlightedSpans.find((s) => s.text === "function");
      expect(functionKeywordRun, "expected a rendered 'function' keyword run").toBeDefined();
      expect(functionKeywordRun!.fg).toEqual(keywordFg);
      const numberTypeRun = highlightedSpans.find((s) => s.text === "number");
      expect(numberTypeRun, "expected a rendered 'number' builtin-type run").toBeDefined();
      expect(numberTypeRun!.fg).toEqual(typeFg);
      expect(numberTypeRun!.fg).not.toEqual(keywordFg);

      // --- Step 3: real focus, then create 2 cursors via
      // editor.action.addSelectionToNextFindMatch (ctrl+d) ---
      const focused = focusEditorText(renderer.root, root.context);
      expect(focused, "expected the editor's text plane to become focused").toBe(true);

      const firstValueCol = SOURCE_LINES[0]!.indexOf("value");
      const secondValueCol = SOURCE_LINES[1]!.indexOf("value");
      expect(firstValueCol).toBeGreaterThanOrEqual(0);
      expect(secondValueCol).toBeGreaterThanOrEqual(0);

      // Place a collapsed cursor inside the first "value" occurrence —
      // direct `tecode.editor.setSelections` positioning (the same seam
      // every editor-core movement command itself writes through), not a
      // shortcut around the real ctrl+d command this step exists to
      // exercise.
      const startPos = { line: 0, character: firstValueCol + 2 };
      act(() => {
        root.api.editor.setSelections([{ start: startPos, end: startPos, anchor: startPos, active: startPos }]);
      });
      await act(async () => {
        await renderOnce();
      });

      act(() => {
        sendKey(root, keyOf({ name: "d", ctrl: true })); // expands to the word "value"
      });
      await act(async () => {
        await renderOnce();
      });
      expect(root.api.editor.selections).toHaveLength(1);
      expect(root.api.editor.selections[0]!.start).not.toEqual(root.api.editor.selections[0]!.end);

      act(() => {
        sendKey(root, keyOf({ name: "d", ctrl: true })); // adds the second "value" occurrence
      });
      await act(async () => {
        await renderOnce();
      });
      expect(root.api.editor.selections).toHaveLength(2);

      // --- Step 4: type through the real key-routing pipeline at both
      // cursors (this module's TSDoc: exactly one keystroke) ---
      // Both selections above are non-collapsed (each spans a whole "value"
      // word, active-anchored at its end) — typing still produces
      // "value!" at each, not a replacement, because `inputRouter.ts`
      // documents selection-replace-on-type as explicitly out of scope for
      // this MVP: its `insert` case always edits the empty range
      // `{ start: active, end: active }`, ignoring the selection's other
      // end entirely. This assertion is therefore exercising real,
      // intentional pipeline behavior, not an accident of an
      // unimplemented feature silently no-op'ing.
      act(() => {
        sendKey(root, keyOf({ name: "!", sequence: "!" }));
      });
      await act(async () => {
        await renderOnce();
      });

      expect(document.getLine(0)).toContain("value!");
      expect(document.getLine(1)).toContain("value!");
      expect(document.dirty).toBe(true);
      expect(root.api.editor.selections).toHaveLength(2); // both cursor positions updated, still distinct
      const typedFrame = captureCharFrame();
      expect(typedFrame).toContain("value!");

      // --- Step 5: undo once -> content back to the original ---
      act(() => {
        sendKey(root, keyOf({ name: "z", ctrl: true }));
      });
      await act(async () => {
        await renderOnce();
      });

      expect(document.getText()).toBe(SOURCE);
      expect(captureCharFrame()).not.toContain("value!");

      // --- Step 6: redo -> the typed edit is restored ---
      act(() => {
        sendKey(root, keyOf({ name: "y", ctrl: true }));
      });
      await act(async () => {
        await renderOnce();
      });

      expect(document.getLine(0)).toContain("value!");
      expect(document.getLine(1)).toContain("value!");
      expect(document.dirty).toBe(true);

      // --- Step 7: save -> dirty clears, onDidSave fires, the real file on
      // disk reflects the redone edit ---
      const savedPromise = waitForEvent(root.documents.onDidSave);
      act(() => {
        sendKey(root, keyOf({ name: "s", ctrl: true })); // editor.action.save is async (real fs write+rename)
      });
      const savedDocumentBox: { current?: Awaited<typeof savedPromise> } = {};
      await act(async () => {
        savedDocumentBox.current = await savedPromise;
      });
      await act(async () => {
        await renderOnce();
      });
      const savedDocument = savedDocumentBox.current!;

      expect(savedDocument.uri).toBe(document.uri);
      expect(document.dirty).toBe(false);

      const onDisk = await readFile(filePath, "utf8");
      expect(onDisk).toBe(document.getText());
      expect(onDisk).toContain("value!");
    },
    15_000,
  );
});
