/**
 * `createFindFileService` tests (Issue #164, `findFileService.ts`'s TSDoc):
 * open/close seeding and guarded toggles, the Emacs-style Tab completion
 * ladder (single candidate / common prefix / candidate list), the
 * hidden-files-included policy, accept's delegation to
 * `workbench.action.files.openUri`, the directory/no-op accept case, and
 * the generation counter that drops a superseded `readdir`.
 *
 * Hand-rolled fakes throughout (this codebase's house convention — no mock
 * library): a fake `editorSession` over a REAL `CoreDocument`, a fake
 * `fs.readdir` backed by an in-memory directory map, and a recording
 * `executeCommand`.
 */

import { describe, expect, test } from "bun:test";
import type { DirEntry, Uri } from "@tecode/api";
import { createDocument, type CoreDocument } from "../buffer/document";
import { pathToUri, uriToPath } from "../buffer/uri";
import { createHostLog } from "../host/errors";
import { createFindFileService, FIND_FILE_MAX_CANDIDATES } from "./findFileService";

const HOME = "/home/tester";
const ROOT = "/work/project";

function createTestDocument(uri: string): CoreDocument {
  return createDocument({
    uri,
    languageId: "plaintext",
    text: "",
    sink: { error() {} },
    log: createHostLog(),
  });
}

/** A `readdir` over an in-memory `path -> entries` map; an unknown path
 * rejects, exactly like the real `FileSystem.readdir` does for a directory
 * that does not exist. */
function createFakeFs(directories: Record<string, DirEntry[]>) {
  const calls: string[] = [];
  return {
    calls,
    async readdir(uri: Uri): Promise<DirEntry[]> {
      const path = uriToPath(uri);
      calls.push(path);
      const entries = directories[path];
      if (!entries) throw new Error(`ENOENT: ${path}`);
      return entries;
    },
  };
}

function file(name: string): DirEntry {
  return { name, type: "file" };
}

function directory(name: string): DirEntry {
  return { name, type: "directory" };
}

interface HarnessOptions {
  activeDocumentUri?: string;
  directories?: Record<string, DirEntry[]>;
}

function createHarness(options: HarnessOptions = {}) {
  const activeDocument = options.activeDocumentUri
    ? createTestDocument(options.activeDocumentUri)
    : undefined;
  const fs = createFakeFs(options.directories ?? {});
  const executed: { id: string; args: unknown[] }[] = [];
  const service = createFindFileService({
    editorSession: { getActiveDocument: () => activeDocument },
    rootUri: pathToUri(ROOT),
    fs,
    homeDir: HOME,
    executeCommand: async (id, ...args) => {
      executed.push({ id, args });
      return undefined;
    },
  });
  return { service, fs, executed };
}

describe("createFindFileService — open/close (Issue #164)", () => {
  test("starts closed and empty", () => {
    const { service } = createHarness();
    expect(service.getState()).toEqual({
      isOpen: false,
      query: "",
      dirPath: "",
      candidates: [],
      truncatedCount: 0,
    });
  });

  test("open seeds the ACTIVE DOCUMENT's directory with a trailing separator", () => {
    const { service } = createHarness({ activeDocumentUri: pathToUri(`${ROOT}/src/index.ts`) });
    service.open();
    expect(service.getState().isOpen).toBe(true);
    expect(service.getState().query).toBe(`${ROOT}/src/`);
    expect(service.getState().dirPath).toBe(`${ROOT}/src`);
  });

  test("open falls back to the workspace root when no document is active", () => {
    const { service } = createHarness();
    service.open();
    expect(service.getState().query).toBe(`${ROOT}/`);
  });

  test("open is a guarded toggle — a second call does not reset a typed query", () => {
    const { service } = createHarness();
    service.open();
    service.setQuery(`${ROOT}/typed.md`);
    service.open();
    expect(service.getState().query).toBe(`${ROOT}/typed.md`);
  });

  test("close forgets the typed path; a second close is a no-op", () => {
    const { service } = createHarness();
    let changes = 0;
    service.onDidChange(() => (changes += 1));
    service.open();
    service.close();
    const afterFirstClose = changes;
    service.close();
    expect(changes).toBe(afterFirstClose);
    expect(service.getState().isOpen).toBe(false);
    expect(service.getState().query).toBe("");
  });

  test("setQuery is ignored while closed", () => {
    const { service } = createHarness();
    service.setQuery("ignored");
    expect(service.getState().query).toBe("");
  });

  test("setQuery recomputes the displayed directory, ~ expanded", () => {
    const { service } = createHarness();
    service.open();
    service.setQuery("~/notes/todo.md");
    expect(service.getState().dirPath).toBe(`${HOME}/notes`);
  });

  test("onDidChange fires on every state change and stops after dispose", () => {
    const { service } = createHarness();
    let changes = 0;
    const sub = service.onDidChange(() => (changes += 1));
    service.open();
    expect(changes).toBe(1);
    sub.dispose();
    service.setQuery("x");
    expect(changes).toBe(1);
  });
});

describe("createFindFileService — accept (Issue #164)", () => {
  test("resolves the typed path and executes workbench.action.files.openUri, then closes", () => {
    const { service, executed } = createHarness();
    service.open();
    service.setQuery(`${ROOT}/src/brand-new.ts`);
    expect(service.accept()).toBe(true);
    expect(executed).toEqual([
      { id: "workbench.action.files.openUri", args: [pathToUri(`${ROOT}/src/brand-new.ts`)] },
    ]);
    expect(service.getState().isOpen).toBe(false);
  });

  test("a relative path resolves against the active document's directory", () => {
    const { service, executed } = createHarness({
      activeDocumentUri: pathToUri(`${ROOT}/src/index.ts`),
    });
    service.open();
    service.setQuery("sibling.ts");
    expect(service.accept()).toBe(true);
    expect(executed[0]?.args[0]).toBe(pathToUri(`${ROOT}/src/sibling.ts`));
  });

  test("~ is expanded on accept", () => {
    const { service, executed } = createHarness();
    service.open();
    service.setQuery("~/notes.md");
    service.accept();
    expect(executed[0]?.args[0]).toBe(pathToUri(`${HOME}/notes.md`));
  });

  test("a query naming a DIRECTORY is a no-op that leaves the widget open", () => {
    const { service, executed } = createHarness();
    service.open();
    expect(service.getState().query.endsWith("/")).toBe(true);
    expect(service.accept()).toBe(false);
    expect(executed).toEqual([]);
    expect(service.getState().isOpen).toBe(true);
  });

  test("accept while closed is a no-op", () => {
    const { service, executed } = createHarness();
    expect(service.accept()).toBe(false);
    expect(executed).toEqual([]);
  });
});

describe("createFindFileService — Tab completion (Issue #164)", () => {
  test("a single candidate completes outright", async () => {
    const { service } = createHarness({
      directories: { [`${ROOT}/src`]: [file("index.ts"), file("other.md")] },
    });
    service.open();
    service.setQuery(`${ROOT}/src/ind`);
    await service.complete();
    expect(service.getState().query).toBe(`${ROOT}/src/index.ts`);
    expect(service.getState().candidates).toEqual([]);
  });

  test("a single DIRECTORY candidate completes with a trailing separator so the next Tab lists it", async () => {
    const { service } = createHarness({
      directories: { [ROOT]: [directory("packages"), file("README.md")] },
    });
    service.open();
    service.setQuery(`${ROOT}/pack`);
    await service.complete();
    expect(service.getState().query).toBe(`${ROOT}/packages/`);
  });

  test("several candidates extend the query to their common prefix, with no list shown", async () => {
    const { service } = createHarness({
      directories: { [ROOT]: [file("core.ts"), file("corex.ts"), file("api.ts")] },
    });
    service.open();
    service.setQuery(`${ROOT}/co`);
    await service.complete();
    expect(service.getState().query).toBe(`${ROOT}/core`);
    expect(service.getState().candidates).toEqual([]);
  });

  test("a query that cannot be extended shows the candidate list instead", async () => {
    const { service } = createHarness({
      // The shared prefix IS the typed text, so there is nothing left to
      // insert — exactly Emacs' "show the choices" case.
      directories: { [ROOT]: [file("core"), file("core.ts")] },
    });
    service.open();
    service.setQuery(`${ROOT}/core`);
    await service.complete();
    expect(service.getState().query).toBe(`${ROOT}/core`);
    expect(service.getState().candidates).toEqual(["core", "core.ts"]);
  });

  test("Tab on a directory (empty partial) lists everything in it, hidden files included", async () => {
    const { service } = createHarness({
      directories: { [ROOT]: [file("README.md"), file(".gitignore"), directory(".git")] },
    });
    service.open();
    await service.complete();
    expect(service.getState().candidates).toEqual([".git/", ".gitignore", "README.md"]);
    expect(service.getState().query).toBe(`${ROOT}/`);
  });

  test("~ is expanded before listing", async () => {
    const { service, fs } = createHarness({ directories: { [HOME]: [file("notes.md")] } });
    service.open();
    service.setQuery("~/");
    await service.complete();
    expect(fs.calls).toEqual([HOME]);
    expect(service.getState().query).toBe("~/notes.md");
  });

  test("a readdir failure means 'no candidates', never an error", async () => {
    const { service } = createHarness({ directories: {} });
    service.open();
    service.setQuery(`${ROOT}/missing-dir/fo`);
    await service.complete();
    expect(service.getState().query).toBe(`${ROOT}/missing-dir/fo`);
    expect(service.getState().candidates).toEqual([]);
  });

  test("no matching entry leaves the query untouched", async () => {
    const { service } = createHarness({ directories: { [ROOT]: [file("README.md")] } });
    service.open();
    service.setQuery(`${ROOT}/zzz`);
    await service.complete();
    expect(service.getState().query).toBe(`${ROOT}/zzz`);
    expect(service.getState().candidates).toEqual([]);
  });

  test("complete while closed is a no-op that never touches the filesystem", async () => {
    const { service, fs } = createHarness({ directories: { [ROOT]: [file("README.md")] } });
    await service.complete();
    expect(fs.calls).toEqual([]);
  });

  test("a candidate list longer than the cap is truncated and reports the remainder", async () => {
    const entries = Array.from({ length: FIND_FILE_MAX_CANDIDATES + 7 }, (_unused, index) =>
      file(`f${String(index).padStart(4, "0")}.ts`),
    );
    const { service } = createHarness({ directories: { [ROOT]: entries } });
    service.open();
    await service.complete();
    expect(service.getState().candidates.length).toBe(FIND_FILE_MAX_CANDIDATES);
    expect(service.getState().truncatedCount).toBe(7);
  });

  test("a superseded completion is discarded — the newest query wins", async () => {
    const { service } = createHarness({
      directories: {
        [`${ROOT}/a`]: [file("alpha.ts")],
        [`${ROOT}/b`]: [file("beta.ts")],
      },
    });
    service.open();
    service.setQuery(`${ROOT}/a/al`);
    const stale = service.complete();
    service.setQuery(`${ROOT}/b/be`);
    const fresh = service.complete();
    await Promise.all([stale, fresh]);
    expect(service.getState().query).toBe(`${ROOT}/b/beta.ts`);
  });

  test("a completion that lands after close writes nothing", async () => {
    const { service } = createHarness({ directories: { [ROOT]: [file("README.md")] } });
    service.open();
    const pending = service.complete();
    service.close();
    await pending;
    expect(service.getState().isOpen).toBe(false);
    expect(service.getState().query).toBe("");
  });
});
