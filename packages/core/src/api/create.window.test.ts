/**
 * Tests for `createTecodeApi`'s real `tecode.window` wiring (Task 3.1, Req
 * 10.1): `showQuickPick`/`showInputBox` delegate to an injected
 * `ModalService`, and `showMessage`/`setStatusBarItem` delegate to an
 * injected `WindowMessageService`, falling back to `stubs.ts`'s
 * `createWindowStub` exactly as before when either dep is omitted
 * (`CreateTecodeApiDeps.modalService`/`windowMessageService`'s TSDoc).
 */

import { describe, expect, test } from "bun:test";
import { createCommandRegistry } from "../commands/registry";
import { createDocumentManager } from "../buffer/documentManager";
import { createFileSystem } from "../buffer/fileSystem";
import type { ConfigServiceFs } from "../config/service";
import { createConfigService } from "../config/service";
import { createContextService } from "../keymap/context";
import { createHostLog } from "../host/errors";
import { createModalService } from "../ui/modalService";
import { createSlotRegistry } from "../ui/slotRegistry";
import { createWindowMessageService, WINDOW_MESSAGE_STATUS_BAR_ITEM_ID } from "../ui/windowMessageService";
import { createTecodeApi } from "./create";

function createEmptyConfigFs(): ConfigServiceFs {
  return {
    readFile: () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    watch: () => ({ close() {} }),
  };
}

async function buildBaseDeps() {
  const log = createHostLog();
  const sink = { error() {} };
  const commands = createCommandRegistry({ log, sink });
  const documents = createDocumentManager({ log, sink });
  const fs = createFileSystem({ log });
  const config = createConfigService({ log, sink, fs: createEmptyConfigFs() });
  await config.ready;
  const context = createContextService();
  return { commands, documents, fs, config, context, sink };
}

describe("createTecodeApi's tecode.window (Task 3.1)", () => {
  test("falls back to the stub when neither modalService nor windowMessageService is supplied", async () => {
    const deps = await buildBaseDeps();
    const api = createTecodeApi(deps);

    await expect(api.window.showQuickPick([{ label: "A" }])).resolves.toBeUndefined();
    await expect(api.window.showInputBox()).resolves.toBeUndefined();
    expect(() => api.window.showMessage("hi")).not.toThrow();
    // setStatusBarItem still returns a real, disposable registration — just
    // not one anything renders (`stubs.ts`'s `createWindowStub` TSDoc).
    const disposable = api.window.setStatusBarItem({ id: "x", text: "t", side: "left", priority: 0 });
    expect(() => disposable.dispose()).not.toThrow();
  });

  test("showQuickPick/showInputBox delegate to the real ModalService when supplied", async () => {
    const deps = await buildBaseDeps();
    const modalService = createModalService();
    const api = createTecodeApi({ ...deps, modalService });

    const pending = api.window.showQuickPick([{ label: "Only" }], { placeHolder: "pick one" });
    // The SAME service instance backs it — driving it directly resolves the
    // API-facing promise (host + extension share state, matching
    // `create.languages.test.ts`'s equivalent assertion).
    modalService.accept();
    expect(await pending).toEqual({ label: "Only" });

    const pendingInput = api.window.showInputBox({ value: "seed" });
    modalService.accept();
    expect(await pendingInput).toBe("seed");
  });

  test("showQuickPick/showInputBox are the exact same function references as ModalService's own methods (no wrapper closures)", async () => {
    const deps = await buildBaseDeps();
    const modalService = createModalService();
    const api = createTecodeApi({ ...deps, modalService });
    expect(api.window.showQuickPick).toBe(modalService.openQuickPick);
    expect(api.window.showInputBox).toBe(modalService.openInputBox);
  });

  test("showMessage/setStatusBarItem delegate to the real WindowMessageService when supplied, rendering into the live slot registry", async () => {
    const deps = await buildBaseDeps();
    const slotRegistry = createSlotRegistry();
    const windowMessageService = createWindowMessageService({ slotRegistry, setTimeout: () => 0, clearTimeout: () => {} });
    const api = createTecodeApi({ ...deps, slotRegistry, windowMessageService });

    api.window.showMessage("Saved.", "info");
    expect(slotRegistry.getView("statusBar.item", WINDOW_MESSAGE_STATUS_BAR_ITEM_ID)?.title).toContain("Saved.");

    const disposable = api.window.setStatusBarItem({ id: "ext.item", text: "hello", side: "right", priority: 3 });
    expect(slotRegistry.getView("statusBar.item", "ext.item")?.title).toBe("hello");
    disposable.dispose();
    expect(slotRegistry.getView("statusBar.item", "ext.item")).toBeUndefined();
  });

  test("activeEditor/showQuickPick/showInputBox stay stubbed when only windowMessageService is supplied (independent gating)", async () => {
    const deps = await buildBaseDeps();
    const slotRegistry = createSlotRegistry();
    const windowMessageService = createWindowMessageService({ slotRegistry, setTimeout: () => 0, clearTimeout: () => {} });
    const api = createTecodeApi({ ...deps, slotRegistry, windowMessageService });

    await expect(api.window.showQuickPick([{ label: "A" }])).resolves.toBeUndefined();
    await expect(api.window.showInputBox()).resolves.toBeUndefined();
  });

  test("showMessage/setStatusBarItem fall back to the stub when windowMessageService was built on a DIFFERENT slot registry (identity gate)", async () => {
    const deps = await buildBaseDeps();
    // Registry A backs the API (what the rendered Shell's StatusBar would
    // read); registry B backs the message service — the cross-instance
    // wiring bug `WindowMessageService.registry`'s TSDoc guards against.
    const registryA = createSlotRegistry();
    const registryB = createSlotRegistry();
    const windowMessageService = createWindowMessageService({
      slotRegistry: registryB,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const api = createTecodeApi({ ...deps, slotRegistry: registryA, windowMessageService });

    api.window.showMessage("lost?", "info");
    const disposable = api.window.setStatusBarItem({ id: "ext.item", text: "hello", side: "right", priority: 3 });
    disposable.dispose();
    // The stub handled both calls — NEITHER registry saw a registration.
    expect(registryA.getViews("statusBar.item").length).toBe(0);
    expect(registryB.getViews("statusBar.item").length).toBe(0);
  });

  test("showMessage/setStatusBarItem stay stubbed when only modalService is supplied (independent gating)", async () => {
    const deps = await buildBaseDeps();
    const slotRegistry = createSlotRegistry();
    const modalService = createModalService();
    const api = createTecodeApi({ ...deps, slotRegistry, modalService });

    api.window.showMessage("hi");
    // No WindowMessageService means the stub handled it — nothing landed in
    // the real slot registry.
    expect(slotRegistry.getViews("statusBar.item").length).toBe(0);
  });
});
