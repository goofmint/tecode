/**
 * `registerModalCommands`/`MODAL_DEFAULT_KEYBINDINGS` tests (Task 3.1, Req
 * 10.1, `modalCommands.ts`'s TSDoc).
 */

import { describe, expect, test } from "bun:test";
import { createCommandRegistry } from "../commands/registry";
import { createHostLog, createNoopStatusSink } from "../host/index";
import { createModalService } from "./modalService";
import {
  INPUT_BOX_FOCUS_CONTEXT_KEY,
  MODAL_ACCEPT_COMMAND,
  MODAL_CLOSE_COMMAND,
  MODAL_DEFAULT_KEYBINDINGS,
  MODAL_SELECT_NEXT_COMMAND,
  MODAL_SELECT_PREVIOUS_COMMAND,
  QUICK_PICK_FOCUS_CONTEXT_KEY,
  registerModalCommands,
} from "./modalCommands";

function realCommands() {
  return createCommandRegistry({ log: createHostLog(), sink: createNoopStatusSink() });
}

describe("registerModalCommands", () => {
  test("each command delegates one-to-one to the matching ModalService method", async () => {
    const commands = realCommands();
    const modalService = createModalService();
    void modalService.openQuickPick([{ label: "A" }, { label: "B" }]);
    registerModalCommands(commands, modalService);

    await commands.execute(MODAL_SELECT_NEXT_COMMAND);
    let state = modalService.getState();
    if (state.mode !== "quickPick") throw new Error("unreachable");
    expect(state.activeIndex).toBe(1);

    await commands.execute(MODAL_SELECT_PREVIOUS_COMMAND);
    state = modalService.getState();
    if (state.mode !== "quickPick") throw new Error("unreachable");
    expect(state.activeIndex).toBe(0);

    await commands.execute(MODAL_CLOSE_COMMAND);
    expect(modalService.getState().mode).toBeNull();
  });

  test("modal.accept resolves the open quick pick's active item", async () => {
    const commands = realCommands();
    const modalService = createModalService();
    const pending = modalService.openQuickPick([{ label: "Only" }]);
    registerModalCommands(commands, modalService);

    await commands.execute(MODAL_ACCEPT_COMMAND);
    expect(await pending).toEqual({ label: "Only" });
  });

  test("the returned Disposable unregisters all 4 commands, idempotently", async () => {
    const commands = realCommands();
    const modalService = createModalService();
    const disposable = registerModalCommands(commands, modalService);

    const ids = commands.list().map((c) => c.id);
    expect(ids).toContain(MODAL_SELECT_NEXT_COMMAND);
    expect(ids).toContain(MODAL_ACCEPT_COMMAND);

    disposable.dispose();
    const idsAfter = commands.list().map((c) => c.id);
    expect(idsAfter).not.toContain(MODAL_SELECT_NEXT_COMMAND);
    expect(idsAfter).not.toContain(MODAL_ACCEPT_COMMAND);
    expect(() => disposable.dispose()).not.toThrow();
  });
});

describe("MODAL_DEFAULT_KEYBINDINGS", () => {
  test("up/down are gated on quickPickFocus only", () => {
    const upDown = MODAL_DEFAULT_KEYBINDINGS.filter((b) => b.key === "up" || b.key === "down");
    expect(upDown.length).toBe(2);
    for (const binding of upDown) {
      expect(binding.when).toBe(QUICK_PICK_FOCUS_CONTEXT_KEY);
    }
  });

  test("return/escape are gated on quickPickFocus || inputBoxFocus", () => {
    const returnEscape = MODAL_DEFAULT_KEYBINDINGS.filter((b) => b.key === "return" || b.key === "escape");
    expect(returnEscape.length).toBe(2);
    for (const binding of returnEscape) {
      expect(binding.when).toContain(QUICK_PICK_FOCUS_CONTEXT_KEY);
      expect(binding.when).toContain(INPUT_BOX_FOCUS_CONTEXT_KEY);
    }
  });
});
