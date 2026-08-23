/**
 * `ThemeSettingsWriter` (Req 7.5, design.md §9, §11): persists
 * `theme.select`'s committed choice by writing `"workbench.colorTheme"`
 * into the user's `settings.json` (`host/paths.ts`'s
 * `getUserSettingsPath()`) — `ConfigService`'s existing `fs.watch` on that
 * same file then picks the change up and re-loads it, exactly as if the
 * user had hand-edited the file themselves (design.md §11's live-reload
 * path, no separate signaling needed between this module and
 * `ConfigService`).
 *
 * **Text-replace, not re-serialize** (this task's plan): `settings.json` is
 * JSONC — it can carry the user's own comments and formatting — and a
 * naive "parse, mutate, `JSON.stringify` back" round-trip would silently
 * destroy both. This module instead finds the `"workbench.colorTheme"` key
 * with a targeted regex and replaces ONLY its value substring in place
 * (byte-for-byte identical everywhere else); if the key is entirely
 * absent, it is appended as a new property just inside the object's
 * opening `{` rather than the file being rewritten from scratch. A trailing
 * comma this can introduce (e.g. appending into an otherwise-empty `{}`)
 * is valid JSONC — `config/jsonc.ts`'s `parseJsonc` already strips trailing
 * commas — so `ConfigService`'s own re-read of the file this module just
 * wrote is unaffected.
 *
 * **Injectable fs seam, serialized writes**: matches `layoutState.ts`'s
 * `LayoutStateFs`/debounced-serialized-write shape (though this module
 * writes immediately on every call rather than debouncing — a
 * `theme.select` commit is a deliberate, infrequent user action, not a
 * layout drag) — a `writeChain` (`writeChain = writeChain.then(doWrite,
 * doWrite)`) so two `write()` calls landing close together never run
 * overlapping reads/writes of the same file.
 */

import {
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import { getUserSettingsPath } from "../host/paths";

/** The narrow filesystem seam {@link createThemeSettingsWriter} needs —
 * injectable (matches `layoutState.ts`'s `LayoutStateFs`,
 * `config/service.ts`'s `ConfigServiceFs`) so tests never touch the real
 * filesystem. */
export interface ThemeSettingsWriterFs {
  readFile(path: string): Promise<string>;
  /** Create `path`'s parent directory if it does not exist (the user
   * config dir may not exist yet on a fresh install — matches
   * `layoutState.ts`'s identical need). */
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}

function createNodeThemeSettingsWriterFs(): ThemeSettingsWriterFs {
  return {
    readFile: (path) => nodeReadFile(path, "utf8"),
    mkdir: (path) => nodeMkdir(path, { recursive: true }).then(() => undefined),
    writeFile: (path, data) => nodeWriteFile(path, data, "utf8"),
  };
}

/** Dependencies for {@link createThemeSettingsWriter}. */
export interface ThemeSettingsWriterDeps {
  /** Overrides `settings.json`'s path — tests use a temp file; production
   * defaults to {@link getUserSettingsPath}. */
  path?: string;
  /** Filesystem seam — see {@link ThemeSettingsWriterFs}. Defaults to
   * `node:fs/promises`. */
  fs?: ThemeSettingsWriterFs;
  log?: HostLog;
  sink?: StatusSink;
}

/** The theme settings writer's public surface (Req 7.5). */
export interface ThemeSettingsWriter {
  /** Persist `themeId` as `"workbench.colorTheme"` in the user settings
   * file (this module's TSDoc). Serialized against any other in-flight
   * `write()` call. Never throws/rejects — a read or write failure reports
   * through `log`/`sink` and this simply resolves anyway (matching this
   * codebase's "keep going, report, never crash the caller" boundary
   * discipline). */
  write(themeId: string): Promise<void>;
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches every other module's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Extract an errno-style `code` (matches `config/service.ts`'s/
 * `layoutState.ts`'s `errorCode`). */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

const COLOR_THEME_KEY_RE = /"workbench\.colorTheme"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * Text-replace `"workbench.colorTheme"`'s value in `text` with `themeId`
 * (this module's TSDoc): an exact-match replace if the key is already
 * present, or an insertion just inside the object's first `{` otherwise.
 * Exported for direct unit testing of the text-splicing logic, independent
 * of any filesystem I/O.
 */
export function applyColorThemeSetting(text: string, themeId: string): string {
  const match = COLOR_THEME_KEY_RE.exec(text);
  const encodedId = JSON.stringify(themeId);
  if (match) {
    const start = match.index;
    const end = start + match[0].length;
    return `${text.slice(0, start)}"workbench.colorTheme": ${encodedId}${text.slice(end)}`;
  }

  const openBrace = text.indexOf("{");
  if (openBrace === -1) {
    // No object to insert into at all (empty/malformed file) — start a
    // fresh minimal settings file rather than leaving the setting unwritten.
    return `{\n  "workbench.colorTheme": ${encodedId}\n}\n`;
  }
  return (
    text.slice(0, openBrace + 1) +
    `\n  "workbench.colorTheme": ${encodedId},` +
    text.slice(openBrace + 1)
  );
}

/** Build a theme settings writer (Req 7.5). */
export function createThemeSettingsWriter(deps: ThemeSettingsWriterDeps = {}): ThemeSettingsWriter {
  const { log, sink } = deps;
  const path = deps.path ?? getUserSettingsPath();
  const fs = deps.fs ?? createNodeThemeSettingsWriterFs();

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

  async function doWrite(themeId: string): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(path);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") {
        text = "{}\n";
      } else {
        const message = `Failed to read settings (${path}) while persisting workbench.colorTheme: ${describeError(cause)}`;
        logSafely("error", { message, path });
        notifySafely({ message, path });
        return;
      }
    }

    const next = applyColorThemeSetting(text, themeId);
    try {
      await fs.mkdir(dirname(path));
      await fs.writeFile(path, next);
    } catch (cause) {
      const message = `Failed to write settings (${path}) while persisting workbench.colorTheme: ${describeError(cause)}`;
      logSafely("error", { message, path });
      notifySafely({ message, path });
    }
  }

  // Serialized write chain (this module's TSDoc) — matches
  // `layoutState.ts`'s `saveChain`/`config/service.ts`'s per-file reload
  // chains.
  let writeChain: Promise<void> = Promise.resolve();

  function write(themeId: string): Promise<void> {
    writeChain = writeChain.then(
      () => doWrite(themeId),
      () => doWrite(themeId),
    );
    return writeChain;
  }

  return { write };
}
