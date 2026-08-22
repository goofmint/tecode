/**
 * The layered keybinding table (Req 4.1-4.3, design.md §6.2: "At load time
 * the service builds a single ordered binding table from three layers:
 * core defaults, then extension manifest bindings, then user
 * `keybindings.json`"). Task 1.5 adds a fourth layer ahead of defaults —
 * the terminal-capability fallback keymap (Req 4.7, design.md §6.5),
 * populated starting Task 4.2 but already part of the shape here so
 * callers don't need to migrate later.
 *
 * `when` clauses are compiled once at build time via {@link compileWhen}
 * (design.md §6.2, §6.4: "Clauses are parsed once at registration into an
 * AST") rather than evaluated through an injected predicate — this table
 * owns compilation and only ever evaluates already-known-valid ASTs on
 * lookup.
 *
 * Chord sequences (Req 4.4, `ctrl+k ctrl+s`) are out of scope here (Task
 * 1.6); this table resolves single strokes. The table key is nonetheless a
 * plain string so a future 2-stroke canonical sequence (e.g.
 * `"ctrl+k ctrl+s"`, strokes joined by a space after each is normalized)
 * can become a key without changing this table's shape.
 */

import type { KeybindingContribution } from "@tecode/api";
import type { HostLog } from "../host/errors";
import { normalizeKey } from "./normalize";
import { compileWhen, WhenParseError, type CompiledWhen, type WhenContextGetter } from "./when";

/** The four binding layers, in ascending precedence order (design.md §6.2,
 * §6.5): defaults < fallback < extension < user. `fallback` is the
 * terminal-capability overlay (Req 4.7) — legitimately empty until it is
 * populated in Task 4.2, so every layer is required here rather than
 * optional, keeping precedence order a fact about array position, not
 * about which fields happen to be present. */
export interface KeymapLayers {
  /** Core default bindings. */
  defaults: KeybindingContribution[];
  /** The terminal-capability fallback overlay (Req 4.7), sitting between
   * defaults and extension bindings (design.md §6.5) — may be empty until
   * Task 4.2 wires real fallback detection. */
  fallback: KeybindingContribution[];
  /** Bindings contributed by extension manifests (`contributes.keybindings`). */
  extension: KeybindingContribution[];
  /** The user's `keybindings.json` entries — highest precedence. */
  user: KeybindingContribution[];
}

/** The layer a resolved binding (or `entries()` row) came from. */
export type BindingLayer = "defaults" | "fallback" | "extension" | "user";

/** Dependencies {@link createBindingTable} reports through rather than
 * owning directly (design.md §5, §14) — a structured log for skipped,
 * invalid entries. */
export interface BindingTableDeps {
  log: HostLog;
}

/** One binding resolved by {@link BindingTable.lookup}: enough to execute
 * the command and, later, to show the user where it came from
 * (`keybindings.showResolved`, Req 11.7). */
export interface ResolvedBinding {
  /** The command to execute. */
  command: string;
  /** The canonical stroke this binding is registered under. */
  key: string;
  /** Which layer contributed the winning binding. */
  layer: BindingLayer;
  /** The binding's own `when` clause source, if it had one — useful for
   * display, not needed for evaluation (already applied by `lookup`). */
  when?: string;
}

/** One compiled, ordered entry in the internal per-key list. Not exported;
 * {@link ResolvedBinding} and {@link entries} project the public subset. */
interface CompiledEntry {
  /** Monotonically increasing across all layers in precedence order —
   * higher wins. Doubles as an equality-free tiebreaker/removal boundary. */
  order: number;
  layer: BindingLayer;
  key: string;
  /** The command name, with any leading `"-"` (removal marker) already
   * stripped — `isRemoval` carries that fact instead. */
  command: string;
  isRemoval: boolean;
  when?: string;
  compiledWhen?: CompiledWhen;
}

/** The layered keybinding table's public shape. */
export interface BindingTable {
  /**
   * Resolve `canonicalStroke` against the current context. Among all
   * non-removal, non-masked entries registered under that exact key,
   * returns the highest-precedence one whose `when` clause (if any)
   * evaluates true against `get` — or `undefined` if none match.
   *
   * `canonicalStroke` must already be in {@link normalizeKey}'s canonical
   * form; `lookup` does not re-normalize (bindings were normalized once at
   * build time, and the caller — the input pipeline, a later task — is
   * expected to normalize the live key event the same way).
   */
  lookup(canonicalStroke: string, get: WhenContextGetter): ResolvedBinding | undefined;
  /** Enumerate every visible (non-removal, non-masked) binding, grouped by
   * canonical key, in ascending precedence order per key. Feeds
   * `keybindings.showResolved` (Req 11.7) — no `when` filtering here,
   * since that command wants to show what's registered, not what's active
   * right now. */
  entries(): ReadonlyMap<string, ResolvedBinding[]>;
}

/** Render a caught `unknown` value as a message string, mirroring the
 * command registry's `describeError` (design.md §5) — a bad `when` clause
 * must be reported, never allowed to throw past this module. */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Guarded `log.append` — an injected log must not be able to break table
 * construction, matching the command registry's `logSafely` (design.md §5). */
function logSafely(log: HostLog, level: "error" | "warning", message: string): void {
  try {
    log.append(level, { message });
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

const LAYER_ORDER: readonly BindingLayer[] = ["defaults", "fallback", "extension", "user"];

/**
 * Build the layered keybinding table (Req 4.1-4.3, design.md §6.2).
 * Concatenates `layers` in precedence order, normalizes every
 * contribution's `key` via {@link normalizeKey}, compiles every `when`
 * clause once via {@link compileWhen}, and groups the result per canonical
 * key. Invalid entries — empty key, empty command, or a `when` clause that
 * fails to parse — are reported to `deps.log` at `"warning"` and skipped;
 * `createBindingTable` itself never throws.
 */
export function createBindingTable(
  layers: KeymapLayers,
  deps: BindingTableDeps,
): BindingTable {
  const { log } = deps;
  const byKey = new Map<string, CompiledEntry[]>();

  let order = 0;
  for (const layer of LAYER_ORDER) {
    for (const contribution of layers[layer]) {
      order += 1;
      const entry = compileEntry(contribution, layer, order, log);
      if (!entry) continue;
      const bucket = byKey.get(entry.key);
      if (bucket) {
        bucket.push(entry);
      } else {
        byKey.set(entry.key, [entry]);
      }
    }
  }

  // Masking is a static fact of the built table — precompute each key's
  // visible entries once so lookup (which runs on every keystroke) is a
  // plain array scan with no per-call Map/array allocation.
  const visibleByKey = new Map<string, CompiledEntry[]>();
  for (const [key, bucket] of byKey) {
    visibleByKey.set(key, visibleEntries(bucket));
  }

  function lookup(canonicalStroke: string, get: WhenContextGetter): ResolvedBinding | undefined {
    const visible = visibleByKey.get(canonicalStroke);
    if (!visible) return undefined;

    // Highest precedence first; visibleEntries preserves ascending `order`,
    // so scan from the end.
    for (let i = visible.length - 1; i >= 0; i--) {
      const entry = visible[i] as CompiledEntry;
      if (passesWhen(entry, get)) {
        return toResolvedBinding(entry);
      }
    }
    return undefined;
  }

  function entries(): ReadonlyMap<string, ResolvedBinding[]> {
    const result = new Map<string, ResolvedBinding[]>();
    for (const [key, visible] of visibleByKey) {
      result.set(key, visible.map(toResolvedBinding));
    }
    return result;
  }

  return { lookup, entries };
}

/** Compile one manifest/keybindings.json entry into a {@link CompiledEntry},
 * or `undefined` (after logging) if it is invalid. */
function compileEntry(
  contribution: KeybindingContribution,
  layer: BindingLayer,
  order: number,
  log: HostLog,
): CompiledEntry | undefined {
  // Runtime type guards: KeybindingContribution is a compile-time type only —
  // entries come from JSON (keybindings.json, manifests) with no validation
  // yet, so a missing/non-string field must be skipped, not thrown on.
  if (typeof contribution.key !== "string") {
    logSafely(
      log,
      "warning",
      `Skipping ${layer} keybinding with a non-string key`,
    );
    return undefined;
  }
  if (typeof contribution.command !== "string") {
    logSafely(
      log,
      "warning",
      `Skipping ${layer} keybinding on "${contribution.key}" with a non-string command`,
    );
    return undefined;
  }

  const key = normalizeKey(contribution.key);
  if (key.length === 0) {
    logSafely(
      log,
      "warning",
      `Skipping ${layer} keybinding with an empty key (command "${contribution.command}")`,
    );
    return undefined;
  }

  const rawCommand = contribution.command;
  const isRemoval = rawCommand.startsWith("-");
  const command = isRemoval ? rawCommand.slice(1) : rawCommand;
  if (command.length === 0) {
    logSafely(
      log,
      "warning",
      `Skipping ${layer} keybinding on "${key}" with an empty command`,
    );
    return undefined;
  }

  // Conditional removals are not supported in the MVP: masking is computed
  // once at build time (Req 4.3 only requires unconditional `-command`
  // removal), so a removal whose `when` might be false cannot be honored
  // correctly — skip it loudly rather than mask default bindings forever.
  if (isRemoval && contribution.when !== undefined) {
    logSafely(
      log,
      "warning",
      `Skipping ${layer} removal of "${command}" on "${key}": conditional removals (when clauses on -command entries) are not supported`,
    );
    return undefined;
  }

  let compiledWhen: CompiledWhen | undefined;
  if (contribution.when !== undefined) {
    try {
      compiledWhen = compileWhen(contribution.when);
    } catch (err) {
      const reason = err instanceof WhenParseError ? err.message : describeError(err);
      logSafely(
        log,
        "warning",
        `Skipping ${layer} keybinding on "${key}" (command "${command}"): ${reason}`,
      );
      return undefined;
    }
  }

  return {
    order,
    layer,
    key,
    command,
    isRemoval,
    when: contribution.when,
    compiledWhen,
  };
}

/** Whether `entry`'s `when` clause (if any) passes against `get`. No
 * `when` always passes (design.md §6.4). */
function passesWhen(entry: CompiledEntry, get: WhenContextGetter): boolean {
  if (!entry.compiledWhen) return true;
  return entry.compiledWhen.evaluate(get);
}

/**
 * Filter a per-key bucket (already in ascending `order`) down to the
 * non-removal entries that are not masked by a later removal record of
 * the same command (design.md §6.2, Req 4.3): a removal `-x` masks
 * earlier (lower-`order`) bindings of command `x` on that key; a binding
 * of `x` registered *after* the removal is unaffected. Removal of one
 * command never touches other commands on the same key.
 */
function visibleEntries(bucket: CompiledEntry[]): CompiledEntry[] {
  // Highest order-index removal per command "masks" every strictly lower
  // order-index binding of that same command.
  const latestRemovalOrder = new Map<string, number>();
  for (const entry of bucket) {
    if (entry.isRemoval) {
      const current = latestRemovalOrder.get(entry.command);
      if (current === undefined || entry.order > current) {
        latestRemovalOrder.set(entry.command, entry.order);
      }
    }
  }

  return bucket.filter((entry) => {
    if (entry.isRemoval) return false;
    const removalOrder = latestRemovalOrder.get(entry.command);
    if (removalOrder === undefined) return true;
    return entry.order > removalOrder;
  });
}

/** Project a {@link CompiledEntry} to the public {@link ResolvedBinding}. */
function toResolvedBinding(entry: CompiledEntry): ResolvedBinding {
  const resolved: ResolvedBinding = {
    command: entry.command,
    key: entry.key,
    layer: entry.layer,
  };
  if (entry.when !== undefined) {
    resolved.when = entry.when;
  }
  return resolved;
}
