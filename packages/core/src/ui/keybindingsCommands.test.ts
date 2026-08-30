/**
 * Tests for `ui/keybindingsCommands.ts` (Task 4.3, Req 11.7): the
 * create-vs-open behavior of `keybindings.internal.ensureFile`, the
 * table-flattening/source-layer attribution of `keybindings.internal.
 * resolveTable`, and that {@link KEYBINDINGS_TEMPLATE} genuinely parses
 * through the repo's own `parseJsonc`.
 */

import { describe, expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { parseJsonc } from "../config/jsonc";
import { createBindingTable, type KeymapLayers } from "../keymap/bindingTable";
import {
  createKeybindingsCommandsHandlers,
  KEYBINDINGS_TEMPLATE,
  type KeybindingsCommandsFs,
} from "./keybindingsCommands";

/** Matches `themeSettingsWriter.test.ts`'s `createFakeFs` shape/behavior
 * exactly (that module's TSDoc precedent this test suite follows) — an
 * in-memory filesystem keyed by path, `readFile` rejecting `ENOENT` for a
 * missing entry. */
function createFakeFs(initial: Record<string, string> = {}): {
  fs: KeybindingsCommandsFs;
  files: Record<string, string>;
} {
  const files = { ...initial };
  return {
    files,
    fs: {
      readFile: (path) => {
        const text = files[path];
        if (text === undefined) {
          return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        }
        return Promise.resolve(text);
      },
      mkdir: () => Promise.resolve(),
      // Models a REAL exclusive create (`wx`): rejects with `EEXIST`
      // rather than truncating, so a test cannot pass here while the
      // production code would clobber a concurrently-created file.
      writeFileExclusive: (path, data) => {
        if (files[path] !== undefined) {
          return Promise.reject(Object.assign(new Error("EEXIST"), { code: "EEXIST" }));
        }
        files[path] = data;
        return Promise.resolve();
      },
    },
  };
}

/** A full `KeymapLayers`, defaulting every layer to empty (matches
 * `bindingTable.test.ts`'s own `layersOf`). */
function layersOf(partial: Partial<KeymapLayers>): KeymapLayers {
  return {
    defaults: partial.defaults ?? [],
    fallback: partial.fallback ?? [],
    extension: partial.extension ?? [],
    user: partial.user ?? [],
  };
}

describe("KEYBINDINGS_TEMPLATE (Req 4.2, 4.3, 11.7)", () => {
  test("parses as valid JSONC through the repo's real parser, to an empty array", () => {
    const parsed = parseJsonc<unknown[]>(KEYBINDINGS_TEMPLATE);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual([]);
  });

  test("documents the { key, command, when? } entry shape and the -command removal syntax", () => {
    expect(KEYBINDINGS_TEMPLATE).toContain('"key"');
    expect(KEYBINDINGS_TEMPLATE).toContain('"command"');
    expect(KEYBINDINGS_TEMPLATE).toContain('"when"');
    expect(KEYBINDINGS_TEMPLATE).toContain("-editor.action.deleteLine");
  });

  test("contains no block comment marker at all — every line is a // comment", () => {
    expect(KEYBINDINGS_TEMPLATE).not.toContain("/*");
  });
});

describe("createKeybindingsCommandsHandlers — ensureFile (Req 4.2, 11.7)", () => {
  const getTable = () => createBindingTable(layersOf({}), { log: createHostLog() });

  test("creates the file from KEYBINDINGS_TEMPLATE when absent, and resolves to its Uri", async () => {
    const { fs, files } = createFakeFs();
    const handlers = createKeybindingsCommandsHandlers({
      path: "/home/user/.config/tecode/keybindings.json",
      fs,
      getTable,
    });

    const uri = await handlers.ensureFile();

    expect(uri).toBe("file:///home/user/.config/tecode/keybindings.json");
    expect(files["/home/user/.config/tecode/keybindings.json"]).toBe(KEYBINDINGS_TEMPLATE);
  });

  test("leaves an existing file untouched and still resolves to its Uri", async () => {
    const existing = `[\n  { "key": "ctrl+alt+z", "command": "demo.command" }\n]\n`;
    const { fs, files } = createFakeFs({
      "/home/user/.config/tecode/keybindings.json": existing,
    });
    const handlers = createKeybindingsCommandsHandlers({
      path: "/home/user/.config/tecode/keybindings.json",
      fs,
      getTable,
    });

    const uri = await handlers.ensureFile();

    expect(uri).toBe("file:///home/user/.config/tecode/keybindings.json");
    // Byte-for-byte unchanged — this command never rewrites an existing file.
    expect(files["/home/user/.config/tecode/keybindings.json"]).toBe(existing);
  });

  test("two overlapping calls only ever produce the template once (serialized write chain)", async () => {
    const { fs, files } = createFakeFs();
    const handlers = createKeybindingsCommandsHandlers({
      path: "/kb.json",
      fs,
      getTable,
    });

    const [first, second] = await Promise.all([handlers.ensureFile(), handlers.ensureFile()]);

    expect(first).toBe("file:///kb.json");
    expect(second).toBe("file:///kb.json");
    expect(files["/kb.json"]).toBe(KEYBINDINGS_TEMPLATE);
  });

  test("a competing process creating the file BETWEEN the existence check and the write keeps THEIR content", async () => {
    // The race the in-process write chain cannot close: a SECOND tecode
    // process (or the user's other editor) creating the file in the window
    // after this handler's existence check says "absent" and before its own
    // write lands. Modelled deterministically by planting the competing
    // content from inside `mkdir`, which production runs between exactly
    // those two steps — so the handler genuinely reaches its write with the
    // file now present, which is the only path where a non-exclusive write
    // would truncate a real user's keybindings.
    const { fs: base, files } = createFakeFs();
    const log = createHostLog();
    const theirContent = '[{ "key": "ctrl+q", "command": "app.quit" }]';

    const fs: KeybindingsCommandsFs = {
      readFile: base.readFile,
      mkdir: async (path) => {
        await base.mkdir(path);
        // The competing process wins the race, right here.
        if (files["/kb.json"] === undefined) files["/kb.json"] = theirContent;
      },
      writeFileExclusive: base.writeFileExclusive,
    };

    const handlers = createKeybindingsCommandsHandlers({ path: "/kb.json", fs, getTable, log });
    const uri = await handlers.ensureFile();

    expect(uri).toBe("file:///kb.json");
    // The whole point: their keybindings survive, the template does not
    // overwrite them.
    expect(files["/kb.json"]).toBe(theirContent);
    // Losing that race is normal operation, not a failure worth reporting.
    expect(log.entries()).toEqual([]);
  });

  test("a non-ENOENT read failure reports through log/sink and still resolves to the Uri", async () => {
    const fs: KeybindingsCommandsFs = {
      readFile: () => Promise.reject(new Error("disk on fire")),
      mkdir: () => Promise.resolve(),
      writeFileExclusive: () => Promise.resolve(),
    };
    const messages: string[] = [];
    const handlers = createKeybindingsCommandsHandlers({
      path: "/kb.json",
      fs,
      getTable,
      sink: { error: (e) => messages.push(e.message) },
    });

    await expect(handlers.ensureFile()).resolves.toBe("file:///kb.json");
    expect(messages).toHaveLength(1);
  });

  test("a write failure while creating the template reports through log/sink and still resolves to the Uri", async () => {
    const fs: KeybindingsCommandsFs = {
      readFile: () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      mkdir: () => Promise.resolve(),
      writeFileExclusive: () => Promise.reject(new Error("disk full")),
    };
    const messages: string[] = [];
    const handlers = createKeybindingsCommandsHandlers({
      path: "/kb.json",
      fs,
      getTable,
      sink: { error: (e) => messages.push(e.message) },
    });

    await expect(handlers.ensureFile()).resolves.toBe("file:///kb.json");
    expect(messages).toHaveLength(1);
  });
});

describe("createKeybindingsCommandsHandlers — resolveTable (Req 11.7)", () => {
  test("flattens every visible binding across all four layers, sorted by key, with source-layer attribution", async () => {
    const { fs } = createFakeFs();
    const table = createBindingTable(
      layersOf({
        defaults: [{ key: "ctrl+s", command: "editor.action.save" }],
        fallback: [{ key: "ctrl+shift+alt+p", command: "workbench.action.showCommands" }],
        extension: [
          { key: "ctrl+shift+r", command: "demo.run", extensionId: "demo.ext" },
        ],
        user: [{ key: "ctrl+alt+z", command: "user.command", when: "editorFocus" }],
      }),
      { log: createHostLog() },
    );
    const handlers = createKeybindingsCommandsHandlers({
      path: "/kb.json",
      fs,
      getTable: () => table,
    });

    const rows = await handlers.resolveTable();

    expect(rows).toEqual([
      { key: "ctrl+alt+z", command: "user.command", layer: "user", when: "editorFocus" },
      { key: "ctrl+s", command: "editor.action.save", layer: "defaults" },
      {
        key: "ctrl+shift+alt+p",
        command: "workbench.action.showCommands",
        layer: "fallback",
      },
      {
        key: "ctrl+shift+r",
        command: "demo.run",
        layer: "extension",
        extensionId: "demo.ext",
      },
    ]);
  });

  test("reflects the CURRENT table on every call — a live getter, not a snapshot (Req 11.7's config-watch requirement)", async () => {
    const { fs } = createFakeFs();
    let table = createBindingTable(layersOf({}), { log: createHostLog() });
    const handlers = createKeybindingsCommandsHandlers({
      path: "/kb.json",
      fs,
      getTable: () => table,
    });

    expect(await handlers.resolveTable()).toEqual([]);

    // Simulate the exact effect `main.ts`'s `onKeybindingsChange: (entries)
    // => keymap.setUserEntries(entries)` has: `keymap.getTable()` swaps to
    // a brand-new `BindingTable` reflecting the newly-loaded
    // `keybindings.json` — see `keybindingsCommandsWiring.test.ts` (this
    // repo's `packages/cli`) for the same proof against the REAL
    // `KeymapState`/`registerKeybindingsCommands` wiring end to end.
    table = createBindingTable(
      layersOf({ user: [{ key: "ctrl+alt+n", command: "user.newBinding" }] }),
      { log: createHostLog() },
    );

    expect(await handlers.resolveTable()).toEqual([
      { key: "ctrl+alt+n", command: "user.newBinding", layer: "user" },
    ]);
  });

  test("an empty table resolves to an empty array", async () => {
    const { fs } = createFakeFs();
    const handlers = createKeybindingsCommandsHandlers({
      path: "/kb.json",
      fs,
      getTable: () => createBindingTable(layersOf({}), { log: createHostLog() }),
    });

    expect(await handlers.resolveTable()).toEqual([]);
  });
});
