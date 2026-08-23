/**
 * `FindWidget` tests (Req 11.1, `findWidget.tsx`'s TSDoc): rendering the
 * query/replace text and match count, wiring `onChange` to `FindService`,
 * and the `ctrl+f`-opens-focused behavior (`findWidgetFocus` context key).
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createContextService } from "../keymap/context";
import { createInitialFindState, type FindState } from "./editorState";
import { ContextFocusTracker } from "./focus";
import { FindWidget, type FindWidgetProps } from "./findWidget";
import { ThemeProvider } from "./theme";

function findStateOf(partial: Partial<FindState>): FindState {
  return { ...createInitialFindState(), isOpen: true, ...partial };
}

function noopFindService(): FindWidgetProps["findService"] {
  return { setQuery() {}, setReplaceQuery() {}, toggleCaseSensitive() {} };
}

describe("FindWidget — rendering (Req 11.1)", () => {
  test("renders the query text and an empty match count for an empty query", async () => {
    const find = findStateOf({ query: "" });
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <FindWidget find={find} findService={noopFindService()} />
      </ThemeProvider>,
      { width: 80, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(captureCharFrame()).toContain("Find");
  });

  test("shows 'No results' for a non-empty query with zero matches", async () => {
    const find = findStateOf({ query: "xyz", matches: [], activeMatchIndex: -1 });
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <FindWidget find={find} findService={noopFindService()} />
      </ThemeProvider>,
      { width: 80, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(captureCharFrame()).toContain("No results");
  });

  test("shows 'current/total' for a query with matches", async () => {
    const matches = [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
      { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } },
    ];
    const find = findStateOf({ query: "foo", matches, activeMatchIndex: 1 });
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <FindWidget find={find} findService={noopFindService()} />
      </ThemeProvider>,
      { width: 80, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(captureCharFrame()).toContain("2/3");
  });

  test("the replace input renders the current replaceQuery text", async () => {
    const find = findStateOf({ query: "foo", replaceQuery: "bar" });
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <FindWidget find={find} findService={noopFindService()} />
      </ThemeProvider>,
      { width: 80, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(captureCharFrame()).toContain("bar");
  });

  test("shows a case-sensitivity indicator that reflects find.caseSensitive", async () => {
    const insensitive = findStateOf({ caseSensitive: false });
    const { renderOnce: renderInsensitive, captureCharFrame: frameInsensitive } = await testRender(
      <ThemeProvider>
        <FindWidget find={insensitive} findService={noopFindService()} />
      </ThemeProvider>,
      { width: 80, height: 3 },
    );
    await act(async () => {
      await renderInsensitive();
    });
    expect(frameInsensitive()).not.toContain("[Aa]");

    const sensitive = findStateOf({ caseSensitive: true });
    const { renderOnce: renderSensitive, captureCharFrame: frameSensitive } = await testRender(
      <ThemeProvider>
        <FindWidget find={sensitive} findService={noopFindService()} />
      </ThemeProvider>,
      { width: 80, height: 3 },
    );
    await act(async () => {
      await renderSensitive();
    });
    expect(frameSensitive()).toContain("[Aa]");
  });
});

describe("FindWidget — opens focused (Req 11.1)", () => {
  test("mounting with find.isOpen true focuses the query input, reporting findWidgetFocus true", async () => {
    const context = createContextService();
    const find = findStateOf({ isOpen: true });

    const { renderOnce } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <FindWidget find={find} findService={noopFindService()} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(context.get<boolean>("findWidgetFocus")).toBe(true);
  });
});

describe("FindWidget — findWidgetFocus stays true across query/replace focus moves (CodeRabbit PR #59 Finding 4)", () => {
  test("focusing the replace input keeps findWidgetFocus true (both inputs share the context key)", async () => {
    const context = createContextService();
    const find = findStateOf({ isOpen: true });

    const { renderOnce, renderer } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <FindWidget find={find} findService={noopFindService()} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });

    // The mount effect already focused the query input (the test above).
    expect(context.get<boolean>("findWidgetFocus")).toBe(true);

    const replaceInput = findInputByPlaceholder(renderer.root, "Replace");
    expect(replaceInput).toBeDefined();

    // Moving OpenTUI's real single-focus pointer onto the replace input:
    // `Renderable.focus()` synchronously blurs whatever was previously
    // focused (the query input) BEFORE the replace input's own `focused`
    // event fires (this module's TSDoc's "findWidgetFocus context key —
    // BOTH inputs report into it"). Before Finding 4's fix, only the query
    // input tracked the key, so this transition would have left
    // `findWidgetFocus` stuck `false` — disabling `return`/`shift+return`/
    // `escape` for as long as focus stayed in the replace field.
    replaceInput!.focus();

    expect(context.get<boolean>("findWidgetFocus")).toBe(true);
  });

  test("blurring the replace input (with nothing else focused) clears findWidgetFocus", async () => {
    const context = createContextService();
    const find = findStateOf({ isOpen: true });

    const { renderOnce, renderer } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <FindWidget find={find} findService={noopFindService()} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 3 },
    );
    await act(async () => {
      await renderOnce();
    });

    const replaceInput = findInputByPlaceholder(renderer.root, "Replace");
    replaceInput!.focus();
    expect(context.get<boolean>("findWidgetFocus")).toBe(true);

    replaceInput!.blur();
    expect(context.get<boolean>("findWidgetFocus")).toBe(false);
  });
});

/** Depth-first search for an OpenTUI `<input>` renderable by its
 * `placeholder` text — used only by the tests above to drive the real
 * query/replace `Renderable.focus()`/`.blur()` without `FindWidget`
 * exposing test-only refs on its public props (matches `shell.test.tsx`'s
 * `findAllFocusable`/`findTabSelect` idiom for the same reason). */
function findInputByPlaceholder(
  node: unknown,
  placeholder: string,
): { focus(): void; blur(): void } | undefined {
  const candidate = node as {
    placeholder?: string;
    focus?: () => void;
    blur?: () => void;
    getChildren?: () => unknown[];
  };
  if (candidate?.placeholder === placeholder && candidate.focus && candidate.blur) {
    return candidate as { focus(): void; blur(): void };
  }
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findInputByPlaceholder(child, placeholder);
    if (found) return found;
  }
  return undefined;
}
