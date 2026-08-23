/**
 * End-to-end proof that `ctrl+p`'s pick path really opens a file and makes
 * it the active tab (Task 3.2, Req 11.3) — through the REAL production
 * pipeline (`editingHarness.tsx`'s `buildEditingHarness`: real
 * `AssemblyRoot`, real `@tecode/builtin` extensions including
 * `command-palette` itself since `builtins` is left at its default, real
 * `ModalService`, real `FileSystem`).
 *
 * **Why this drives `commands.execute("workbench.action.quickOpen")`
 * directly rather than a real keystroke**: `ctrl+p` resolving to
 * `workbench.action.quickOpen` through the chord machine/binding table is
 * already proven at the table level by `commandPaletteKeybindings.test.ts`
 * (and matches the exact same "keybinding -> `commands.execute`" wiring
 * every other keybinding in this codebase goes through, e.g.
 * `keyRouting.test.ts`'s own suite) — what THIS test proves is the part
 * that is genuinely specific to Task 3.2 and not covered by any
 * piece-wise unit test: `command-palette`'s real handler walking the REAL
 * filesystem via `tecode.workspace.fs.readdir`, opening the REAL
 * `ModalService`-backed `showQuickPick`, and — on a real user pick,
 * driven the same way a keystroke-driven `modal.accept` command would —
 * ending with the file genuinely open and active via the real
 * `DocumentManager`/`EditorSessionService`, not a fake standing in for
 * either.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToUri } from "@tecode/core";
import { buildEditingHarness, waitForEvent, writeFixtureFile, type EditingHarness } from "./editingHarness";

describe("ctrl+p's pick path opens the file end-to-end (Task 3.2, Req 11.3)", () => {
  let homeDir: string | undefined;
  let workspaceDir: string | undefined;
  let harness: EditingHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    harness = undefined;
    workspaceDir = undefined;
    homeDir = undefined;
  });

  test(
    "picking a walked file opens it and makes it the active document",
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), "tecode-quickopen-home-"));
      workspaceDir = await mkdtemp(join(tmpdir(), "tecode-quickopen-ws-"));
      const filePath = join(workspaceDir, "notes.txt");
      await writeFixtureFile(filePath, "hello from quick-open\n");

      harness = await buildEditingHarness({ workspaceRoot: workspaceDir, homeDir });
      const { root } = harness;

      // Sanity: command-palette really loaded (it's a real, default
      // builtin now — no `builtins` override was passed above).
      expect(loadedCommandPalette(harness)).toBe(true);
      expect(root.editorSession.getActiveDocumentUri()).toBeUndefined();
      expect(root.documents.documents).toHaveLength(0);

      // Fire quick-open (equivalent to a real ctrl+p keystroke resolving to
      // this same command id — `commandPaletteKeybindings.test.ts` proves
      // that resolution at the table level) and wait for the REAL
      // ModalService to actually open with the walked file listed, before
      // simulating the user's pick.
      const opened = waitForEvent(root.modalService.onDidChange);
      const quickOpenDone = root.commands.execute("workbench.action.quickOpen");
      await opened;

      const state = root.modalService.getState();
      if (state.mode !== "quickPick") throw new Error(`expected quickPick state, got ${state.mode}`);
      const item = state.items.find((i) => i.label === "notes.txt");
      expect(item).toBeDefined();
      expect(item?.description).toBe(pathToUri(filePath));

      // Narrow to exactly this item (mirrors typing into the real filter
      // input) and accept — the same `ModalService.accept()` a real Enter
      // keystroke drives via the `modal.accept` command.
      root.modalService.setFilter("notes.txt");
      root.modalService.accept();

      await quickOpenDone;

      expect(root.editorSession.getActiveDocumentUri()).toBe(pathToUri(filePath));
      expect(root.documents.documents.map((d) => d.uri)).toEqual([pathToUri(filePath)]);
    },
    20_000,
  );

  test(
    "cancelling the picker (Escape-equivalent) opens no document",
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), "tecode-quickopen-home-"));
      workspaceDir = await mkdtemp(join(tmpdir(), "tecode-quickopen-ws-"));
      await writeFixtureFile(join(workspaceDir, "a.ts"), "export {};\n");

      harness = await buildEditingHarness({ workspaceRoot: workspaceDir, homeDir });
      const { root } = harness;

      const opened = waitForEvent(root.modalService.onDidChange);
      const quickOpenDone = root.commands.execute("workbench.action.quickOpen");
      await opened;

      root.modalService.cancel();
      await quickOpenDone;

      expect(root.editorSession.getActiveDocumentUri()).toBeUndefined();
      expect(root.documents.documents).toHaveLength(0);
    },
    20_000,
  );
});

/** Whether `tecode.command-palette` is among the extensions this harness
 * actually loaded — a real built-in, not overridden away. */
function loadedCommandPalette(harness: EditingHarness): boolean {
  return harness.loadResult.loaded.some((e) => e.extensionId === "tecode.command-palette");
}
