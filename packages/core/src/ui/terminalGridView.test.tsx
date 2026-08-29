/**
 * Tests for `buildTerminalRowRuns` (pure grid-to-run logic) and
 * `TerminalGridView` (Issue #98 Phase 4) — the latter via
 * `@opentui/react/test-utils`'s headless renderer, matching
 * `editorView.snapshot.test.tsx`'s own harness.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { Disposable, Listener, PtySession } from "@tecode/api";
import { createBaseTheme } from "../api/stubs";
import { ThemeProvider } from "./theme";
import { buildTerminalRowRuns, TerminalGridView, type TerminalRowRun } from "./terminalGridView";
import type { TerminalCell } from "../terminal/vtEmulator";

const baseTheme = createBaseTheme();

/** A hand-rolled fake `Pick<PtySession, "onData" | "resize">` (Issue #98
 * Phase 4) — no mocking library, matches this codebase's house
 * convention. `fireData` lets a test push bytes as if the pty produced
 * them. */
function createFakeSession(): Pick<PtySession, "onData" | "resize"> & {
  fireData: (bytes: Uint8Array) => void;
  resizes: Array<{ cols: number; rows: number }>;
} {
  const listeners = new Set<Listener<Uint8Array>>();
  const resizes: Array<{ cols: number; rows: number }> = [];
  return {
    resizes,
    onData(listener) {
      listeners.add(listener);
      const disposable: Disposable = { dispose: () => listeners.delete(listener) };
      return disposable;
    },
    resize(cols, rows) {
      resizes.push({ cols, rows });
    },
    fireData(bytes) {
      for (const listener of Array.from(listeners)) listener(bytes);
    },
  };
}

describe("buildTerminalRowRuns (pure)", () => {
  function cellAt(chars: string, width: number, fg: TerminalCell["foreground"] = { kind: "default" }, bg: TerminalCell["background"] = { kind: "default" }): TerminalCell {
    return { chars, width, foreground: fg, background: bg };
  }

  test("merges consecutive same-color cells into one run", () => {
    const grid: TerminalCell[] = [cellAt("a", 1), cellAt("b", 1), cellAt("c", 1)];
    const runs = buildTerminalRowRuns((x) => grid[x], 0, 3);
    expect(runs).toEqual<TerminalRowRun[]>([{ text: "abc", foreground: { kind: "default" }, background: { kind: "default" } }]);
  });

  test("splits into separate runs when foreground changes", () => {
    const red: TerminalCell["foreground"] = { kind: "palette", index: 1, rgb: { r: 205, g: 49, b: 49 } };
    const grid: TerminalCell[] = [cellAt("a", 1, red), cellAt("b", 1)];
    const runs = buildTerminalRowRuns((x) => grid[x], 0, 2);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({ text: "a", foreground: red, background: { kind: "default" } });
    expect(runs[1]).toEqual({ text: "b", foreground: { kind: "default" }, background: { kind: "default" } });
  });

  test("skips width-0 continuation cells entirely (wide characters)", () => {
    const grid: TerminalCell[] = [cellAt("字", 2), cellAt("", 0), cellAt("x", 1)];
    const runs = buildTerminalRowRuns((x) => grid[x], 0, 3);
    expect(runs).toEqual<TerminalRowRun[]>([{ text: "字x", foreground: { kind: "default" }, background: { kind: "default" } }]);
  });

  test("an empty (but present) cell's chars ('') renders as a space, not disappearing — the ?? vs || landmine", () => {
    // getCell can legitimately return a cell whose `chars` is the empty
    // string (an on-screen but never-written-to cell) — using `??`
    // instead of `||` would let "" pass straight through and silently
    // collapse the run, shifting every following character left by one
    // column.
    const grid: TerminalCell[] = [cellAt("", 1), cellAt("x", 1)];
    const runs = buildTerminalRowRuns((x) => grid[x], 0, 2);
    expect(runs).toEqual<TerminalRowRun[]>([{ text: " x", foreground: { kind: "default" }, background: { kind: "default" } }]);
  });

  test("a missing cell (getCell returns undefined) also renders as a default-colored space", () => {
    const runs = buildTerminalRowRuns(() => undefined, 0, 2);
    expect(runs).toEqual<TerminalRowRun[]>([{ text: "  ", foreground: { kind: "default" }, background: { kind: "default" } }]);
  });

  test("two rgb colors with identical values merge; different rgb values split", () => {
    const c1: TerminalCell["foreground"] = { kind: "rgb", rgb: { r: 10, g: 20, b: 30 } };
    const c2: TerminalCell["foreground"] = { kind: "rgb", rgb: { r: 10, g: 20, b: 30 } };
    const c3: TerminalCell["foreground"] = { kind: "rgb", rgb: { r: 11, g: 20, b: 30 } };
    expect(buildTerminalRowRuns((x) => [cellAt("a", 1, c1), cellAt("b", 1, c2)][x], 0, 2)).toHaveLength(1);
    expect(buildTerminalRowRuns((x) => [cellAt("a", 1, c1), cellAt("b", 1, c3)][x], 0, 2)).toHaveLength(2);
  });
});

describe("TerminalGridView (Issue #98 Phase 4, @opentui/react/test-utils)", () => {
  test("renders plain text fed through session.onData", async () => {
    const session = createFakeSession();
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider theme={baseTheme}>
        <TerminalGridView session={session} cols={20} rows={3} />
      </ThemeProvider>,
      { width: 30, height: 5 },
    );
    await act(async () => {
      await renderOnce();
    });
    await act(async () => {
      session.fireData(new TextEncoder().encode("hello"));
    });

    // The VtEmulator's write() settles via `@xterm/headless`'s own
    // internal (macrotask-chunked) parser — poll rather than assume one
    // microtask tick is enough (`vtEmulator.test.ts`'s own tests `await`
    // the promise directly, which this component does not expose).
    let frame = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await renderOnce();
      });
      frame = captureCharFrame();
      if (frame.includes("hello")) break;
    }

    expect(frame).toContain("hello");
  });

  test("resizing calls session.resize with the (clamped) dimensions on mount", async () => {
    const session = createFakeSession();
    const { renderOnce } = await testRender(
      <ThemeProvider theme={baseTheme}>
        <TerminalGridView session={session} cols={15} rows={4} />
      </ThemeProvider>,
      { width: 20, height: 6 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(session.resizes).toContainEqual({ cols: 15, rows: 4 });
  });

  test("cols/rows are clamped to at least 1", async () => {
    const session = createFakeSession();
    const { renderOnce } = await testRender(
      <ThemeProvider theme={baseTheme}>
        <TerminalGridView session={session} cols={0} rows={0} />
      </ThemeProvider>,
      { width: 10, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(session.resizes).toContainEqual({ cols: 1, rows: 1 });
  });

  test("autoFocus imperatively focuses the root box on mount and sets terminalFocus", async () => {
    const session = createFakeSession();
    const { renderer, renderOnce } = await testRender(
      <ThemeProvider theme={baseTheme}>
        <TerminalGridView session={session} cols={10} rows={2} autoFocus />
      </ThemeProvider>,
      { width: 20, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });

    // `renderer.currentFocusedRenderable` mirrors `modalOverlay.tsx`'s own
    // "read the renderer's live focus state directly" precedent.
    expect((renderer as unknown as { currentFocusedRenderable?: unknown }).currentFocusedRenderable).not.toBeNull();
  });

  test("without autoFocus, mounting does not grab focus", async () => {
    const session = createFakeSession();
    const { renderer, renderOnce } = await testRender(
      <ThemeProvider theme={baseTheme}>
        <TerminalGridView session={session} cols={10} rows={2} />
      </ThemeProvider>,
      { width: 20, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect((renderer as unknown as { currentFocusedRenderable?: unknown }).currentFocusedRenderable).toBeNull();
  });

  test("onFocusHandleChange publishes a stable handle that re-focuses the view when called", async () => {
    const session = createFakeSession();
    let handle: (() => void) | undefined;
    const { renderer, renderOnce } = await testRender(
      <ThemeProvider theme={baseTheme}>
        <TerminalGridView
          session={session}
          cols={10}
          rows={2}
          onFocusHandleChange={(focus: () => void) => {
            handle = focus;
          }}
        />
      </ThemeProvider>,
      { width: 20, height: 4 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(handle).toBeDefined();
    expect((renderer as unknown as { currentFocusedRenderable?: unknown }).currentFocusedRenderable).toBeNull();

    await act(async () => {
      handle?.();
    });

    expect((renderer as unknown as { currentFocusedRenderable?: unknown }).currentFocusedRenderable).not.toBeNull();
  });

  test("renders with no session at all — a blank grid, never throws", async () => {
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider theme={baseTheme}>
        <TerminalGridView session={undefined} cols={5} rows={2} />
      </ThemeProvider>,
      { width: 10, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(() => captureCharFrame()).not.toThrow();
  });
});
