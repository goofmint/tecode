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
import { ModalOverlay } from "./modalOverlay";
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
      { defaults: MODAL_DEFAULT_KEYBINDINGS, fallback: [], extension: [], user: [] },
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
