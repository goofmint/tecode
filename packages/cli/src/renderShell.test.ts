import { expect, test } from "bun:test";
import {
  createContextService,
  createHostLog,
  createLayoutStateService,
  createNoopStatusSink,
  createSlotRegistry,
  createCommandRegistry,
} from "@tecode/core";
import { createBaseTheme } from "@tecode/core";
import { renderShellHeadless } from "./renderShell";

// renderShellToTerminal is intentionally NOT exercised here: it opens a
// real @opentui/core CliRenderer/TTY, which bun test's sandboxed, non-TTY
// stdout cannot provide (and must never attempt to — see renderShell.tsx's
// TSDoc and this task's TECODE_HEADLESS adaptation). `bunx tsc --noEmit`
// is what proves it type-checks; this file only proves the headless seam
// used by every other test (and TECODE_HEADLESS=1) behaves.

test("renderShellHeadless resolves without touching a real terminal", async () => {
  const log = createHostLog();
  const sink = createNoopStatusSink();
  const deps = {
    slotRegistry: createSlotRegistry({ log }),
    layoutState: createLayoutStateService({
      log,
      sink,
      path: "/dev/null/unused-in-this-test",
      fs: {
        readFile: () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
        mkdir: () => Promise.resolve(),
        writeFile: () => Promise.resolve(),
      },
    }),
    context: createContextService(),
    commands: createCommandRegistry({ log, sink }),
    theme: createBaseTheme(),
  };

  await expect(renderShellHeadless(deps)).resolves.toBeUndefined();
});
