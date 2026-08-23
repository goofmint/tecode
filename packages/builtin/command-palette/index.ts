/**
 * `command-palette`'s `activate(ctx)` (Task 3.2, Req 11.3; design.md §13:
 * "Both are thin wrappers over `showQuickPick`"). Registers the two
 * commands `manifest.ts` declares against `tecode.window.showQuickPick`
 * (Task 3.1's real `ModalService`-backed implementation, merged in PR
 * #66) and the shared pure utilities in `../shared/` (`fuzzyMatch.ts`,
 * `whenFilter.ts`, `walkFiles.ts`, `ignore.ts`). Only imports `@tecode/api`
 * plus this package's own local `../shared/` files (the ESLint layering
 * rule) — every read/write goes through `ctx.api`.
 *
 * **`workbench.action.showCommands` (`ctrl+shift+p`)**: `api.commands.
 * list()` -> {@link filterByWhen} against `api.context.get` (so a
 * `when`-gated command that would not currently fire from its own
 * keybinding is not offered here either — this module's TSDoc's whole
 * reason for reimplementing `when` evaluation independently, see
 * `../shared/whenFilter.ts`) -> each survivor becomes a `QuickPickItem`
 * labeled `"Category: Title"` (bare `Title` with no `category`, falling
 * back to the raw command id with no `title` at all — see
 * {@link buildCommandLabel}) and `description` set to the command id
 * (round-tripped back on pick, the exact same "`description` carries the
 * id" convention `ui/themeSelectCommand.ts` already uses) -> `showQuickPick`
 * -> on accept, `api.commands.execute(id)`. A lazy (manifest-declared,
 * not-yet-activated) command's owning extension activates transparently
 * inside `execute` itself (`@tecode/core`'s `commands/registry.ts`) — this
 * handler does nothing special for that case, it is simply not visible
 * from the `tecode.commands` surface.
 *
 * **Why this does NOT filter out title-less commands** (this task's plan
 * originally called for hiding a title-less command from the listing —
 * this is the deliberate, adapted design once the real registry's behavior
 * is accounted for): `CommandRegistry.register(id, handler)` REPLACES any
 * earlier `meta` wholesale (`@tecode/core`'s `commands/registry.ts`), and
 * no built-in's `activate()` in this codebase re-supplies its manifest's
 * `title` when replacing a lazy registration with a real handler — so a
 * perfectly ordinary command (e.g. any of `editor-core`'s, once active)
 * ends up just as title-less as a genuinely internal bridge command like
 * `theme.select` or `workbench.action.files.openUri`. Treating "no title"
 * as "hide it" would therefore hide real, useful commands too. Instead,
 * a title-less command falls back to showing its raw id — readable enough
 * on its own (`"editor.action.cursorLeft"`) — and a command that genuinely
 * must never appear here (`workbench.action.files.openUri`) is kept out
 * via its OWN `when` clause instead (`ui/openFileCommand.ts`'s
 * `HIDDEN_FROM_LISTINGS_WHEN` — a context key nothing ever sets, so
 * {@link filterByWhen} always hides it, per the exact same `when`-filtering
 * mechanism this handler already applies to every other command).
 *
 * **`workbench.action.quickOpen` (`ctrl+p`)**: {@link walkFiles} over
 * `api.workspace.fs.readdir` (Task 3.2's plan: "verify what
 * `api.workspace.fs` actually exposes" — `@tecode/api`'s `FileSystem.
 * readdir(uri): Promise<DirEntry[]>`, `namespaces.ts`) rooted at
 * `api.workspace.rootUri`, with `createDefaultIgnorer()`'s interim stub
 * (`../shared/ignore.ts`, superseded by Task 3.3's real explorer ignore
 * logic). The walked list is already deterministically sorted
 * (`walkFiles.ts`'s own TSDoc); {@link fuzzyMatch} against an empty query
 * pre-ranks it before any typing happens (a documented no-op today — see
 * this function's own comment at the call site — but keeps the shape
 * ready for a future "rank by recency" or similar initial-query heuristic
 * with no call-site rewrite). `ModalService`'s own `filterQuickPickItems`
 * (case-insensitive substring match on label/description/detail) is what
 * actually narrows the list as the user types (design.md §12) — this
 * built-in does not re-filter on every keystroke itself; `QuickPickItem.
 * label` is the file's path relative to the workspace root, `description`
 * its absolute uri (round-tripped back on pick). On accept,
 * `api.commands.execute("workbench.action.files.openUri", uri)` — the
 * privileged core bridge command (`@tecode/core`'s `ui/
 * openFileCommand.ts`) that actually opens the file and makes it the
 * active tab. No workspace root, or zero files found, surfaces a
 * `window.showMessage` notice instead of opening an empty/useless picker.
 *
 * **Never throws** (design.md §14's "Command handler throws -> Caught,
 * logged"): every `showQuickPick`/`commands.execute` call is wrapped so a
 * throwing dependency degrades to a no-op rather than propagating —
 * cancelling the picker (Escape) is likewise a plain no-op, not an error.
 */

import type { CommandDescriptor, ExtensionContext, QuickPickItem } from "@tecode/api";
import { createDefaultIgnorer, filterByWhen, fuzzyMatch, walkFiles } from "../shared";
import { QUICK_OPEN_COMMAND_ID, SHOW_COMMANDS_COMMAND_ID } from "./manifest";

/**
 * The privileged bridge command `@tecode/core`'s `ui/openFileCommand.ts`
 * registers directly on the core `CommandRegistry` (Task 3.2's plan).
 * Duplicated as a literal string, not imported, because `packages/builtin`
 * may never import `@tecode/core` (the ESLint layering rule) — this
 * built-in only ever reaches it through `tecode.commands.execute`, exactly
 * like a third-party extension would. Must stay in sync with
 * `@tecode/core`'s `OPEN_FILE_COMMAND_ID`.
 */
const OPEN_FILE_COMMAND_ID = "workbench.action.files.openUri";

/** Build a palette label for `command` (this module's TSDoc): `"Category:
 * Title"`, bare `Title` with no `category`, or the raw command id when
 * `title` is absent/empty (this module's TSDoc's "Why this does NOT filter
 * out title-less commands"). */
function buildCommandLabel(command: CommandDescriptor): string {
  const title = command.title && command.title.length > 0 ? command.title : command.id;
  return command.category ? `${command.category}: ${title}` : title;
}

/** Registers `workbench.action.showCommands` (this module's TSDoc). */
function registerShowCommands(ctx: ExtensionContext): void {
  const { api } = ctx;
  ctx.subscriptions.push(
    api.commands.register(SHOW_COMMANDS_COMMAND_ID, async () => {
      try {
        const visible = filterByWhen(api.commands.list(), (key) => api.context.get(key));

        const items: QuickPickItem[] = visible.map((command) => ({
          label: buildCommandLabel(command),
          description: command.id,
        }));

        const picked = await api.window.showQuickPick(items, {
          placeHolder: "Type a command name",
        });
        if (!picked?.description) return;
        await api.commands.execute(picked.description);
      } catch {
        // Never throw out of a command handler (this module's TSDoc).
      }
    }),
  );
}

/** Registers `workbench.action.quickOpen` (this module's TSDoc). */
function registerQuickOpen(ctx: ExtensionContext): void {
  const { api } = ctx;
  ctx.subscriptions.push(
    api.commands.register(QUICK_OPEN_COMMAND_ID, async () => {
      try {
        const rootUri = api.workspace.rootUri;
        if (!rootUri) {
          api.window.showMessage("No folder is open to search.", "info");
          return;
        }

        const files = await walkFiles(rootUri, {
          readdir: (uri) => api.workspace.fs.readdir(uri),
          ignore: createDefaultIgnorer(),
        });
        if (files.length === 0) {
          api.window.showMessage("No files found in this workspace.", "info");
          return;
        }

        // Pre-rank with fuzzyMatch against an empty query (this module's
        // TSDoc): with no typed text yet, every candidate scores equally
        // (`fuzzyMatch("", x)` always returns `{ score: 0 }`), so this is a
        // stable no-op over `walkFiles`'s already-deterministic order
        // today — kept in this shape so a future initial-ranking signal
        // (e.g. recently opened files) only changes what's passed as the
        // query/scored against, not this call site.
        const ranked = files
          .map((file) => ({ file, match: fuzzyMatch("", file.relativePath) }))
          .filter((r): r is { file: (typeof files)[number]; match: NonNullable<typeof r.match> } =>
            r.match !== undefined,
          )
          .sort((a, b) => b.match.score - a.match.score)
          .map((r) => r.file);

        const items: QuickPickItem[] = ranked.map((file) => ({
          label: file.relativePath,
          description: file.uri,
        }));

        const picked = await api.window.showQuickPick(items, {
          placeHolder: "Go to file...",
        });
        if (!picked?.description) return;
        await api.commands.execute(OPEN_FILE_COMMAND_ID, picked.description);
      } catch {
        // Never throw out of a command handler (this module's TSDoc).
      }
    }),
  );
}

export function activate(ctx: ExtensionContext): void {
  registerShowCommands(ctx);
  registerQuickOpen(ctx);
}

export function deactivate(): void {
  // Nothing beyond `ctx.subscriptions` (disposed by the host, Req 2.6) —
  // this extension owns no other resources.
}
