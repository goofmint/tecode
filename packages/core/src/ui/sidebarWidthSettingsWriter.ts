/**
 * `SidebarWidthSettingsWriter` (Issue #105; Req 6.4, 9.5, design.md §8.2,
 * §11): persists a sidebar-resize COMMIT (a border-drag end, or a
 * `workbench.action.increase/decreaseSidebarWidth` command) by writing
 * `"workbench.sidebarWidth"` into the user's `settings.json`
 * (`host/paths.ts`'s `getUserSettingsPath()`) — `ConfigService`'s existing
 * `fs.watch` on that same file then picks the change up and re-loads it,
 * exactly like `themeSettingsWriter.ts`'s `write` does for
 * `"workbench.colorTheme"`.
 *
 * **Debounced, unlike `themeSettingsWriter.ts`'s immediate write** — that
 * module's own TSDoc calls this out by name: "this module writes
 * immediately on every call rather than debouncing — a `theme.select`
 * commit is a deliberate, infrequent user action, **not a layout drag**".
 * This IS a layout drag's write-back. Every `write()` call still only ever
 * fires from a genuine commit (`sidebarWidthCommands.ts`'s two commands,
 * `shell.tsx`'s `Shell`'s `onSidebarWidthCommit` on drag-end — NEVER from
 * an in-progress `onWidthDrag` tick, `shell.tsx`'s `Sidebar`/`Shell` TSDoc),
 * but a user can still commit in a fast burst (mashing the increase/decrease
 * keybinding, or a drag that ends and immediately starts again) — debouncing
 * (matching `layoutState.ts`'s own injectable-timer, serialized-write-chain
 * shape) collapses such a burst into one disk write of the latest value
 * instead of thrashing `settings.json` and fighting `ConfigService`'s own
 * `fs.watch` on it (this task's own load-bearing constraint).
 *
 * **Text-replace, not re-serialize** (mirrors `themeSettingsWriter.ts`'s
 * `applyColorThemeSetting` exactly, just for a numeric value instead of a
 * string): `settings.json` is JSONC, and a naive parse/mutate/
 * `JSON.stringify` round-trip would destroy the user's own comments and
 * formatting. This module finds `"workbench.sidebarWidth"` with a targeted
 * regex against `stripComments`-sanitized text — so a commented-out
 * `// "workbench.sidebarWidth": 40,` is never mistaken for a live key
 * (`applySidebarWidthSetting`'s own TSDoc) — and replaces only its value
 * substring in place, at the SAME offsets in the original (unsanitized)
 * text, since `stripComments` never changes a string's length; if the key
 * is absent, it is appended just inside the object's opening `{`, exactly
 * like `applyColorThemeSetting`'s own fallback.
 */

import { readFile as nodeReadFile, writeFile as nodeWriteFile, mkdir as nodeMkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import { getUserSettingsPath } from "../host/paths";
import { stripComments } from "../config/jsonc";

/** The narrow filesystem seam {@link createSidebarWidthSettingsWriter}
 * needs — injectable (matches `themeSettingsWriter.ts`'s
 * `ThemeSettingsWriterFs`, `layoutState.ts`'s `LayoutStateFs`) so tests
 * never touch the real filesystem. */
export interface SidebarWidthSettingsWriterFs {
  readFile(path: string): Promise<string>;
  /** Create `path`'s parent directory if it does not exist (matches
   * `themeSettingsWriter.ts`'s/`layoutState.ts`'s identical need). */
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}

function createNodeSidebarWidthSettingsWriterFs(): SidebarWidthSettingsWriterFs {
  return {
    readFile: (path) => nodeReadFile(path, "utf8"),
    mkdir: (path) => nodeMkdir(path, { recursive: true }).then(() => undefined),
    writeFile: (path, data) => nodeWriteFile(path, data, "utf8"),
  };
}

/** The debounce/scheduling seam {@link createSidebarWidthSettingsWriter}
 * needs — matches `layoutState.ts`'s `LayoutStateTimer` exactly (defaults
 * to real `setTimeout`/`clearTimeout`; tests inject a manually-driven fake
 * so nothing here depends on real wall-clock timing). */
export interface SidebarWidthSettingsWriterTimer {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

function createRealTimer(): SidebarWidthSettingsWriterTimer {
  return {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** Dependencies for {@link createSidebarWidthSettingsWriter}. */
export interface SidebarWidthSettingsWriterDeps {
  /** Overrides `settings.json`'s path — tests use a temp file; production
   * defaults to {@link getUserSettingsPath}. */
  path?: string;
  /** Filesystem seam — see {@link SidebarWidthSettingsWriterFs}. Defaults
   * to `node:fs/promises`. */
  fs?: SidebarWidthSettingsWriterFs;
  /** Debounce/scheduling seam — see {@link SidebarWidthSettingsWriterTimer}.
   * Defaults to real timers. */
  timer?: SidebarWidthSettingsWriterTimer;
  /** Debounce window, in milliseconds, between the last `write()` call and
   * the disk write it schedules (this module's TSDoc). Defaults to 250 —
   * matching `layoutState.ts`'s own default. */
  debounceMs?: number;
  log?: HostLog;
  sink?: StatusSink;
}

/** The sidebar-width settings writer's public surface (Issue #105). */
export interface SidebarWidthSettingsWriter {
  /** Schedule a debounced write of `width` as `"workbench.sidebarWidth"`
   * (this module's TSDoc) — call ONLY from a commit (never from an
   * in-progress drag tick). Fire-and-forget, matching
   * `layoutState.ts`'s own `update()` shape: the write itself is reported
   * through `log`/`sink` on failure rather than rejecting a promise nobody
   * would await mid-drag anyway. */
  write(width: number): void;
  /** Cancel any pending debounce timer and write the latest value now.
   * Resolves once that write (and anything already chained ahead of it) has
   * settled — the shutdown path, matching `layoutState.ts`'s `flush()`.
   * Resolves immediately, without writing, if `write()` was never called. */
  flush(): Promise<void>;
}

/** Render a caught `unknown` value as a message string (matches every
 * other module's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Extract an errno-style `code` (matches `themeSettingsWriter.ts`'s/
 * `layoutState.ts`'s `errorCode`). */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

// Matches `"workbench.sidebarWidth"` followed by any single JSON scalar
// value — mirrors `themeSettingsWriter.ts`'s `COLOR_THEME_KEY_RE` exactly
// (a pre-existing non-numeric value, e.g. a hand-edited `null`, is still
// found and replaced rather than missed and duplicated).
const SIDEBAR_WIDTH_KEY_RE =
  /"workbench\.sidebarWidth"\s*:\s*(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/;

/**
 * Find the offset of the first `{` in `text` outside any comment/string
 * (identical logic to `themeSettingsWriter.ts`'s `findObjectOpenBrace` —
 * duplicated rather than imported since neither module depends on the
 * other and this is a handful of lines, matching this codebase's other
 * small-helper-duplication precedents, e.g. `describeError`/`errorCode`
 * above).
 */
function findObjectOpenBrace(text: string): number {
  const sanitized = stripComments(text);
  let inString = false;
  for (let i = 0; i < sanitized.length; i++) {
    const ch = sanitized[i]!;
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") return i;
  }
  return -1;
}

/**
 * Text-replace `"workbench.sidebarWidth"`'s value in `text` with `width`
 * (this module's TSDoc) — an exact-match replace if the key is already
 * present, or an insertion just inside the object's first `{` otherwise.
 * Exported for direct unit testing of the text-splicing logic, independent
 * of any filesystem I/O — mirrors `themeSettingsWriter.ts`'s
 * `applyColorThemeSetting`.
 */
export function applySidebarWidthSetting(text: string, width: number): string {
  // Match against COMMENT-STRIPPED text, not `text` itself — `stripComments`
  // blanks `//`/`/* */` spans to spaces without ever changing the string's
  // length (`config/jsonc.ts`'s own `stripComments`, verified by
  // construction: every branch either copies one input character to the
  // same output index or overwrites it with a same-length blank), so a
  // match's `index`/length found in the sanitized copy still names the
  // exact same offsets in the original `text`. Without this, a
  // commented-out `// "workbench.sidebarWidth": 40,` reads as a live key
  // and gets spliced into instead of appended as a real one (CodeRabbit
  // PR #111 review, Finding 5).
  const sanitized = stripComments(text);
  const encodedWidth = JSON.stringify(width);
  // Defensive: only splice at `sanitized`'s offsets if it is actually the
  // same length as `text` — true for every real `stripComments` output
  // (this function's own contract), but a length mismatch here would mean
  // splicing `text` at offsets that name the wrong characters, which is
  // worse than falling through to the append path below.
  if (sanitized.length === text.length) {
    const match = SIDEBAR_WIDTH_KEY_RE.exec(sanitized);
    if (match) {
      const start = match.index;
      const end = start + match[0].length;
      return `${text.slice(0, start)}"workbench.sidebarWidth": ${encodedWidth}${text.slice(end)}`;
    }
  }

  const openBrace = findObjectOpenBrace(text);
  if (openBrace === -1) {
    return `{\n  "workbench.sidebarWidth": ${encodedWidth}\n}\n`;
  }
  // The trailing comma is only correct when a property actually FOLLOWS
  // the inserted one. An empty object (`{}`, or `{}` with only whitespace/
  // comments inside — the shape a fresh install's `settings.json` has, or
  // no file at all) would otherwise become `{"workbench.sidebarWidth": 30,}`
  // — invalid JSON, written into the user's settings by their very first
  // resize. `parseJsonc` happens to tolerate it, so this stayed invisible
  // to every round trip through this codebase's own reader; anything
  // stricter (an editor, a linter, `JSON.parse`) does not.
  const rest = stripComments(text.slice(openBrace + 1));
  const objectIsEmpty = rest.trimStart().startsWith("}");
  const separator = objectIsEmpty ? "" : ",";
  return (
    text.slice(0, openBrace + 1) +
    `\n  "workbench.sidebarWidth": ${encodedWidth}${separator}` +
    text.slice(openBrace + 1)
  );
}

/** Build a sidebar-width settings writer (Issue #105). */
export function createSidebarWidthSettingsWriter(
  deps: SidebarWidthSettingsWriterDeps = {},
): SidebarWidthSettingsWriter {
  const { log, sink } = deps;
  const path = deps.path ?? getUserSettingsPath();
  const fs = deps.fs ?? createNodeSidebarWidthSettingsWriterFs();
  const timer = deps.timer ?? createRealTimer();
  const debounceMs = deps.debounceMs ?? 250;

  function logSafely(level: "error" | "warning", err: HostError): void {
    try {
      log?.append(level, err);
    } catch {
      // Swallowed: reporting a reporting failure has nowhere left to go.
    }
  }

  function notifySafely(err: HostError): void {
    try {
      sink?.error(err);
    } catch {
      // Swallowed — see logSafely.
    }
  }

  async function doWrite(width: number): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(path);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") {
        text = "{}\n";
      } else {
        const message = `Failed to read settings (${path}) while persisting workbench.sidebarWidth: ${describeError(cause)}`;
        logSafely("error", { message, path });
        notifySafely({ message, path });
        return;
      }
    }

    const next = applySidebarWidthSetting(text, width);
    try {
      await fs.mkdir(dirname(path));
      await fs.writeFile(path, next);
    } catch (cause) {
      const message = `Failed to write settings (${path}) while persisting workbench.sidebarWidth: ${describeError(cause)}`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
    }
  }

  // Debounced, serialized write chain (this module's TSDoc) — matches
  // `layoutState.ts`'s `pendingTimer`/`saveChain` shape exactly, just with
  // `width` as the value carried through instead of the whole
  // `LayoutState`.
  let pendingTimer: unknown;
  let pendingWidth: number | undefined;
  let writeChain: Promise<void> = Promise.resolve();

  function scheduleWrite(): void {
    writeChain = writeChain.then(
      () => doWrite(pendingWidth!),
      () => doWrite(pendingWidth!),
    );
  }

  function write(width: number): void {
    pendingWidth = width;
    if (pendingTimer !== undefined) {
      try {
        timer.cancel(pendingTimer);
      } catch {
        // Best-effort — a broken timer seam must not stop the new one from
        // being scheduled below.
      }
    }
    try {
      pendingTimer = timer.schedule(() => {
        pendingTimer = undefined;
        scheduleWrite();
      }, debounceMs);
    } catch (cause) {
      // A timer seam that throws on schedule() must not lose the write
      // permanently — write it directly instead of debouncing (matches
      // `layoutState.ts`'s identical fallback).
      pendingTimer = undefined;
      logSafely("warning", {
        message: `Sidebar width settings debounce timer failed, writing immediately: ${describeError(cause)}`,
      });
      scheduleWrite();
    }
  }

  async function flush(): Promise<void> {
    if (pendingTimer !== undefined) {
      try {
        timer.cancel(pendingTimer);
      } catch {
        // Best-effort.
      }
      pendingTimer = undefined;
      scheduleWrite();
    }
    await writeChain;
  }

  return { write, flush };
}
