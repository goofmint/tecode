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
 * Chord sequences (Req 4.4, `ctrl+k ctrl+s`, design.md §6.3) are table
 * keys, not a separate concept: a multi-stroke binding's `key` normalizes
 * to its canonical strokes joined by a single space (e.g.
 * `"ctrl+k ctrl+s"`), so {@link BindingTable.lookup} already resolves a
 * *complete* sequence — the caller (Task 1.6's chord state machine) just
 * needs to hand it the space-joined canonical strokes typed so far.
 * {@link BindingTable.hasSequencePrefix} is the other half: it answers
 * whether a *partial* sequence should keep listening for another stroke
 * (a chord "prefix wins" transition), without the chord machine needing to
 * know anything about how bindings are compiled or stored.
 */

import type { KeybindingContribution } from "@tecode/api";
import type { HostLog } from "../host/errors";
import { normalizeKeySequence } from "./normalize";
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
  /** The extension that contributed this binding, present only when
   * {@link layer} is `"extension"` (Req 11.7, design.md §13's
   * `keybindings.showResolved`: "... source layer (default / fallback /
   * extension id / user) per binding") — copied straight through from
   * `KeybindingContribution.extensionId` (`@tecode/api`'s `manifest.ts`),
   * which `host/registration.ts`'s `registerExtension` is the only thing
   * that ever sets. Always `undefined` for `defaults`/`fallback`/`user`
   * entries — those layers have no notion of an "owning extension" at
   * all. */
  extensionId?: string;
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
  /** Mirrors {@link ResolvedBinding.extensionId} — only ever set when
   * `layer === "extension"` ({@link compileEntry}). */
  extensionId?: string;
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
  /**
   * Whether `sequence` (a space-joined run of canonical strokes typed so
   * far, e.g. `"ctrl+k"`) is a genuine *prefix* of some longer binding —
   * i.e. some registered key starts with `sequence + " "` — and that
   * longer binding is currently visible and when-passing (design.md §6.3:
   * the chord machine only enters *pending* state for a prefix that could
   * actually resolve to something right now).
   *
   * A prefix whose only continuation's `when` clause fails against `get`
   * returns `false` here, exactly as `lookup` would refuse to resolve that
   * continuation — a chord that can never fire under the current context
   * should not make the machine wait for it.
   */
  hasSequencePrefix(sequence: string, get: WhenContextGetter): boolean;
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

  // A prefix index for hasSequencePrefix (design.md §6.3): for every
  // multi-token key (a chord sequence), map each of its proper prefixes —
  // "ctrl+k" and, for a 3+ stroke key, "ctrl+k ctrl+s" too — to the set of
  // full keys that extend it. This is a static fact of the table's key
  // set, so it is computed once here rather than re-scanning every key on
  // every keystroke (hasSequencePrefix runs on the same hot path as
  // lookup). Correctness comes first — this is just a cache of "which full
  // keys start with this prefix", not a decision about `when`, which is
  // still evaluated per call against live context.
  const sequencePrefixIndex = new Map<string, Set<string>>();
  for (const key of byKey.keys()) {
    const tokens = key.split(" ");
    for (let i = 1; i < tokens.length; i++) {
      const prefix = tokens.slice(0, i).join(" ");
      let extensions = sequencePrefixIndex.get(prefix);
      if (!extensions) {
        extensions = new Set();
        sequencePrefixIndex.set(prefix, extensions);
      }
      extensions.add(key);
    }
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

  function hasSequencePrefix(sequence: string, get: WhenContextGetter): boolean {
    const extensions = sequencePrefixIndex.get(sequence);
    if (!extensions) return false;

    for (const key of extensions) {
      const visible = visibleByKey.get(key);
      if (!visible) continue;
      for (const entry of visible) {
        if (passesWhen(entry, get)) return true;
      }
    }
    return false;
  }

  function entries(): ReadonlyMap<string, ResolvedBinding[]> {
    const result = new Map<string, ResolvedBinding[]>();
    for (const [key, visible] of visibleByKey) {
      result.set(key, visible.map(toResolvedBinding));
    }
    return result;
  }

  return { lookup, hasSequencePrefix, entries };
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

  // A key may be a single stroke or a space-joined chord sequence (Req 4.4,
  // design.md §6.3) — normalizeKeySequence handles both, normalizing each
  // stroke independently rather than misparsing the whole string as one.
  const key = normalizeKeySequence(contribution.key);
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
    // Only ever meaningful on the extension layer (`ResolvedBinding.
    // extensionId`'s TSDoc) — deliberately gated on `layer === "extension"`
    // rather than just forwarding `contribution.extensionId` unconditionally,
    // so a `defaults`/`fallback`/`user` entry can never surface an
    // `extensionId` here even if its raw JSON happened to carry a stray
    // one (`keybindings.json` is user-authored, untyped input).
    extensionId: layer === "extension" ? contribution.extensionId : undefined,
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
  if (entry.extensionId !== undefined) {
    resolved.extensionId = entry.extensionId;
  }
  return resolved;
}
