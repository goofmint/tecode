/**
 * `PanelHeightSettingsWriter` (Issue #146): persists a panel-resize COMMIT
 * (a `workbench.action.increase/decreasePanelHeight` command) by writing
 * `"workbench.panelHeight"` into the user's `settings.json` (`host/paths.
 * ts`'s `getUserSettingsPath()`) — `ConfigService`'s existing `fs.watch` on
 * that same file then picks the change up and re-loads it, exactly like
 * `sidebarWidthSettingsWriter.ts`'s `write` does for
 * `"workbench.sidebarWidth"`. Mirrors that module almost exactly, just
 * `panelHeight` standing in for `sidebarWidth`.
 *
 * **Debounced, unlike `themeSettingsWriter.ts`'s immediate write** — the
 * same reasoning `sidebarWidthSettingsWriter.ts`'s TSDoc gives: every
 * `write()` call here only ever fires from a genuine commit
 * (`panelHeightCommands.ts`'s two commands), but a user can still commit in
 * a fast burst (mashing the increase/decrease keybinding) — debouncing
 * (matching `layoutState.ts`'s own injectable-timer, serialized-write-chain
 * shape) collapses such a burst into one disk write of the latest value
 * instead of thrashing `settings.json` and fighting `ConfigService`'s own
 * `fs.watch` on it.
 *
 * **Text-replace, not re-serialize** (mirrors
 * `sidebarWidthSettingsWriter.ts`'s `applySidebarWidthSetting` exactly,
 * just for `"workbench.panelHeight"` instead of `"workbench.sidebarWidth"`):
 * `settings.json` is JSONC, and a naive parse/mutate/`JSON.stringify`
 * round-trip would destroy the user's own comments and formatting. This
 * module finds `"workbench.panelHeight"` with a targeted regex against
 * `stripComments`-sanitized text — so a commented-out
 * `// "workbench.panelHeight": 10,` is never mistaken for a live key
 * (`applyPanelHeightSetting`'s own TSDoc) — and replaces only its value
 * substring in place, at the SAME offsets in the original (unsanitized)
 * text, since `stripComments` never changes a string's length; if the key
 * is absent, it is appended just inside the object's opening `{`, exactly
 * like `applySidebarWidthSetting`'s own fallback.
 */

import { readFile as nodeReadFile, writeFile as nodeWriteFile, mkdir as nodeMkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import { getUserSettingsPath } from "../host/paths";
import { stripComments } from "../config/jsonc";

/** The narrow filesystem seam {@link createPanelHeightSettingsWriter}
 * needs — injectable (matches `sidebarWidthSettingsWriter.ts`'s
 * `SidebarWidthSettingsWriterFs`) so tests never touch the real
 * filesystem. */
export interface PanelHeightSettingsWriterFs {
  readFile(path: string): Promise<string>;
  /** Create `path`'s parent directory if it does not exist (matches
   * `sidebarWidthSettingsWriter.ts`'s identical need). */
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}

function createNodePanelHeightSettingsWriterFs(): PanelHeightSettingsWriterFs {
  return {
    readFile: (path) => nodeReadFile(path, "utf8"),
    mkdir: (path) => nodeMkdir(path, { recursive: true }).then(() => undefined),
    writeFile: (path, data) => nodeWriteFile(path, data, "utf8"),
  };
}

/** The debounce/scheduling seam {@link createPanelHeightSettingsWriter}
 * needs — matches `sidebarWidthSettingsWriter.ts`'s
 * `SidebarWidthSettingsWriterTimer` exactly (defaults to real
 * `setTimeout`/`clearTimeout`; tests inject a manually-driven fake so
 * nothing here depends on real wall-clock timing). */
export interface PanelHeightSettingsWriterTimer {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

function createRealTimer(): PanelHeightSettingsWriterTimer {
  return {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** Dependencies for {@link createPanelHeightSettingsWriter}. */
export interface PanelHeightSettingsWriterDeps {
  /** Overrides `settings.json`'s path — tests use a temp file; production
   * defaults to {@link getUserSettingsPath}. */
  path?: string;
  /** Filesystem seam — see {@link PanelHeightSettingsWriterFs}. Defaults to
   * `node:fs/promises`. */
  fs?: PanelHeightSettingsWriterFs;
  /** Debounce/scheduling seam — see {@link PanelHeightSettingsWriterTimer}.
   * Defaults to real timers. */
  timer?: PanelHeightSettingsWriterTimer;
  /** Debounce window, in milliseconds, between the last `write()` call and
   * the disk write it schedules (this module's TSDoc). Defaults to 250 —
   * matching `sidebarWidthSettingsWriter.ts`'s own default. */
  debounceMs?: number;
  log?: HostLog;
  sink?: StatusSink;
}

/** The panel-height settings writer's public surface (Issue #146). */
export interface PanelHeightSettingsWriter {
  /** Schedule a debounced write of `height` as `"workbench.panelHeight"`
   * (this module's TSDoc) — call ONLY from a commit. Fire-and-forget,
   * matching `layoutState.ts`'s own `update()` shape: the write itself is
   * reported through `log`/`sink` on failure rather than rejecting a
   * promise nobody would await mid-keypress-burst anyway. */
  write(height: number): void;
  /** Cancel any pending debounce timer and write the latest value now.
   * Resolves once that write (and anything already chained ahead of it) has
   * settled — the shutdown path, matching `sidebarWidthSettingsWriter.ts`'s
   * `flush()`. Resolves immediately, without writing, if `write()` was
   * never called. */
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

/** Extract an errno-style `code` (matches `sidebarWidthSettingsWriter.ts`'s
 * `errorCode`). */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

// Matches `"workbench.panelHeight"` followed by any single JSON scalar
// value — mirrors `sidebarWidthSettingsWriter.ts`'s `SIDEBAR_WIDTH_KEY_RE`
// exactly (a pre-existing non-numeric value, e.g. a hand-edited `null`, is
// still found and replaced rather than missed and duplicated).
const PANEL_HEIGHT_KEY_RE =
  /"workbench\.panelHeight"\s*:\s*(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null)/;

/**
 * Find the offset of the first `{` in `text` outside any comment/string
 * (identical logic to `sidebarWidthSettingsWriter.ts`'s
 * `findObjectOpenBrace` — duplicated rather than imported since neither
 * module depends on the other and this is a handful of lines, matching
 * this codebase's other small-helper-duplication precedents, e.g.
 * `describeError`/`errorCode` above).
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
 * Text-replace `"workbench.panelHeight"`'s value in `text` with `height`
 * (this module's TSDoc) — an exact-match replace if the key is already
 * present, or an insertion just inside the object's first `{` otherwise.
 * Exported for direct unit testing of the text-splicing logic, independent
 * of any filesystem I/O — mirrors `sidebarWidthSettingsWriter.ts`'s
 * `applySidebarWidthSetting`.
 */
export function applyPanelHeightSetting(text: string, height: number): string {
  // Match against COMMENT-STRIPPED text, not `text` itself — `stripComments`
  // blanks `//`/`/* */` spans to spaces without ever changing the string's
  // length (`config/jsonc.ts`'s own `stripComments`), so a match's
  // `index`/length found in the sanitized copy still names the exact same
  // offsets in the original `text`. Without this, a commented-out
  // `// "workbench.panelHeight": 10,` reads as a live key and gets spliced
  // into instead of appended as a real one (mirrors CodeRabbit PR #111
  // review, Finding 5, for `sidebarWidthSettingsWriter.ts`).
  const sanitized = stripComments(text);
  const encodedHeight = JSON.stringify(height);
  // Defensive: only splice at `sanitized`'s offsets if it is actually the
  // same length as `text` — true for every real `stripComments` output
  // (this function's own contract), but a length mismatch here would mean
  // splicing `text` at offsets that name the wrong characters, which is
  // worse than falling through to the append path below.
  if (sanitized.length === text.length) {
    const match = PANEL_HEIGHT_KEY_RE.exec(sanitized);
    if (match) {
      const start = match.index;
      const end = start + match[0].length;
      return `${text.slice(0, start)}"workbench.panelHeight": ${encodedHeight}${text.slice(end)}`;
    }
  }

  const openBrace = findObjectOpenBrace(text);
  if (openBrace === -1) {
    return `{\n  "workbench.panelHeight": ${encodedHeight}\n}\n`;
  }
  // The trailing comma is only correct when a property actually FOLLOWS
  // the inserted one. An empty object (`{}`, or `{}` with only whitespace/
  // comments inside — the shape a fresh install's `settings.json` has, or
  // no file at all) would otherwise become `{"workbench.panelHeight": 13,}`
  // — invalid JSON, written into the user's settings by their very first
  // resize (mirrors `sidebarWidthSettingsWriter.ts`'s identical Finding).
  const rest = stripComments(text.slice(openBrace + 1));
  const objectIsEmpty = rest.trimStart().startsWith("}");
  const separator = objectIsEmpty ? "" : ",";
  return (
    text.slice(0, openBrace + 1) +
    `\n  "workbench.panelHeight": ${encodedHeight}${separator}` +
    text.slice(openBrace + 1)
  );
}

/** Build a panel-height settings writer (Issue #146). */
export function createPanelHeightSettingsWriter(
  deps: PanelHeightSettingsWriterDeps = {},
): PanelHeightSettingsWriter {
  const { log, sink } = deps;
  const path = deps.path ?? getUserSettingsPath();
  const fs = deps.fs ?? createNodePanelHeightSettingsWriterFs();
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

  async function doWrite(height: number): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(path);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") {
        text = "{}\n";
      } else {
        const message = `Failed to read settings (${path}) while persisting workbench.panelHeight: ${describeError(cause)}`;
        logSafely("error", { message, path });
        notifySafely({ message, path });
        return;
      }
    }

    const next = applyPanelHeightSetting(text, height);
    try {
      await fs.mkdir(dirname(path));
      await fs.writeFile(path, next);
    } catch (cause) {
      const message = `Failed to write settings (${path}) while persisting workbench.panelHeight: ${describeError(cause)}`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
    }
  }

  // Debounced, serialized write chain (this module's TSDoc) — matches
  // `sidebarWidthSettingsWriter.ts`'s `pendingTimer`/`saveChain` shape
  // exactly, just with `height` as the value carried through instead of
  // `width`.
  let pendingTimer: unknown;
  let pendingHeight: number | undefined;
  let writeChain: Promise<void> = Promise.resolve();

  function scheduleWrite(): void {
    writeChain = writeChain.then(
      () => doWrite(pendingHeight!),
      () => doWrite(pendingHeight!),
    );
  }

  function write(height: number): void {
    pendingHeight = height;
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
      // `sidebarWidthSettingsWriter.ts`'s identical fallback).
      pendingTimer = undefined;
      logSafely("warning", {
        message: `Panel height settings debounce timer failed, writing immediately: ${describeError(cause)}`,
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
