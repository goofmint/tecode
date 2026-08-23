/**
 * Tests for `createTecodeApi`'s real `tecode.languages` wiring (Task 2.8,
 * Req 8.1-8.3): `register`/`getLanguage`/`getLanguageId` delegate to an
 * injected `LanguageRegistry` when supplied, and fall back to `stubs.ts`'s
 * `createLanguagesStub` exactly as before otherwise
 * (`CreateTecodeApiDeps.languageRegistry`'s TSDoc).
 */

import { describe, expect, test } from "bun:test";
import type { LanguageContribution } from "@tecode/api";
import { createCommandRegistry } from "../commands/registry";
import { createDocumentManager } from "../buffer/documentManager";
import { createFileSystem } from "../buffer/fileSystem";
import type { ConfigServiceFs } from "../config/service";
import { createConfigService } from "../config/service";
import { createContextService } from "../keymap/context";
import { createHostLog } from "../host/errors";
import { createLanguageRegistry, PLAINTEXT_LANGUAGE_ID } from "../languages/languageRegistry";
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

const ts: LanguageContribution = { id: "typescript", extensions: [".ts"], grammar: "ts.wasm", highlights: "ts.scm" };

describe("createTecodeApi's tecode.languages (Task 2.8)", () => {
  test("falls back to the stub when no languageRegistry is supplied", async () => {
    const deps = await buildBaseDeps();
    const api = createTecodeApi(deps);
    expect(api.languages.getLanguageId("file:///a.ts")).toBe(PLAINTEXT_LANGUAGE_ID);
    expect(api.languages.getLanguage("typescript")).toBeUndefined();
  });

  test("register/getLanguage/getLanguageId all delegate to the real LanguageRegistry when supplied", async () => {
    const deps = await buildBaseDeps();
    const languageRegistry = createLanguageRegistry();
    const api = createTecodeApi({ ...deps, languageRegistry });

    const disposable = api.languages.register(ts);
    expect(api.languages.getLanguage("typescript")).toEqual(ts);
    expect(api.languages.getLanguageId("file:///a.ts")).toBe("typescript");
    expect(api.languages.getLanguageId("file:///a.rs")).toBe(PLAINTEXT_LANGUAGE_ID);

    // register/dispose symmetry (design.md §16's contract-test shape).
    disposable.dispose();
    expect(api.languages.getLanguage("typescript")).toBeUndefined();
    expect(api.languages.getLanguageId("file:///a.ts")).toBe(PLAINTEXT_LANGUAGE_ID);
  });

  test("a runtime tecode.languages.register call is visible to the SAME registry's resolveLanguageId (host + extension share state)", async () => {
    const deps = await buildBaseDeps();
    const languageRegistry = createLanguageRegistry();
    // Pre-register through the registry directly (simulating a manifest
    // `contributes.languages` entry, Task 2.8's `loadContributions`).
    languageRegistry.register({ id: "json", extensions: [".json"], grammar: "json.wasm", highlights: "json.scm" });

    const api = createTecodeApi({ ...deps, languageRegistry });
    expect(api.languages.getLanguageId("file:///a.json")).toBe("json");

    // A runtime `tecode.languages.register` call is visible immediately too.
    api.languages.register(ts);
    expect(api.languages.getLanguageId("file:///a.ts")).toBe("typescript");
  });
});
