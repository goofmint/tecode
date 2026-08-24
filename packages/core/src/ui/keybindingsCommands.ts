/**
 * The two privileged `keybindings.internal.*` bridge commands
 * `packages/builtin/keybindings-editor` (Task 4.3, Req 11.7; design.md
 * §13's "**keybindings-editor**: `keybindings.open` opens the JSON file
 * as a normal document [...]; `keybindings.showResolved` renders the
 * keymap service's resolved table in a quick pick") reaches through
 * `tecode.commands.execute` instead of importing `@tecode/core` directly
 * — `packages/builtin/**` may only import `@tecode/api` (the ESLint
 * layering rule), and neither "the user keybindings file path" nor "the
 * live resolved binding table" is something `@tecode/api` exposes to an
 * ordinary extension. This module follows the exact precedent
 * `openFileCommand.ts` set for `workbench.action.files.openUri`: a
 * privileged capability, registered directly on the core
 * `CommandRegistry`, reachable only via `commands.execute`, kept out of
 * every `when`-filtered listing via {@link HIDDEN_FROM_LISTINGS_WHEN}
 * rather than by omitting a title (that module's TSDoc explains at
 * length why an absent title alone is not a reliable "hide this" signal
 * in this codebase).
 *
 * **`keybindings.internal.ensureFile`**: resolves the user's
 * `keybindings.json` path (`host/paths.ts`'s `getUserKeybindingsPath`);
 * if the file does not exist yet, creates its parent directory and
 * writes {@link KEYBINDINGS_TEMPLATE} — a commented JSONC starter that
 * documents the `{ "key", "command", "when"? }` entry shape and the
 * `"-command"` removal syntax (Req 4.2, 4.3). Either way (already
 * present, or just created), resolves to the file's `Uri`
 * (`buffer/uri.ts`'s `pathToUri`) so `keybindings-editor/index.ts`'s
 * `keybindings.open` handler can hand it straight to
 * `workbench.action.files.openUri`. Writes are serialized through a
 * chained promise, matching `themeSettingsWriter.ts`'s
 * "`writeChain = writeChain.then(doWrite, doWrite)`" pattern, so two
 * overlapping `keybindings.open` invocations never race each other's
 * existence-check-then-write; existence itself is detected the same way
 * `themeSettingsWriter.ts`'s `doWrite` detects a missing `settings.json`
 * — attempt the read, treat `ENOENT` as "create the default" and any
 * other read failure as a reportable error (logged/notified, but still
 * resolving to the file's `Uri` — a stat/permission problem here is
 * exactly the kind of thing `documents.openDocument` itself will also
 * hit and report when `keybindings.open` tries to actually open the
 * file next, so this command does not need to duplicate that failure
 * mode as a thrown error of its own).
 *
 * **`keybindings.internal.resolveTable`**: flattens the live keymap
 * table's `BindingTable.entries()` (`keymap/bindingTable.ts` — a
 * `ReadonlyMap<string, ResolvedBinding[]>`, one bucket per canonical
 * key) into a flat, key-sorted array of plain rows — `key`, `command`,
 * optional `when`, `layer`, and (extension layer only) `extensionId` —
 * for `keybindings.showResolved` to project into `QuickPickItem`s.
 * Reads through {@link KeybindingsCommandsDeps.getTable}, a GETTER
 * rather than a captured `BindingTable`, for the same reason `main.ts`
 * builds `chordMachine` against a small forwarding `liveTable` object
 * instead of a snapshot (`main.ts`'s TSDoc, "Live keymap table view"):
 * `keymapState.ts`'s `KeymapState.getTable()` swaps to a brand-new
 * `BindingTable` on every `setUserEntries`/`setExtensionEntries` call,
 * so a captured reference would go stale the moment the user's
 * `keybindings.json` is next edited. Reading through the getter on every
 * `resolveTable` call — rather than once at registration time — is
 * exactly what makes `showResolved` reflect a live-edited
 * `keybindings.json` with no restart (Req 11.7's completion
 * requirement): `ConfigService`'s `fs.watch` on `keybindings.json`
 * already re-parses the file and calls `keymap.setUserEntries` on
 * change (`main.ts`'s `onKeybindingsChange` wiring), which is what
 * produces the new `BindingTable` this getter then picks up.
 *
 * **Both commands' `meta.when` is {@link HIDDEN_FROM_LISTINGS_WHEN}**
 * (`openFileCommand.ts`'s own constant, imported rather than duplicated
 * — both modules live under `ui/`): a `when`-filtered listing (the
 * command palette's `workbench.action.showCommands`) always hides an
 * unset bare context key, so both `keybindings.internal.*` ids stay out
 * of the palette while remaining fully reachable via `commands.execute`
 * — `when` has no bearing on `execute` itself.
 *
 * **Known, accepted limitation — command override (Issue #72)**: both
 * ids are registered on the plain `CommandRegistry`, which is last-wins
 * (`commands/registry.ts`'s `storeEntry`) — a third-party extension
 * could re-register either `keybindings.internal.*` id and shadow this
 * module's real implementation, the same way it could shadow
 * `theme.select`, `workbench.action.files.openUri`, any `modal.*`/
 * `tab.*` command, or `extensions.reload`. This is a known, repo-wide
 * property of every privileged bridge command registered this way, not
 * something specific to keybindings — tracked centrally in Issue #72,
 * and deliberately NOT addressed by this module.
 */

import {
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandHandler, CommandMeta, Disposable, Uri } from "@tecode/api";
import type { HostError, HostLog, StatusSink } from "../host/errors";
import { getUserKeybindingsPath } from "../host/paths";
import { pathToUri } from "../buffer/uri";
import type { BindingLayer, BindingTable } from "../keymap/bindingTable";
import { HIDDEN_FROM_LISTINGS_WHEN } from "./openFileCommand";

/** `keybindings.internal.ensureFile`'s command id (this module's TSDoc).
 * Exported so `keybindings-editor`'s tests/`index.ts` (which can only
 * reach it as a bare string, via `commands.execute` — the ESLint
 * layering rule) and this module's own tests reference the same
 * literal. */
export const KEYBINDINGS_ENSURE_FILE_COMMAND_ID = "keybindings.internal.ensureFile";

/** `keybindings.internal.resolveTable`'s command id (this module's
 * TSDoc). Same "exported so both sides agree on the literal" reasoning
 * as {@link KEYBINDINGS_ENSURE_FILE_COMMAND_ID}. */
export const KEYBINDINGS_RESOLVE_TABLE_COMMAND_ID = "keybindings.internal.resolveTable";

/**
 * The commented JSONC starter `keybindings.internal.ensureFile` writes
 * the first time a user opens `keybindings.json` with none on disk yet
 * (Req 4.2, 4.3, 11.7). Every non-blank line here is a `//` line
 * comment; this module deliberately never opens a block comment at all
 * (a known hazard elsewhere in this codebase: a block comment whose body
 * itself contains a path or example ending the comment's own closing
 * marker early, silently truncating everything after it) — so the whole
 * template parses, byte for byte, as the empty array `[]` once
 * `config/jsonc.ts`'s `stripComments`/`stripTrailingCommas` run, which
 * `keybindingsCommands.test.ts`'s "the template round-trips through the
 * repo's real parseJsonc" case proves directly against the real parser,
 * not just eyeballed.
 */
export const KEYBINDINGS_TEMPLATE = `// keybindings.json — tecode user keybindings (Req 4.1-4.4; design.md §6.2).
//
// This is the highest-precedence keybinding layer: entries here override
// core defaults and anything an extension contributes. This file is
// watched — no restart needed after you save a change (run
// "keybindings.showResolved" from the command palette to confirm what
// took effect).
//
// Each entry has the shape:
//
//   { "key": "<chord>", "command": "<commandId>", "when"?: "<expression>" }
//
//   - key      A single stroke (e.g. "ctrl+s") or a two-stroke chord,
//              its strokes space-separated (e.g. "ctrl+k ctrl+s").
//   - command  The command id to run. Prefix it with "-" to REMOVE a
//              default binding instead of adding one — for example
//              "-editor.action.deleteLine" unbinds whatever key that
//              command's default currently sits on. A removal entry
//              may not also carry a "when" clause.
//   - when     Optional. A boolean context expression using &&, ||, !,
//              and == over context keys such as editorFocus,
//              editorTextFocus, terminalFocus, and explorerFocus (e.g.
//              "editorTextFocus && editorLangId == 'ts'"). Omit it to
//              bind unconditionally.
//
// Examples (commented out below — uncomment and edit to use them):
//
// [
//   { "key": "ctrl+k ctrl+s", "command": "workbench.action.showCommands" },
//   { "key": "ctrl+alt+n", "command": "workbench.action.files.openUri", "when": "editorFocus" },
//   { "key": "ctrl+d", "command": "-editor.action.addSelectionToNextFindMatch" }
// ]

[]
`;

/** The narrow filesystem seam {@link createKeybindingsCommandsHandlers}
 * needs — injectable (matches `themeSettingsWriter.ts`'s
 * `ThemeSettingsWriterFs`) so tests never touch the real filesystem. */
export interface KeybindingsCommandsFs {
  readFile(path: string): Promise<string>;
  /** Create `path`'s parent directory if it does not exist (the user
   * config dir may not exist yet on a fresh install — matches
   * `themeSettingsWriter.ts`'s/`layoutState.ts`'s identical need). */
  mkdir(path: string): Promise<void>;
  /**
   * Create `path` containing `data`, **failing with `EEXIST` if it already
   * exists** — an exclusive create (`wx`), never a truncating overwrite.
   *
   * This module's only write is "lay down the template on a fresh
   * install", so exclusivity is always the semantic it wants, and the
   * interface states that rather than leaving it to each caller. The
   * in-process serialized write chain below only orders calls within ONE
   * process; it cannot see a SECOND tecode instance — or the user's other
   * editor — creating the file in the window between this module's
   * existence check and its write. A plain `writeFile` would truncate
   * whatever they had just put there. {@link createKeybindingsCommandsHandlers}
   * treats the resulting `EEXIST` as success and keeps their content.
   */
  writeFileExclusive(path: string, data: string): Promise<void>;
}

function createNodeKeybindingsCommandsFs(): KeybindingsCommandsFs {
  return {
    readFile: (path) => nodeReadFile(path, "utf8"),
    mkdir: (path) => nodeMkdir(path, { recursive: true }).then(() => undefined),
    writeFileExclusive: (path, data) =>
      nodeWriteFile(path, data, { encoding: "utf8", flag: "wx" }),
  };
}

/** One flattened row of the resolved binding table (this module's
 * TSDoc's `keybindings.internal.resolveTable`) — the plain-data shape
 * `keybindings.internal.resolveTable` resolves to and
 * `keybindings-editor/index.ts`'s `showResolved` handler validates at
 * runtime before formatting into `QuickPickItem`s (bridge commands
 * return `unknown` to a `packages/builtin` caller, same as every other
 * `commands.execute` result). */
export interface ResolvedBindingRow {
  key: string;
  command: string;
  when?: string;
  layer: BindingLayer;
  extensionId?: string;
}

/** Dependencies {@link createKeybindingsCommandsHandlers}/
 * {@link registerKeybindingsCommands} need. */
export interface KeybindingsCommandsDeps {
  /** Live view of the current binding table (this module's TSDoc's
   * "`keybindings.internal.resolveTable`" — a getter, not a captured
   * `BindingTable`, so a live-edited `keybindings.json` is reflected on
   * the very next `resolveTable` call with no restart). */
  getTable(): Pick<BindingTable, "entries">;
  /** Overrides the resolved `keybindings.json` path — tests use a temp
   * file; production defaults to {@link getUserKeybindingsPath}. */
  path?: string;
  /** Filesystem seam — see {@link KeybindingsCommandsFs}. Defaults to
   * `node:fs/promises`. */
  fs?: KeybindingsCommandsFs;
  log?: HostLog;
  sink?: StatusSink;
}

/** Render a caught `unknown` as a message string without risking a
 * second throw (matches every other module's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Extract an errno-style `code` (matches `themeSettingsWriter.ts`'s/
 * `config/service.ts`'s `errorCode`). */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** The pair of handlers this module registers, plus the resolved path
 * they operate on — exported separately from
 * {@link registerKeybindingsCommands} so a test can invoke
 * `ensureFile`/`resolveTable` directly without going through the
 * `CommandRegistry`'s `execute(...args: unknown[])` signature. */
export interface KeybindingsCommandsHandlers {
  /** Handler behind `keybindings.internal.ensureFile` — resolves to the
   * `keybindings.json` file's `Uri`, creating it from
   * {@link KEYBINDINGS_TEMPLATE} first if absent. Never throws/rejects
   * (this module's TSDoc). */
  ensureFile(): Promise<Uri>;
  /** Handler behind `keybindings.internal.resolveTable` — resolves to
   * every visible binding in the CURRENT table, flattened and sorted by
   * key for a stable, readable listing order. Never throws/rejects:
   * `BindingTable.entries()` itself never throws (`bindingTable.ts`). */
  resolveTable(): Promise<ResolvedBindingRow[]>;
}

/** Build the two handlers (this module's TSDoc) without registering them
 * — exported for direct unit testing of the create-vs-open and
 * table-flattening logic, independent of the `CommandRegistry`. */
export function createKeybindingsCommandsHandlers(
  deps: KeybindingsCommandsDeps,
): KeybindingsCommandsHandlers {
  const path = deps.path ?? getUserKeybindingsPath();
  const fs = deps.fs ?? createNodeKeybindingsCommandsFs();
  const { log, sink } = deps;

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

  async function doEnsureFile(): Promise<Uri> {
    try {
      await fs.readFile(path);
      // Already exists — leave it exactly as the user has it, even if
      // its content happens to be invalid JSONC right now (that is
      // `ConfigService`'s failure mode to report, via its own
      // `fs.watch`-driven reload, not this command's).
      return pathToUri(path);
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") {
        const message = `Failed to check user keybindings (${path}) before creating the template: ${describeError(cause)}`;
        logSafely("error", { message, path });
        notifySafely({ message, path });
        return pathToUri(path);
      }
    }

    try {
      await fs.mkdir(dirname(path));
      await fs.writeFileExclusive(path, KEYBINDINGS_TEMPLATE);
    } catch (cause) {
      // `EEXIST` means somebody else won the race between the existence
      // check above and this write — a second tecode instance, or the
      // user's other editor. Their file is the one that should survive:
      // this command's contract is "make sure a keybindings file exists",
      // which is now satisfied, so this is success, not a failure worth
      // reporting. Every other error still is.
      if (errorCode(cause) !== "EEXIST") {
        const message = `Failed to create user keybindings template (${path}): ${describeError(cause)}`;
        logSafely("error", { message, path });
        notifySafely({ message, path });
      }
    }
    return pathToUri(path);
  }

  // Serialized write chain (this module's TSDoc), matching
  // `themeSettingsWriter.ts`'s `writeChain = writeChain.then(doWrite,
  // doWrite)` — two `ensureFile()` calls landing close together (a
  // double-invocation of `keybindings.open`) never race each other's
  // existence-check-then-write.
  let writeChain: Promise<Uri> = Promise.resolve(pathToUri(path));

  function ensureFile(): Promise<Uri> {
    writeChain = writeChain.then(doEnsureFile, doEnsureFile);
    return writeChain;
  }

  async function resolveTable(): Promise<ResolvedBindingRow[]> {
    const rows: ResolvedBindingRow[] = [];
    for (const bucket of deps.getTable().entries().values()) {
      for (const binding of bucket) {
        const row: ResolvedBindingRow = {
          key: binding.key,
          command: binding.command,
          layer: binding.layer,
        };
        if (binding.when !== undefined) row.when = binding.when;
        if (binding.extensionId !== undefined) row.extensionId = binding.extensionId;
        rows.push(row);
      }
    }
    // Stable, deterministic listing order — `BindingTable.entries()`'s
    // own Map iteration order is an incidental fact of internal
    // construction, not a documented contract, so this command imposes
    // its own explicit ordering (by key, then insertion order among
    // same-key rows, which `Array.prototype.sort` preserves as a stable
    // sort) rather than exposing whatever order the table happens to
    // build in.
    rows.sort((a, b) => a.key.localeCompare(b.key));
    return rows;
  }

  return { ensureFile, resolveTable };
}

/** The narrow `CommandRegistry` slice
 * {@link registerKeybindingsCommands} needs — matches
 * `tabCommands.ts`'s `TabCommandsRegistrar`/`modalCommands.ts`'s
 * `ModalCommandsRegistrar` narrowing style. */
export interface KeybindingsCommandsRegistrar {
  register(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable;
}

/**
 * Register both `keybindings.internal.*` bridge commands directly on the
 * core `CommandRegistry` (this module's TSDoc). Returns one composite
 * `Disposable` covering both registrations — matches
 * `registerTabCommands`'s/`registerModalCommands`'s "several
 * `commands.register` calls collapsed into a single disposable" shape —
 * idempotent like every other `Disposable` in this codebase (a second
 * `dispose()` call is a no-op).
 */
export function registerKeybindingsCommands(
  commands: KeybindingsCommandsRegistrar,
  deps: KeybindingsCommandsDeps,
): Disposable {
  const handlers = createKeybindingsCommandsHandlers(deps);
  const disposables: Disposable[] = [
    commands.register(KEYBINDINGS_ENSURE_FILE_COMMAND_ID, () => handlers.ensureFile(), {
      when: HIDDEN_FROM_LISTINGS_WHEN,
    }),
    commands.register(KEYBINDINGS_RESOLVE_TABLE_COMMAND_ID, () => handlers.resolveTable(), {
      when: HIDDEN_FROM_LISTINGS_WHEN,
    }),
  ];
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
