/**
 * Test-only fixtures shared by this directory's UI suites (Qodana
 * `DuplicatedCode`): `shell.initialFocus.test.tsx`, `shell.snapshot.test.tsx`,
 * `components.snapshot.test.tsx` and `editorView.snapshot.test.tsx` each
 * carried byte-identical private copies of these, every copy's own TSDoc
 * saying so ("matches `shell.snapshot.test.tsx`'s own identical helper").
 *
 * A test-support module living in `src/` rather than inside a `.test.tsx`
 * follows `packages/cli/src/editingHarness.tsx`'s precedent — a `.test.tsx`
 * cannot be imported from another test file without Bun running its
 * `describe` blocks a second time, so the shared part has to live in a
 * plain module. Nothing in production code imports this, and it is
 * deliberately NOT re-exported from `ui/index.ts`.
 */

import { TabSelectRenderable, type CapturedFrame } from "@opentui/core";
import type { DocumentManagerFs } from "../buffer/documentManager";
import { createCommandRegistry } from "../commands/registry";
import { createHostLog } from "../host/errors";
import { createContextService } from "../keymap/context";
import { createLayoutStateService, type LayoutStateFs } from "./layoutState";
import { createSlotRegistry } from "./slotRegistry";

/** A `StatusSink` that discards everything — these suites assert on
 * rendered output and focus/context behavior, never on what gets logged. */
export function createRecordingSink() {
  return { error() {} };
}

/** An in-memory {@link LayoutStateFs} that starts with no `state.json`, so
 * every test gets `DEFAULT_LAYOUT_STATE` deterministically with no real
 * filesystem involved. */
export function createEmptyLayoutFs(): LayoutStateFs {
  return {
    async readFile() {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    async mkdir() {},
    async writeFile() {},
  };
}

/**
 * The `slotRegistry`/`layoutState`/`context`/`commands` set every `<Shell>`
 * test mounts against. `documents`/`editorSession`/`modalService` are each
 * test's own concern, built separately per scenario.
 *
 * `commands` is always built even though only some suites read it — an
 * unused command registry is inert, which is cheaper than two
 * near-identical harnesses.
 */
export function createShellHarness() {
  const log = createHostLog();
  const sink = createRecordingSink();
  const slotRegistry = createSlotRegistry({ log });
  const layoutState = createLayoutStateService({ log, sink, path: "/state.json", fs: createEmptyLayoutFs() });
  const context = createContextService();
  const commands = createCommandRegistry({ log, sink });
  return { slotRegistry, layoutState, context, commands };
}

/**
 * An in-memory {@link DocumentManagerFs} — every named file's content is
 * fixed at construction, and every other operation (`save`'s write/rename,
 * `stat`'s mode) is a harmless no-op/stub. These suites only ever open
 * documents, never save them.
 */
export function createInMemoryFs(files: Record<string, string>): DocumentManagerFs {
  return {
    async stat(path: string) {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { size: files[path]!.length, mode: 0o644, mtimeMs: 0 };
    },
    async readFile(path: string) {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path]!;
    },
    async readFileBytes(path: string) {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return new TextEncoder().encode(files[path]!);
    },
    async writeFile() {},
    async chmod() {},
    async rename() {},
    async unlink() {},
  };
}

/** Depth-first search for the rendered `<tab-select>` renderable. */
export function findTabSelect(node: unknown): TabSelectRenderable | undefined {
  if (node instanceof TabSelectRenderable) return node;
  const candidate = node as { getChildren?: () => unknown[] };
  for (const child of candidate?.getChildren?.() ?? []) {
    const found = findTabSelect(child);
    if (found) return found;
  }
  return undefined;
}

/** Flatten a captured frame into one entry per span, carrying the span's
 * absolute row/column so a test can assert on "what is painted where"
 * without walking the line/span nesting itself. */
export function flattenSpans(
  frame: CapturedFrame,
): Array<{ row: number; col: number; text: string; fg: unknown; bg: unknown }> {
  const out: Array<{ row: number; col: number; text: string; fg: unknown; bg: unknown }> = [];
  frame.lines.forEach((line, row) => {
    let col = 0;
    for (const span of line.spans) {
      out.push({ row, col, text: span.text, fg: span.fg, bg: span.bg });
      col += span.width;
    }
  });
  return out;
}
