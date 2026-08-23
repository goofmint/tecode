/**
 * The `workbench.action.files.openUri` command (Task 3.2, Req 11.3;
 * design.md §13's "both [`ctrl+shift+p`/`ctrl+p`] are thin wrappers over
 * `showQuickPick`"): the privileged bridge file quick-open's picked-item
 * handler calls to actually open a file and make it the active tab —
 * `documents.openDocument(uri)` then `editorSession.setActiveDocumentUri
 * (uri)`, in that order.
 *
 * **Why a core bridge command, not something `command-palette` (the
 * built-in) does directly** — same privilege-boundary reasoning as
 * `theme.select` (`ui/themeSelectCommand.ts`'s TSDoc) and the `modal.*`
 * commands (`ui/modalCommands.ts`'s TSDoc): `@tecode/api`'s
 * `WorkspaceNamespace.openDocument` already opens a file through
 * `tecode.workspace`, but nothing on the public API lets an extension set
 * WHICH open document is the shell's active tab —
 * `EditorSessionService.setActiveDocumentUri` is `@tecode/core`-internal,
 * reachable only from composition-root code (`main.ts`). Registering this
 * command directly on the core `CommandRegistry` (not through
 * `command-palette`'s manifest) is what lets `command-palette`'s `index.ts`
 * open-and-activate a picked file with one `commands.execute` call while
 * staying entirely within the `@tecode/api` surface itself.
 *
 * **Kept out of the command palette's own listing via `when`, not via a
 * missing `title`** (Task 3.2's plan asked for "no title/category so it
 * stays out of the listing" — this is the mechanism that actually
 * delivers that, once the real registry behavior is accounted for):
 * `CommandRegistry.register(id, handler)` REPLACES any earlier meta
 * wholesale (`commands/registry.ts`'s `storeEntry` — confirmed by
 * `registry.test.ts`'s own "list()... explorer.reveal registered with no
 * meta -> title/category/when all undefined" case), and no extension's
 * `activate()` in this codebase re-supplies its manifest's `title` when
 * replacing a lazy registration with a real handler — so "has no `title`"
 * is not actually a reliable "internal command" signal at listing time; a
 * perfectly ordinary, real command can legitimately end up title-less too.
 * `command-palette/index.ts` therefore falls back to the raw command id as
 * a label for ANY title-less command rather than hiding it — which would
 * silently swallow this command right back into visibility. Instead, this
 * registration's `meta.when` names {@link HIDDEN_FROM_LISTINGS_WHEN}, a
 * context key that is never set by anything — {@link filterByWhen}-style
 * listings (the command palette's own, `../shared/whenFilter.ts`) always
 * evaluate an unset bare key as falsy and hide the command, exactly the
 * "`when`-filtered listing" mechanism design.md §13 already describes the
 * palette as using, just aimed at hiding rather than showing. `when` has
 * NO effect on `commands.execute` itself (`registry.test.ts`'s own "list
 * does not filter by when — that is the caller's responsibility", and
 * `execute` never consults `when` at all) — quick-open's own
 * `commands.execute("workbench.action.files.openUri", uri)` call is
 * completely unaffected by this.
 *
 * **Never throws** (matches every other command handler in this codebase,
 * design.md §14's "Command handler throws -> Caught, logged"): a bad
 * argument (missing, wrong type, empty string) is reported to `log` and
 * treated as a no-op; a rejecting `documents.openDocument` is caught the
 * same way. `editorSession.setActiveDocumentUri` itself is synchronous and
 * documented never to throw (`ui/editorSession.ts`), so nothing wraps it
 * separately.
 */

import type { CommandHandler, CommandMeta, Disposable, Uri } from "@tecode/api";
import type { HostError, HostLog } from "../host/errors";
import type { DocumentManager } from "../buffer/documentManager";
import type { EditorSessionService } from "./editorSession";

/** Dependencies for {@link createOpenFileCommandHandler}. Narrowed with
 * `Pick` (matches `ThemeSelectDeps`'s own narrowing style) to exactly the
 * two methods this command needs. */
export interface OpenFileCommandDeps {
  documents: Pick<DocumentManager, "openDocument">;
  editorSession: Pick<EditorSessionService, "setActiveDocumentUri">;
  log?: HostLog;
}

/** Guarded `log.append` (matches every other module's `logSafely` —
 * `themeSelectCommand.ts`, `modalCommands.ts`'s sibling modules). */
function logSafely(log: HostLog | undefined, level: "error" | "warning", err: HostError): void {
  if (!log) return;
  try {
    log.append(level, err);
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches every other module's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Command id this module registers (this module's TSDoc). Exported so
 * callers (`command-palette`'s quick-open handler, tests) reference the
 * same string rather than re-typing it. */
export const OPEN_FILE_COMMAND_ID = "workbench.action.files.openUri";

/** A context key deliberately never set by anything in this codebase — used
 * only as this command's `meta.when` (this module's TSDoc) so a
 * `when`-respecting listing (the command palette) always hides it, without
 * relying on the absence of a `title` to mean "internal" (which is not a
 * reliable signal here — see this module's TSDoc). */
export const HIDDEN_FROM_LISTINGS_WHEN = "tecode.internal.neverShown";

/**
 * Build the `workbench.action.files.openUri` handler (this module's
 * TSDoc). Expects exactly one argument: a `Uri` string naming the file to
 * open. Any other shape (no argument, a non-string, an empty string) is a
 * tolerated no-op, logged as a warning — never thrown.
 */
export function createOpenFileCommandHandler(deps: OpenFileCommandDeps): CommandHandler {
  return async (...args: unknown[]) => {
    const uri = args[0];
    if (typeof uri !== "string" || uri.length === 0) {
      logSafely(deps.log, "warning", {
        message: `${OPEN_FILE_COMMAND_ID}: expected a non-empty uri string argument, got ${JSON.stringify(uri)}.`,
      });
      return;
    }
    try {
      await deps.documents.openDocument(uri as Uri);
      deps.editorSession.setActiveDocumentUri(uri as Uri);
    } catch (cause) {
      logSafely(deps.log, "error", {
        message: `${OPEN_FILE_COMMAND_ID}("${uri}") failed: ${describeError(cause)}`,
      });
    }
  };
}

/** Register {@link createOpenFileCommandHandler}'s handler as
 * `workbench.action.files.openUri` directly on the core `CommandRegistry`
 * (this module's TSDoc), with `meta.when` set to
 * {@link HIDDEN_FROM_LISTINGS_WHEN} — see this module's TSDoc on why that
 * (rather than an absent `title`) is what actually keeps it out of a
 * `when`-filtered listing while staying fully reachable via
 * `commands.execute`. */
export function registerOpenFileCommand(
  commands: { register(id: string, handler: CommandHandler, meta?: CommandMeta): Disposable },
  deps: OpenFileCommandDeps,
): Disposable {
  return commands.register(OPEN_FILE_COMMAND_ID, createOpenFileCommandHandler(deps), {
    when: HIDDEN_FROM_LISTINGS_WHEN,
  });
}
