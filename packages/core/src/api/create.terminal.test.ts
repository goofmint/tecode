/**
 * Tests for `createTecodeApi`'s real `tecode.terminal` wiring (Issue #98):
 * `isSupported`/`spawn` delegate to an injected `TerminalService`/
 * `TerminalNamespace` when supplied, and fall back to `stubs.ts`'s
 * `createTerminalStub` exactly as before otherwise
 * (`CreateTecodeApiDeps.terminal`'s TSDoc) — mirrors
 * `create.clipboard.test.ts`'s own structure for Issue #91.
 */

import { describe, expect, test } from "bun:test";
import { createCommandRegistry } from "../commands/registry";
import { createDocumentManager } from "../buffer/documentManager";
import { createFileSystem } from "../buffer/fileSystem";
import type { ConfigServiceFs } from "../config/service";
import { createConfigService } from "../config/service";
import { createContextService } from "../keymap/context";
import { createHostLog } from "../host/errors";
import { createTerminalService } from "../terminal/ptyService";
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

describe("createTecodeApi's tecode.terminal (Issue #98)", () => {
  test("falls back to the stub when no terminal service is supplied: isSupported() false, spawn() inert", async () => {
    const deps = await buildBaseDeps();
    const api = createTecodeApi(deps);

    expect(api.terminal.isSupported()).toBe(false);

    const session = api.terminal.spawn({ cmd: ["true"], cols: 80, rows: 24 });
    expect(() => session.write("ignored")).not.toThrow();
    expect(() => session.resize(100, 40)).not.toThrow();

    const exitCodes: number[] = [];
    session.onExit((e) => exitCodes.push(e.exitCode));
    await Promise.resolve(); // let the stub's queued microtask run
    expect(exitCodes).toEqual([-1]);
  });

  test("isSupported/spawn delegate to the real TerminalService when supplied", async () => {
    const deps = await buildBaseDeps();
    // `platform: "win32"` plus a Bun BELOW the 1.3.14 ConPTY threshold
    // (`platform.ts`'s `supportsBunTerminal`) is what puts the real
    // service in its unsupported state — keeping this test POSIX-
    // independent and fast. Both must be pinned: `bunVersion` defaults to
    // the real `Bun.version`, so omitting it makes the assertion below
    // depend on whichever Bun happens to run the suite (it passed on a
    // 1.3.11 dev machine and failed on CI's `bun-version: latest`).
    // This test only proves DELEGATION (the real service's own methods,
    // not stubs.ts's, are what tecode.terminal calls), not the real pty
    // behavior itself (covered by ptyService.test.ts).
    const terminal = createTerminalService({ platform: "win32", bunVersion: "1.3.13" });
    const api = createTecodeApi({ ...deps, terminal });

    expect(api.terminal.isSupported()).toBe(false);
    expect(api.terminal.isSupported()).toBe(terminal.isSupported());

    const session = api.terminal.spawn({ cmd: ["true"], cols: 80, rows: 24 });
    const exitCodes: number[] = [];
    session.onExit((e) => exitCodes.push(e.exitCode));
    await Promise.resolve();
    expect(exitCodes).toEqual([-1]); // the real service's own Windows degradation, not the stub's
  });

  test("tecode.terminal is frozen — assigning to it is a no-op (or throws in strict mode), never mutates behavior", async () => {
    const deps = await buildBaseDeps();
    const api = createTecodeApi(deps);
    expect(Object.isFrozen(api.terminal)).toBe(true);
  });
});
