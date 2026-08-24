/**
 * `keybindings-editor`'s `activate(ctx)` (Task 4.3, Req 11.7; design.md
 * §13's keybindings-editor design). Registers the two commands
 * `manifest.ts` declares, both thin wrappers over privileged bridge
 * commands `@tecode/core`'s `ui/keybindingsCommands.ts` registers directly
 * on the core `CommandRegistry` — the same "reach a privileged
 * core-internal capability purely through `tecode.commands.execute`"
 * pattern `command-palette/index.ts`'s file quick-open uses for
 * `workbench.action.files.openUri` (that module's TSDoc). Only imports
 * `@tecode/api` (the ESLint layering rule) — every read/write goes
 * through `ctx.api`.
 *
 * **`keybindings.open`**: `keybindings.internal.ensureFile` (resolves the
 * user's `keybindings.json` path, creating it from a commented JSONC
 * template on first use) -> `workbench.action.files.openUri` with the
 * returned `Uri` — same two-step "resolve, then open" shape
 * `command-palette`'s quick-open uses for a picked file.
 *
 * **`keybindings.showResolved`**: `keybindings.internal.resolveTable` ->
 * format each row into a `QuickPickItem` (label: key + command; detail:
 * source layer, with the owning extension id shown for an `"extension"`
 * layer binding when known, plus the `when` clause when present) ->
 * `api.window.showQuickPick`. Req 11.7's own acceptance text explicitly
 * allows "display-only" for the MVP ("selecting an entry may copy or
 * reveal it (MVP: display-only is acceptable)") — this handler does
 * nothing further once the picker resolves (accepted or cancelled).
 *
 * **Both bridge commands return `unknown` — validated at runtime, never
 * blind-cast**: `tecode.commands.execute` (`@tecode/api`'s
 * `CommandsNamespace.execute`) is typed `Promise<unknown>` for every
 * command, bridge or not — this module has no compile-time guarantee the
 * result actually has the shape `ui/keybindingsCommands.ts` documents (a
 * malicious or buggy re-registration of either `keybindings.internal.*`
 * id, per this module's own "Known, accepted limitation" note below,
 * could hand back anything at all). {@link isUri} and
 * {@link isResolvedBindingRow} are the runtime guards that stand in for
 * the compile-time type-checking a same-package `@tecode/core` import
 * would otherwise have given for free — a malformed result degrades to a
 * `window.showMessage` notice, never a thrown exception or a silently
 * wrong picker.
 *
 * **Known, accepted limitation — command override (Issue #72)**, carried
 * over from `ui/keybindingsCommands.ts`'s own TSDoc: both
 * `keybindings.internal.*` ids this module calls through
 * `commands.execute` are registered on the plain, last-wins
 * `CommandRegistry` — nothing in this module (or in `@tecode/api` at all)
 * can guarantee the handler that actually runs is the real one from
 * `ui/keybindingsCommands.ts` rather than a re-registration by some other
 * extension. Not addressed here, same as every other bridge-command
 * caller in this codebase.
 *
 * **Never throws, out of this module** (design.md §14's "Command handler
 * throws -> Caught, logged"), same reasoning as `command-palette/
 * index.ts`'s own TSDoc: `@tecode/core`'s `CommandRegistry.execute`
 * already catches whatever a registered handler throws, logs it, and
 * resolves to `undefined` — neither handler here wraps its own body in a
 * local `try`/`catch` on top of that.
 */

import type { ExtensionContext, QuickPickItem, Uri } from "@tecode/api";
import { KEYBINDINGS_OPEN_COMMAND_ID, KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID } from "./manifest";

/**
 * The privileged bridge commands `@tecode/core`'s `ui/
 * keybindingsCommands.ts` registers directly on the core
 * `CommandRegistry` (that module's TSDoc). Duplicated as literal strings,
 * not imported, because `packages/builtin` may never import
 * `@tecode/core` (the ESLint layering rule) — this built-in only ever
 * reaches them through `tecode.commands.execute`, exactly like a
 * third-party extension would. Must stay in sync with `ui/
 * keybindingsCommands.ts`'s `KEYBINDINGS_ENSURE_FILE_COMMAND_ID`/
 * `KEYBINDINGS_RESOLVE_TABLE_COMMAND_ID` (matches `command-palette/
 * index.ts`'s identical `OPEN_FILE_COMMAND_ID` duplication).
 */
const ENSURE_FILE_COMMAND_ID = "keybindings.internal.ensureFile";
const RESOLVE_TABLE_COMMAND_ID = "keybindings.internal.resolveTable";

/** `workbench.action.files.openUri` (`@tecode/core`'s `ui/
 * openFileCommand.ts`) — same duplication reasoning as above, and the
 * exact literal `command-palette/index.ts` already duplicates for the
 * same command. */
const OPEN_FILE_COMMAND_ID = "workbench.action.files.openUri";

/** The four binding layers `ui/keybindingsCommands.ts`'s
 * `ResolvedBindingRow.layer` can name — kept in sync by hand (this module
 * cannot import `@tecode/core`'s `BindingLayer` type across the layering
 * boundary) and used only to validate a resolved row's shape at runtime
 * ({@link isResolvedBindingRow}). */
const BINDING_LAYERS = ["defaults", "fallback", "extension", "user"] as const;
type BindingLayer = (typeof BINDING_LAYERS)[number];

/** One row of `keybindings.internal.resolveTable`'s result, as this
 * module trusts it ONLY after {@link isResolvedBindingRow} confirms the
 * shape — mirrors `@tecode/core`'s `ui/keybindingsCommands.ts`'s
 * `ResolvedBindingRow` field for field, duplicated locally for the same
 * "cannot import `@tecode/core`" reason as the command ids above. */
interface ResolvedBindingRow {
  key: string;
  command: string;
  when?: string;
  layer: BindingLayer;
  extensionId?: string;
}

/** Runtime guard for a `keybindings.internal.ensureFile` result (this
 * module's TSDoc's "validated at runtime, never blind-cast") — a `Uri` is
 * `@tecode/api`'s `primitives.ts` plain non-empty `file://...` string. */
function isUri(value: unknown): value is Uri {
  return typeof value === "string" && value.length > 0;
}

function isBindingLayer(value: unknown): value is BindingLayer {
  return typeof value === "string" && (BINDING_LAYERS as readonly string[]).includes(value);
}

/** Runtime guard for one element of `keybindings.internal.resolveTable`'s
 * result array (this module's TSDoc). An element failing this check is
 * silently dropped by {@link registerShowResolved} rather than crashing
 * the whole listing over one malformed row. */
function isResolvedBindingRow(value: unknown): value is ResolvedBindingRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.key !== "string" || row.key.length === 0) return false;
  if (typeof row.command !== "string" || row.command.length === 0) return false;
  if (row.when !== undefined && typeof row.when !== "string") return false;
  if (!isBindingLayer(row.layer)) return false;
  if (row.extensionId !== undefined && typeof row.extensionId !== "string") return false;
  return true;
}

/** Render `row`'s source-layer attribution for a `QuickPickItem`'s
 * `detail` (Req 11.7's "key, command, `when` clause, and source layer
 * (default / fallback / extension id / user) per binding"): the owning
 * extension id when this is an `"extension"`-layer binding AND the id is
 * known (`ui/keybindingsCommands.ts`'s `ResolvedBindingRow.extensionId`
 * is only ever populated for that layer — this module's own
 * `isResolvedBindingRow` does not further enforce that pairing, trusting
 * the core module's own contract instead), the bare layer name otherwise. */
function formatSource(row: ResolvedBindingRow): string {
  if (row.layer === "extension") {
    return row.extensionId ? `extension: ${row.extensionId}` : "extension";
  }
  return row.layer;
}

/** Build one resolved binding's `QuickPickItem` (this module's TSDoc). */
function buildResolvedItem(row: ResolvedBindingRow): QuickPickItem {
  const detailParts = [`source: ${formatSource(row)}`];
  if (row.when) detailParts.push(`when: ${row.when}`);
  return {
    label: `${row.key} — ${row.command}`,
    detail: detailParts.join("  ·  "),
  };
}

/** Registers `keybindings.open` (this module's TSDoc). */
function registerOpen(ctx: ExtensionContext): void {
  const { api } = ctx;
  ctx.subscriptions.push(
    api.commands.register(KEYBINDINGS_OPEN_COMMAND_ID, async () => {
      const result = await api.commands.execute(ENSURE_FILE_COMMAND_ID);
      if (!isUri(result)) {
        api.window.showMessage("Could not resolve the keybindings.json file path.", "error");
        return;
      }
      await api.commands.execute(OPEN_FILE_COMMAND_ID, result);
    }),
  );
}

/** Registers `keybindings.showResolved` (this module's TSDoc). */
function registerShowResolved(ctx: ExtensionContext): void {
  const { api } = ctx;
  ctx.subscriptions.push(
    api.commands.register(KEYBINDINGS_SHOW_RESOLVED_COMMAND_ID, async () => {
      const result = await api.commands.execute(RESOLVE_TABLE_COMMAND_ID);
      if (!Array.isArray(result)) {
        api.window.showMessage("Could not read the resolved keybinding table.", "error");
        return;
      }

      const rows = result.filter(isResolvedBindingRow);
      if (rows.length === 0) {
        api.window.showMessage("No keybindings are currently registered.", "info");
        return;
      }

      const items: QuickPickItem[] = rows.map(buildResolvedItem);
      // Display-only for the MVP (Req 11.7's own acceptance text, this
      // module's TSDoc) — the picked item (if any) is intentionally
      // discarded; opening the picker itself already lets the user read
      // every binding's key/command/when/source.
      await api.window.showQuickPick(items, {
        placeHolder: "Resolved keybindings — key, command, source layer",
      });
    }),
  );
}

export function activate(ctx: ExtensionContext): void {
  registerOpen(ctx);
  registerShowResolved(ctx);
}

export function deactivate(): void {
  // Nothing beyond `ctx.subscriptions` (disposed by the host, Req 2.6) —
  // this extension owns no other resources.
}
