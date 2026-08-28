/**
 * Tests for `createTecodeApi`'s real `tecode.clipboard` wiring (Issue #91):
 * `read`/`write` delegate to an injected `Clipboard`/`ClipboardNamespace`
 * when supplied, and fall back to `stubs.ts`'s `createClipboardStub`
 * exactly as before otherwise (`CreateTecodeApiDeps.clipboard`'s TSDoc).
 */

import { describe, expect, test } from "bun:test";
import { createCommandRegistry } from "../commands/registry";
import { createDocumentManager } from "../buffer/documentManager";
import { createFileSystem } from "../buffer/fileSystem";
import type { ConfigServiceFs } from "../config/service";
import { createConfigService } from "../config/service";
import { createContextService } from "../keymap/context";
import { createHostLog } from "../host/errors";
import { createClipboard } from "../clipboard/clipboard";
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

describe("createTecodeApi's tecode.clipboard (Issue #91)", () => {
  test("falls back to the stub when no clipboard is supplied: read() resolves '', write() is a no-op", async () => {
    const deps = await buildBaseDeps();
    const api = createTecodeApi(deps);

    expect(await api.clipboard.read()).toBe("");
    await expect(api.clipboard.write("ignored")).resolves.toBeUndefined();
    expect(await api.clipboard.read()).toBe(""); // still "" — the stub never remembers a write
  });

  test("read/write delegate to the real Clipboard when supplied", async () => {
    const deps = await buildBaseDeps();
    const clipboard = createClipboard();
    const api = createTecodeApi({ ...deps, clipboard });

    await api.clipboard.write("copied via tecode.clipboard");
    expect(await api.clipboard.read()).toBe("copied via tecode.clipboard");
    // Reading straight off the real service proves this is genuine
    // delegation, not two independent buffers that happen to agree.
    expect(await clipboard.read()).toBe("copied via tecode.clipboard");
  });

  test("tecode.clipboard is frozen — assigning to it is a no-op (or throws in strict mode), never mutates behavior", async () => {
    const deps = await buildBaseDeps();
    const api = createTecodeApi(deps);
    expect(Object.isFrozen(api.clipboard)).toBe(true);
  });
});
