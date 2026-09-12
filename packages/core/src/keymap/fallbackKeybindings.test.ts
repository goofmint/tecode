import { expect, test } from "bun:test";
import { createHostLog } from "../host/errors";
import { getUserFallbackKeybindingsPath } from "../host/paths";
import {
  BUNDLED_FALLBACK_KEYBINDINGS,
  loadFallbackKeybindings,
  type FallbackKeybindingsFs,
} from "./fallbackKeybindings";

/** An in-memory {@link FallbackKeybindingsFs}: `readFile` serves whatever
 * `content` maps to, or throws `ENOENT` when unset — mirrors `config/
 * service.test.ts`'s `createFakeFs`, minus the `watch` half this seam
 * doesn't have (`fallbackKeybindings.ts`'s "Not live-reloaded" TSDoc). */
function createFakeFs(content?: string): FallbackKeybindingsFs {
  return {
    readFile(path) {
      if (content === undefined) {
        return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" }));
      }
      return Promise.resolve(content);
    },
  };
}

test("the bundled asset covers exactly the genuinely-ambiguous defaults plus the sidebar-visibility toggle (Fact 4's reasoning, keybindings.fallback.json)", () => {
  const commands = BUNDLED_FALLBACK_KEYBINDINGS.map((entry) => entry.command).sort();
  expect(commands).toEqual(
    [
      "editor.action.deleteLine",
      "explorer.focus",
      "workbench.action.showCommands",
      // Issue #135: `workbench.action.toggleSidebarVisibility` has no
      // Kitty-ambiguity hazard of its own — its fallback entry (`ctrl+b`)
      // rides in this same bundled file for the same reason `ctrl+e` ->
      // `explorer.focus` does (that entry's own precedent, `Fact 4`'s
      // remedy 2 in this module's own TSDoc): a plain, unclaimed key bound
      // directly, not a hazard-driven remap.
      "workbench.action.toggleSidebarVisibility",
      // Issue #150: `editor.action.fold`/`unfold`'s default bindings
      // (`ctrl+shift+[`/`ctrl+shift+]`) only ever materialize as strokes on
      // a Kitty-capable terminal — `editor-core/manifest.ts`'s "Folding
      // keybindings (Issue #150)" section documents the `parseKeypress`
      // runs behind that — so every other terminal reaches folding through
      // these two entries (`ctrl+r`/`ctrl+t`) instead. Hazard-driven
      // remaps, like `deleteLine`/`showCommands` above.
      "editor.action.fold",
      "editor.action.unfold",
    ].sort(),
  );
});

test("no user override file (ENOENT) falls back to the bundled asset", async () => {
  const log = createHostLog();
  const entries = await loadFallbackKeybindings({ log, fs: createFakeFs(undefined) });
  expect(entries).toEqual(BUNDLED_FALLBACK_KEYBINDINGS);
  expect(log.entries()).toEqual([]);
});

test("a valid user override file entirely REPLACES the bundled asset (not merged)", async () => {
  const log = createHostLog();
  const userEntries = [{ key: "ctrl+alt+p", command: "workbench.action.showCommands" }];
  const entries = await loadFallbackKeybindings({
    log,
    fs: createFakeFs(JSON.stringify(userEntries)),
  });
  expect(entries).toEqual(userEntries);
  expect(entries).not.toEqual(BUNDLED_FALLBACK_KEYBINDINGS);
});

test("a user override file may use JSONC comments/trailing commas (parseJsonc, matching keybindings.json)", async () => {
  const log = createHostLog();
  const text = `[
    // a comment
    { "key": "ctrl+alt+p", "command": "workbench.action.showCommands" },
  ]`;
  const entries = await loadFallbackKeybindings({ log, fs: createFakeFs(text) });
  expect(entries).toEqual([{ key: "ctrl+alt+p", command: "workbench.action.showCommands" }]);
});

test("a read failure that is NOT ENOENT is logged and degrades to [] (not the bundled asset)", async () => {
  const log = createHostLog();
  const fs: FallbackKeybindingsFs = {
    readFile: () => Promise.reject(new Error("EACCES: permission denied")),
  };
  const entries = await loadFallbackKeybindings({ log, fs });
  expect(entries).toEqual([]);
  expect(log.entries()).toHaveLength(1);
  expect(log.entries()[0]?.level).toBe("error");
  expect(log.entries()[0]?.error.path).toBe(getUserFallbackKeybindingsPath());
});

test("malformed JSON is logged and degrades to [] (never throws)", async () => {
  const log = createHostLog();
  const entries = await loadFallbackKeybindings({ log, fs: createFakeFs("{ not json") });
  expect(entries).toEqual([]);
  expect(log.entries()).toHaveLength(1);
  expect(log.entries()[0]?.error.message).toContain("line");
});

test("a non-array top-level value is logged and degrades to []", async () => {
  const log = createHostLog();
  const entries = await loadFallbackKeybindings({
    log,
    fs: createFakeFs(JSON.stringify({ not: "an array" })),
  });
  expect(entries).toEqual([]);
  expect(log.entries()).toHaveLength(1);
  expect(log.entries()[0]?.error.message).toContain("must be a JSON array");
});

test("an empty-array user override file is honored as-is (user deliberately wants no fallback bindings)", async () => {
  const log = createHostLog();
  const entries = await loadFallbackKeybindings({ log, fs: createFakeFs("[]") });
  expect(entries).toEqual([]);
  expect(log.entries()).toEqual([]);
});

test("defaults to the real node:fs/promises seam when none is injected (production shape)", async () => {
  const log = createHostLog();
  // No `fs` override: exercises `createNodeFallbackKeybindingsFs` against
  // whatever this test process's real ~/.config/tecode looks like — since
  // that almost certainly has no keybindings.fallback.json, this should
  // resolve to the bundled asset without throwing, proving the default
  // seam wiring itself (not just the injected-fake path every other test
  // here exercises) is correct.
  await expect(loadFallbackKeybindings({ log })).resolves.toBeInstanceOf(Array);
});
