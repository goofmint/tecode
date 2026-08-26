/**
 * Regression coverage for Issue #82 ("cannot type at all in a real
 * terminal, but `ctrl+g` still works"): before this fix, NOTHING in the
 * production component tree ever imperatively focused the editor's text
 * plane — `editorTextFocus` stayed `undefined` forever after mount, so
 * `editor/inputRouter.ts`'s `routeKeyEvent` gate (`if (!context.
 * get("editorTextFocus")) return false;`) silently dropped every printable
 * keystroke. The fix lives entirely in `shell.tsx`'s `EditorArea` (see its
 * own TSDoc's "Initial/re-focus of the text plane" section for the exact
 * rule and its do-not-steal guard) and `focus.tsx`'s new
 * `useFocusContextService`.
 *
 * **No focus assist, anywhere, in any test below**: every test in this file
 * mounts EXACTLY design.md §8.1's production tree (`<ThemeProvider>
 * <ContextFocusTracker><Shell/></ContextFocusTracker></ThemeProvider>`,
 * `<ModalOverlay>` added as `Shell`'s sibling where a test needs the
 * palette, matching `renderShell.tsx`'s `renderShellToTerminal` exactly)
 * and never calls `.focus()` on any node itself, never walks the render
 * tree looking for a focusable candidate to focus (the `editingHarness.tsx`
 * `focusEditorText`/this file's neighbor `shell.snapshot.test.tsx`'s
 * "Finding 5" test idiom — both legitimate for THEIR OWN, different
 * purposes, but exactly the shortcut that would prove nothing here), and
 * never shortcuts `context.set("editorTextFocus", true)` directly. The only
 * two things ever allowed to move real OpenTUI focus in this file are
 * `EditorArea`'s own new effect (under test) and `ModalOverlay`/
 * `QuickPickBody`'s own real mount-focus effect (exercised as a genuine
 * competing, real-world focus claim, not a fake).
 *
 * Uses the same real-collaborator, hand-rolled-fake harness as
 * `shell.snapshot.test.tsx` (`createDocumentManager`, `createEditorSessionService`,
 * `createContextService`, `createEditorInputRouter`, `createModalService` —
 * every one a real `@tecode/core` factory, never a mock library), rather
 * than the heavier `packages/cli` `AssemblyRoot`/extension-host harness:
 * this bug and its fix live entirely inside `packages/core`'s `ui/`+
 * `editor/` wiring, so this is the narrowest tree that still reproduces the
 * exact production composition and the exact real gate the bug lived in.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { TabSelectRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createDocumentManager, type DocumentManagerFs } from "../buffer/documentManager";
import { pathToUri } from "../buffer/uri";
import { createEditorInputRouter } from "../editor/inputRouter";
import { createHostLog } from "../host/errors";
import { createContextService } from "../keymap/context";
import { createEditorSessionService } from "./editorSession";
import { ContextFocusTracker } from "./focus";
import { createLayoutStateService, type LayoutStateFs } from "./layoutState";
import { createModalService } from "./modalService";
import { ModalOverlay } from "./modalOverlay";
import { createSlotRegistry } from "./slotRegistry";
import { Shell } from "./shell";
import { ThemeProvider } from "./theme";

/** A key event shaped exactly like `keyRouting.test.ts`'s/`shell.snapshot.
 * test.tsx`'s own literal `KeyEventLike` object for a plain printable
 * character — duplicated locally rather than imported (`editingHarness.
 * tsx`'s own `keyOf`, kept as a separate copy for the same "not importing
 * from a test file" reason its own TSDoc gives). */
function printableKey(char: string) {
  return { name: char, sequence: char, ctrl: false, shift: false, option: false, meta: false };
}

/** A `HostLog` sink that discards everything (matches `shell.snapshot.
 * test.tsx`'s own identical helper) — these tests assert on focus/context
 * behavior, not on what gets logged. */
function createRecordingSink() {
  return { error() {} };
}

/** An in-memory {@link LayoutStateFs} that starts with no `state.json`
 * (matches `shell.snapshot.test.tsx`'s own identical helper). */
function createEmptyLayoutFs(): LayoutStateFs {
  return {
    async readFile() {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    async mkdir() {},
    async writeFile() {},
  };
}

/** The `slotRegistry`/`layoutState`/`context` trio every test below
 * mounts `<Shell>` against (matches `shell.snapshot.test.tsx`'s own
 * identical helper) — `documents`/`editorSession`/`modalService` are each
 * test's own concern, built separately per scenario. */
function createHarness() {
  const log = createHostLog();
  const sink = createRecordingSink();
  const slotRegistry = createSlotRegistry({ log });
  const layoutState = createLayoutStateService({ log, sink, path: "/state.json", fs: createEmptyLayoutFs() });
  const context = createContextService();
  return { slotRegistry, layoutState, context };
}

function createInMemoryFs(files: Record<string, string>): DocumentManagerFs {
  return {
    async stat(path: string) {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size: files[path]!.length, mode: 0o644 };
    },
    async readFile(path: string) {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path]!;
    },
    async writeFile() {},
    async chmod() {},
    async rename() {},
    async unlink() {},
  };
}

/** Depth-first search for the rendered `<tab-select>` renderable (matches
 * `shell.snapshot.test.tsx`'s own identical helper of the same name). */
function findTabSelect(node: unknown): TabSelectRenderable | undefined {
  if (node instanceof TabSelectRenderable) return node;
  const candidate = node as { getChildren?: () => unknown[] };
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findTabSelect(child);
    if (found) return found;
  }
  return undefined;
}

describe("Shell — initial editor focus (Req 4.6, 6.7, design.md §8.1; Issue #82)", () => {
  test("mounting with a document already open focuses the text plane with no manual assist, so a printable key inserts into the document", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/hello.ts": "hello" }),
    });
    const editorSession = createEditorSessionService({ documents });
    // Open BEFORE mounting — Issue #82's most basic case: tecode starts on
    // a workspace that already has a file open (this component's TSDoc's
    // case 1).
    const document = await documents.openDocument(pathToUri("/workspace/hello.ts"));

    const { renderOnce } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            documents={documents}
            editorSession={editorSession}
          />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    // The real gate `editor/inputRouter.ts`'s `routeKeyEvent` checks first
    // — this is Issue #82's report made precise: with NOTHING having
    // focused anything by hand, this must already be `true`.
    expect(context.get<boolean>("editorTextFocus")).toBe(true);

    const router = createEditorInputRouter({ context, editorSession });
    const handled = router.routeKeyEvent(printableKey("X"));
    expect(handled).toBe(true);
    expect(document.getLine(0)).toBe("Xhello");
  });

  test("opening the first document after an empty-workspace startup focuses its text plane with no manual assist", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    // The file exists on the (fake) filesystem from the start, but nothing
    // opens it yet — an "empty workspace at launch" startup, exactly this
    // component's TSDoc's case 2.
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/late.ts": "late" }),
    });
    const editorSession = createEditorSessionService({ documents });

    const { renderOnce } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            documents={documents}
            editorSession={editorSession}
          />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    // No document open yet: nothing for the initial-focus effect to grab,
    // and nothing else claims the key either (this component's TSDoc's
    // case 2's precondition).
    expect(context.get<boolean>("editorTextFocus")).toBeFalsy();

    // The document opens LATER, through the SAME `documents`/
    // `editorSession` the Shell is already wired to — "a document opened
    // later", not a fresh, disconnected `DocumentManager`.
    const document = await documents.openDocument(pathToUri("/workspace/late.ts"));
    await act(async () => {
      await renderOnce();
    });

    expect(context.get<boolean>("editorTextFocus")).toBe(true);
    const router = createEditorInputRouter({ context, editorSession });
    const handled = router.routeKeyEvent(printableKey("Y"));
    expect(handled).toBe(true);
    expect(document.getLine(0)).toBe("Ylate");
  });

  test("does not steal focus from an open command palette when a document opens while it's showing", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/hello.ts": "hello" }),
    });
    const editorSession = createEditorSessionService({ documents });
    const modalService = createModalService();

    // Mounts `<Shell/>` AND `<ModalOverlay/>` as siblings inside the same
    // `<ContextFocusTracker>` — exactly `renderShell.tsx`'s
    // `renderShellToTerminal` composition (`modalOverlay.tsx`'s "Mount
    // point" TSDoc), not a Shell-only tree — this test's whole point is the
    // REAL interaction between the two.
    const { renderOnce } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            documents={documents}
            editorSession={editorSession}
          />
          <ModalOverlay modalService={modalService} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(context.get<boolean>("editorTextFocus")).toBeFalsy();

    // Open the real command palette — `ModalOverlay`'s own `QuickPickBody`
    // mount effect calls a REAL `.focus()` on its filter input, exactly as
    // `workbench.action.showCommands` does in production.
    act(() => {
      void modalService.openQuickPick([{ label: "Test Command" }]);
    });
    await act(async () => {
      await renderOnce();
    });
    expect(context.get<boolean>("quickPickFocus")).toBe(true);

    // A document opens WHILE the palette is showing (e.g. an extension's
    // own startup activation, or restoring a previous session's editor) —
    // this component's TSDoc's case 2, now racing an already-open palette.
    // Without the do-not-steal guard, the initial-focus effect would call
    // `.focus()` on the new tab's text plane here, and OpenTUI's single
    // global focus pointer would blur the palette's filter input out from
    // under the user.
    const document = await documents.openDocument(pathToUri("/workspace/hello.ts"));
    await act(async () => {
      await renderOnce();
    });

    expect(context.get<boolean>("quickPickFocus")).toBe(true);
    expect(context.get<boolean>("editorTextFocus")).toBeFalsy();

    const router = createEditorInputRouter({ context, editorSession });
    const handled = router.routeKeyEvent(printableKey("X"));
    // Dropped by the real `editorTextFocus` gate — never reaches the
    // buffer "behind" the palette.
    expect(handled).toBe(false);
    expect(document.getLine(0)).toBe("hello");
  });

  test("closing the palette after a document opened while it was showing retries the deferred focus (CodeRabbit PR #83 follow-up)", async () => {
    // Continues exactly where "does not steal focus..." above stops: this
    // is quick-open's real shape (Issue #82's most common path) — empty
    // workspace, `ctrl+g`-equivalent opens the palette, a file is picked
    // (which in production opens the document WHILE the palette is still
    // showing, then the palette closes) — and proves the deferred focus
    // attempt this scenario ARMS is not silently discarded once the guard
    // clears, only DEFERRED. `ModalOverlay` restores focus only to
    // whatever held it before the palette opened (`modalOverlay.tsx`'s
    // `previousFocusRef`) — nothing did, here — so it cannot be what
    // re-focuses the text plane; only `EditorArea`'s own retry can.
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/hello.ts": "hello" }),
    });
    const editorSession = createEditorSessionService({ documents });
    const modalService = createModalService();

    const { renderOnce } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            documents={documents}
            editorSession={editorSession}
          />
          <ModalOverlay modalService={modalService} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    act(() => {
      void modalService.openQuickPick([{ label: "Test Command" }]);
    });
    await act(async () => {
      await renderOnce();
    });
    expect(context.get<boolean>("quickPickFocus")).toBe(true);

    // The document opens WHILE the palette is still showing — the
    // do-not-steal guard defers the focus attempt (asserted already by the
    // test above); this test continues past that point.
    const document = await documents.openDocument(pathToUri("/workspace/hello.ts"));
    await act(async () => {
      await renderOnce();
    });
    expect(context.get<boolean>("editorTextFocus")).toBeFalsy();

    // The palette closes — `quickPickFocus` flips false. Nothing about
    // `props.activeDocument?.uri` changes on this render (the active
    // document is still "hello.ts"), so ONLY a retry driven by the context
    // service's own `onDidChange` (not a uri-keyed effect re-run) can pick
    // this back up.
    act(() => {
      modalService.cancel();
    });
    await act(async () => {
      await renderOnce();
    });

    expect(context.get<boolean>("quickPickFocus")).toBe(false);
    expect(context.get<boolean>("editorTextFocus")).toBe(true);

    const router = createEditorInputRouter({ context, editorSession });
    const handled = router.routeKeyEvent(printableKey("Q"));
    expect(handled).toBe(true);
    expect(document.getLine(0)).toBe("Qhello");
  });

  test("switching tabs re-focuses the newly active tab's text plane, with no manual assist", async () => {
    const { slotRegistry, layoutState, context } = createHarness();
    await layoutState.ready;
    const documents = createDocumentManager({
      log: createHostLog(),
      sink: createRecordingSink(),
      fs: createInMemoryFs({ "/workspace/a.ts": "AAAA", "/workspace/b.ts": "BBBB" }),
    });
    const editorSession = createEditorSessionService({ documents });

    const { renderOnce, renderer } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Shell
            slotRegistry={slotRegistry}
            layoutState={layoutState}
            documents={documents}
            editorSession={editorSession}
          />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await documents.openDocument(pathToUri("/workspace/a.ts"));
    const docB = await documents.openDocument(pathToUri("/workspace/b.ts"));
    await act(async () => {
      await renderOnce();
    });
    // Startup focus already landed on tab A (this file's first test covers
    // that case on its own) — asserted here only as this test's own
    // precondition.
    expect(context.get<boolean>("editorTextFocus")).toBe(true);

    // Drive the REAL `<tab-select>` renderable exactly as `shell.snapshot.
    // test.tsx`'s "selecting the second tab switches the active document's
    // content" test does — not a direct `editorSession.
    // setActiveDocumentUri(...)` call, which would bypass the very
    // `EditorView` remount (`key={activeDocument.uri}`) this fix's "tab
    // switch" case depends on.
    const tabSelect = findTabSelect(renderer.root);
    expect(tabSelect).toBeDefined();
    act(() => {
      tabSelect?.moveRight();
      tabSelect?.selectCurrent();
    });
    await act(async () => {
      await renderOnce();
    });

    // Without this fix's "tab switch" case, `editorTextFocus` would be
    // stuck `false` here: `focus.tsx`'s "detaching a still-focused node"
    // fix force-blurs it the instant the OLD tab's `EditorView` unmounts,
    // and nothing else would ever re-focus the NEW tab's text plane.
    expect(context.get<boolean>("editorTextFocus")).toBe(true);
    const router = createEditorInputRouter({ context, editorSession });
    const handled = router.routeKeyEvent(printableKey("Z"));
    expect(handled).toBe(true);
    expect(docB.getLine(0)).toBe("ZBBBB");
  });
});
