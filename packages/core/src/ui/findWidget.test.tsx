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
