/**
 * `ModalOverlay` tests (Task 3.1, Req 10.1, `modalOverlay.tsx`'s TSDoc):
 * rendering both modes, filter-as-you-type narrowing the rendered list,
 * end-to-end keyboard accept/cancel through the real `modal.*` commands +
 * binding table, and focus save/restore across open/close.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { BoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createBindingTable } from "../keymap/bindingTable";
import { createContextService } from "../keymap/context";
import { createCommandRegistry } from "../commands/registry";
import { createHostLog } from "../host/errors";
import { ContextFocusTracker } from "./focus";
import { MODAL_DEFAULT_KEYBINDINGS, registerModalCommands } from "./modalCommands";
import { modalMarginRows, ModalOverlay } from "./modalOverlay";
import { createModalService } from "./modalService";
import { ThemeProvider } from "./theme";

/** Depth-first search for an OpenTUI `<input>` renderable by its
 * `placeholder` text — matches `findWidget.test.tsx`'s identical helper
 * (this module has no test-only refs on `ModalOverlay`'s public props
 * either). */
function findInputByPlaceholder(
  node: unknown,
  placeholder: string,
): { insertText(text: string): void; submit(): boolean; value: string } | undefined {
  const candidate = node as {
    placeholder?: string;
    insertText?: (text: string) => void;
    submit?: () => boolean;
    value?: string;
    getChildren?: () => unknown[];
  };
  if (
    candidate?.placeholder === placeholder &&
    candidate.insertText &&
    candidate.submit
  ) {
    return candidate as { insertText(text: string): void; submit(): boolean; value: string };
  }
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findInputByPlaceholder(child, placeholder);
    if (found) return found;
  }
  return undefined;
}

/** Depth-first search for the quick pick's underlying OpenTUI `<select>`
 * renderable — found by its distinctive method signature
 * (`getSelectedIndex`/`setSelectedIndex`) rather than `instanceof
 * SelectRenderable` (`@opentui/core` isn't otherwise imported as a runtime
 * value here) or a `constructor.name` string check (fragile under any
 * future minification of the vendored bundle). Exposes the real, laid-out
 * `y`/`height` this suite's regression test needs — `List`'s own React
 * props (`components.tsx`) don't reveal what OpenTUI's Yoga layout actually
 * resolved them to. */
function findSelect(
  node: unknown,
): { y: number; height: number; getSelectedIndex(): number; getChildren?: () => unknown[] } | undefined {
  const candidate = node as {
    getSelectedIndex?: () => number;
    setSelectedIndex?: (index: number) => void;
    y?: number;
    height?: number;
    getChildren?: () => unknown[];
  };
  if (typeof candidate?.getSelectedIndex === "function" && typeof candidate?.setSelectedIndex === "function") {
    return candidate as { y: number; height: number; getSelectedIndex(): number; getChildren?: () => unknown[] };
  }
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findSelect(child);
    if (found) return found;
  }
  return undefined;
}

describe("ModalOverlay — rendering", () => {
  test("renders nothing while no modal is open", async () => {
    const modalService = createModalService();
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ModalOverlay modalService={modalService} />
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(captureCharFrame().trim()).toBe("");
  });

  test("quick pick: renders every item's label and the filter placeholder", async () => {
    const modalService = createModalService();
    void modalService.openQuickPick(
      [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
      { placeHolder: "Type to filter" },
    );
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ModalOverlay modalService={modalService} />
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });
    const frame = captureCharFrame();
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Beta");
    expect(frame).toContain("Gamma");
  });

  test("input box: renders the prompt, current value, and a validation message", async () => {
    const modalService = createModalService();
    void modalService.openInputBox({
      prompt: "Enter a name",
      value: "abc",
      validateInput: () => "Name is required",
    });
    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ModalOverlay modalService={modalService} />
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });
    const frame = captureCharFrame();
    expect(frame).toContain("Enter a name");
    expect(frame).toContain("abc");
    expect(frame).toContain("Name is required");
  });
});

describe("ModalOverlay — filter-as-you-type (Req 10.1)", () => {
  test("typing into the filter Input narrows the rendered list", async () => {
    const modalService = createModalService();
    void modalService.openQuickPick([{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }]);
    const { renderOnce, captureCharFrame, renderer } = await testRender(
      <ThemeProvider>
        <ModalOverlay modalService={modalService} />
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });
    expect(captureCharFrame()).toContain("Alpha");

    const filterInput = findInputByPlaceholder(renderer.root, "");
    expect(filterInput).toBeDefined();
    act(() => {
      filterInput!.insertText("beta");
    });
    await act(async () => {
      await renderOnce();
    });

    const frame = captureCharFrame();
    expect(frame).toContain("Beta");
    expect(frame).not.toContain("Alpha");
    expect(frame).not.toContain("Gamma");
  });
});

describe("ModalOverlay — end-to-end keyboard accept/cancel through the real modal.* commands", () => {
  function buildPipeline() {
    const log = createHostLog();
    const context = createContextService();
    const commands = createCommandRegistry({ log, sink: { error() {} } });
    const modalService = createModalService();
    registerModalCommands(commands, modalService);
    const table = createBindingTable(
      { defaults: MODAL_DEFAULT_KEYBINDINGS, fallback: [], extension: [], preset: [], user: [] },
      { log },
    );
    return { context, commands, modalService, table };
  }

  test("pressing Enter (return) while quickPickFocus is true resolves the active item", async () => {
    const { context, commands, modalService, table } = buildPipeline();
    const pending = modalService.openQuickPick([{ label: "Only" }]);

    const { renderOnce } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <ModalOverlay modalService={modalService} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    // The filter Input's mount effect already focused itself (mirrors
    // findWidget.tsx's "Ctrl+F opens focused").
    expect(context.get<boolean>("quickPickFocus")).toBe(true);

    const resolved = table.lookup("return", (key) => Boolean(context.get(key)));
    expect(resolved?.command).toBe("modal.accept");
    await act(async () => {
      await commands.execute(resolved!.command);
    });

    expect(await pending).toEqual({ label: "Only" });
  });

  test("pressing Escape while inputBoxFocus is true resolves undefined and closes the modal", async () => {
    const { context, commands, modalService, table } = buildPipeline();
    const pending = modalService.openInputBox();

    const { renderOnce } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <ModalOverlay modalService={modalService} />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(context.get<boolean>("inputBoxFocus")).toBe(true);

    const resolved = table.lookup("escape", (key) => Boolean(context.get(key)));
    expect(resolved?.command).toBe("modal.close");
    await act(async () => {
      await commands.execute(resolved!.command);
    });

    expect(await pending).toBeUndefined();
    expect(modalService.getState().mode).toBeNull();
  });

  test("up/down are NOT bound while inputBoxFocus is true (quickPickFocus-only gating)", () => {
    const { context, table } = buildPipeline();
    context.set("inputBoxFocus", true);
    expect(table.lookup("down", (key) => Boolean(context.get(key)))).toBeUndefined();
    expect(table.lookup("up", (key) => Boolean(context.get(key)))).toBeUndefined();
  });
});

describe("ModalOverlay — focus save/restore (Req 10.1)", () => {
  test("opening a modal moves focus to it; closing restores focus to whatever was focused before", async () => {
    const context = createContextService();
    const modalService = createModalService();
    let priorNode: BoxRenderable | null = null;

    function Harness() {
      return (
        <box style={{ flexDirection: "column" }}>
          <box
            focusable
            ref={(node: BoxRenderable | null) => {
              priorNode = node;
            }}
          />
          <ModalOverlay modalService={modalService} />
        </box>
      );
    }

    const { renderOnce, renderer } = await testRender(
      <ThemeProvider>
        <ContextFocusTracker context={context}>
          <Harness />
        </ContextFocusTracker>
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await act(async () => {
      await renderOnce();
    });

    expect(priorNode).not.toBeNull();
    priorNode!.focus();
    expect(renderer.currentFocusedRenderable).toBe(priorNode as unknown as BoxRenderable);

    // Opening the quick pick steals focus onto its own filter Input.
    act(() => {
      void modalService.openQuickPick([{ label: "A" }]);
    });
    await act(async () => {
      await renderOnce();
    });
    expect(context.get<boolean>("quickPickFocus")).toBe(true);
    expect(renderer.currentFocusedRenderable).not.toBe(priorNode as unknown as BoxRenderable);

    // Closing it (Escape/cancel) restores focus to the prior node.
    act(() => {
      modalService.cancel();
    });
    await act(async () => {
      await renderOnce();
    });
    expect(context.get<boolean>("quickPickFocus")).toBe(false);
    expect(renderer.currentFocusedRenderable).toBe(priorNode as unknown as BoxRenderable);
  });
});

describe("ModalOverlay — long quick picks stay bounded and scrollable (issue #93 regression)", () => {
  test("far more items than the terminal has rows: the select's rendered rows fit inside the terminal, and the active item is inside its visible window", async () => {
    const TERMINAL_WIDTH = 80;
    const TERMINAL_HEIGHT = 20;
    const ITEM_COUNT = 100;
    const items = Array.from({ length: ITEM_COUNT }, (_, i) => ({ label: `Item ${i}` }));
    const modalService = createModalService();
    void modalService.openQuickPick(items);

    const { renderOnce, renderer, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ModalOverlay modalService={modalService} />
      </ThemeProvider>,
      { width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT },
    );
    await act(async () => {
      await renderOnce();
    });

    // The bug (issue #93): `List` used to size its `<select>` to
    // `Math.max(items.length, 1)` UNCONDITIONALLY — with 100 items in a
    // 20-row terminal, the select's own assigned height was 100, so (a) it
    // was laid out far past the terminal's bottom edge, and (b) OpenTUI's
    // own `updateScrollOffset` can only ever resolve `scrollOffset` to `0`
    // when `height >= options.length` (`components.tsx`'s TSDoc) — so it
    // could never scroll a later item into view either.
    const select = findSelect(renderer.root);
    expect(select).toBeDefined();
    expect(select!.height).toBeLessThan(ITEM_COUNT);
    expect(select!.y + select!.height).toBeLessThanOrEqual(TERMINAL_HEIGHT);
    // And it isn't sized to some degenerate near-zero window either — this
    // is a REAL, usable scrollable list, not just "technically bounded".
    const availableRows = TERMINAL_HEIGHT - modalMarginRows(TERMINAL_HEIGHT);
    expect(select!.height).toBeGreaterThan(0);
    expect(select!.height).toBeLessThanOrEqual(availableRows);

    // The active item (index 0 initially) is the very first row — always
    // trivially visible, bug or no bug. The real regression check is what
    // happens once the SELECTION moves somewhere the OLD, unbounded layout
    // would have drawn far below row 20.
    expect(captureCharFrame()).toContain("Item 0");

    // Move the active selection all the way to the LAST item.
    for (let i = 0; i < ITEM_COUNT - 1; i++) {
      act(() => modalService.selectNext());
    }
    await act(async () => {
      await renderOnce();
    });
    expect(modalService.getState()).toMatchObject({ mode: "quickPick", activeIndex: ITEM_COUNT - 1 });

    const frame = captureCharFrame();
    expect(frame).toContain(`Item ${ITEM_COUNT - 1}`);
  });
});

describe("ModalOverlay — a long input-box prompt never hides the input itself", () => {
  // NOT a regression test: no code change was needed to make this pass.
  // Review raised the worry that `InputBoxBody`'s `maxHeight` +
  // `overflow: "hidden"` clip could push the `Input` and the validation
  // message out through the bottom edge behind a long enough prompt,
  // leaving a modal that takes keystrokes it cannot show. Rendering a
  // 468-character prompt in a 40x20 terminal shows it does not: the prompt
  // truncates and both stay on screen. Adding an explicit `flexShrink: 1`
  // to the prompt produced a byte-identical frame, so that configuration
  // was dropped rather than kept as a no-op. This test pins the behaviour
  // the clip already has, so a future layout change cannot quietly take it
  // away.
  test("a prompt long enough to overflow the clip still leaves the typed value and validation message on screen", async () => {
    const TERMINAL_WIDTH = 40;
    const TERMINAL_HEIGHT = 20;
    // 468 characters — long enough to wrap well past the modal's own
    // clipped height at this width.
    const prompt = "This prompt is deliberately very long. ".repeat(12);
    const modalService = createModalService();
    void modalService.openInputBox({ prompt, validateInput: () => "VALIDATION_SENTINEL" });
    modalService.setInputValue("TYPED_SENTINEL");

    const { renderOnce, captureCharFrame } = await testRender(
      <ThemeProvider>
        <ModalOverlay modalService={modalService} />
      </ThemeProvider>,
      { width: TERMINAL_WIDTH, height: TERMINAL_HEIGHT },
    );
    await act(async () => {
      await renderOnce();
    });

    const frame = captureCharFrame();
    // A modal that accepts keystrokes must show them. Losing some of the
    // prompt to the clip is the acceptable trade; losing the field the user
    // is typing into would not be.
    expect(frame).toContain("TYPED_SENTINEL");
    expect(frame).toContain("VALIDATION_SENTINEL");
  });
});
