/**
 * The terminal-capability fallback keymap's bundled asset + loader (Req
 * 4.7, design.md §6.5, Task 4.2): `keybindings.fallback.json`, sitting
 * right next to this module, is a plain `KeybindingContribution[]` in the
 * same on-disk shape as the user's `keybindings.json` (`@tecode/api`'s
 * `KeybindingContribution`) — it remaps the handful of default bindings
 * that need a disambiguated modifier a non-Kitty terminal cannot report
 * (`bindingTable.ts`'s `KeymapLayers.fallback` TSDoc: "the terminal-
 * capability overlay... sitting between defaults and extension bindings").
 *
 * **Shipped in the binary, statically imported — no overlay-fs seam
 * needed.** `packages/builtin/themes-default/assets.ts` embeds ITS JSON
 * files behind a filesystem-seam OVERLAY because `ThemeRegistry`'s generic
 * loader resolves a theme's `path` by joining it against the owning
 * extension's directory and calling `fs.readFile` — and a built-in
 * extension has no real directory that call could ever succeed against
 * (that module's TSDoc). This module has no such generic, path-joining
 * loader to intercept: {@link loadFallbackKeybindings} below is a
 * bespoke, one-off loader that already knows exactly which two paths to
 * consult (the bundled asset, the user override) — so it can just
 * `import` the JSON directly. Bun embeds a statically-imported JSON
 * module's contents into the compiled binary at build time regardless of
 * which package does the importing (`themes-default/assets.ts`'s TSDoc
 * makes the same observation), so this achieves "shipped in the binary"
 * with no extra machinery.
 *
 * **User-overridable from `~/.config/tecode/`** (Req 4.7): {@link
 * loadFallbackKeybindings} checks {@link getUserFallbackKeybindingsPath}
 * first — a file there ENTIRELY REPLACES {@link BUNDLED_FALLBACK_KEYBINDINGS}
 * (not merged with it), matching `keybindings.json`'s own whole-file-
 * replace contract over the `defaults` layer, just one layer down
 * (`getUserFallbackKeybindingsPath`'s TSDoc explains why this is a
 * SEPARATE file from `keybindings.json` rather than reusing it). Absent
 * (`ENOENT`) falls back to the bundled asset; any other failure —
 * unreadable file, malformed JSON, or a top-level shape that isn't an
 * array — is reported to `deps.log` and degrades to `[]` (never to the
 * bundled asset in that case: a user file that exists but is broken is
 * far more likely a mistake the user wants to know about than an
 * intentional "give me nothing", but this loader has no `StatusSink` to
 * surface it live — `HostLog` is the best it can do, matching this
 * function's "never throw" contract). {@link loadFallbackKeybindings}
 * itself never throws — every failure path above returns normally.
 *
 * **Not live-reloaded**, unlike `keybindings.json`
 * (`config/service.ts`'s `ConfigServiceFs.watch`): the fallback layer is
 * resolved once, synchronously with the Kitty-capability verdict it rides
 * in on (`packages/cli/src/main.ts`'s `runTecode`), and a terminal's
 * capabilities do not change mid-session — there is nothing to watch for.
 */

import { readFile as nodeReadFile } from "node:fs/promises";
import type { KeybindingContribution } from "@tecode/api";
import type { HostLog } from "../host/errors";
import { getUserFallbackKeybindingsPath } from "../host/paths";
import { parseJsonc } from "../config/jsonc";
import bundledFallbackKeybindingsJson from "./keybindings.fallback.json";

/**
 * The binary's built-in `keybindings.fallback.json` (this module's
 * TSDoc), typed as plain `KeybindingContribution[]` — same "trust nothing
 * from JSON, let `bindingTable.ts`'s `compileEntry` defensively validate
 * every field at build time" posture every other raw-JSON keybinding
 * source in this codebase already has (`keymapState.ts`'s
 * `setUserEntries` TSDoc says the same of `ConfigService`'s raw
 * `keybindings.json` entries).
 */
export const BUNDLED_FALLBACK_KEYBINDINGS: KeybindingContribution[] =
  bundledFallbackKeybindingsJson as KeybindingContribution[];

/**
 * The narrow filesystem seam {@link loadFallbackKeybindings} needs: just
 * reading one file's text (unlike `ConfigServiceFs`, no `watch` — this
 * module's TSDoc's "Not live-reloaded"). Defaults to `node:fs/promises`;
 * tests inject an in-memory fake (matches `config/service.ts`'s
 * `ConfigServiceFs` seam pattern).
 */
export interface FallbackKeybindingsFs {
  readFile(path: string): Promise<string>;
}

function createNodeFallbackKeybindingsFs(): FallbackKeybindingsFs {
  return {
    readFile: (path) => nodeReadFile(path, "utf8"),
  };
}

/** Extract an errno-style `code` (e.g. `"ENOENT"`) from a caught unknown
 * (matches `config/service.ts`'s own `errorCode`, duplicated per this
 * codebase's house style of small, non-shared per-module helpers). */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Render a caught `unknown` as a message string without risking a second
 * throw (matches `config/service.ts`'s/`bindingTable.ts`'s own
 * `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Guarded `log.append` (matches `bindingTable.ts`'s own `logSafely`): an
 * injected log must not be able to break this loader either. */
function logSafely(log: HostLog, message: string): void {
  try {
    log.append("error", { message, path: getUserFallbackKeybindingsPath() });
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

/** Dependencies for {@link loadFallbackKeybindings}. */
export interface LoadFallbackKeybindingsDeps {
  log: HostLog;
  /** Filesystem seam — see {@link FallbackKeybindingsFs}. Defaults to
   * `node:fs/promises`. */
  fs?: FallbackKeybindingsFs;
}

/**
 * Resolve the `fallback` layer's entries (Req 4.7, this module's TSDoc):
 * the user's `~/.config/tecode/keybindings.fallback.json` if present and
 * valid, else {@link BUNDLED_FALLBACK_KEYBINDINGS}. Never throws — see
 * this module's TSDoc for the exact failure-mode table (absent -> bundled
 * asset; anything else wrong -> logged and `[]`).
 */
export async function loadFallbackKeybindings(
  deps: LoadFallbackKeybindingsDeps,
): Promise<KeybindingContribution[]> {
  const fs = deps.fs ?? createNodeFallbackKeybindingsFs();
  const path = getUserFallbackKeybindingsPath();

  let text: string;
  try {
    text = await fs.readFile(path);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") {
      return BUNDLED_FALLBACK_KEYBINDINGS.slice();
    }
    logSafely(deps.log, `Failed to read user fallback keybindings (${path}): ${describeError(cause)}`);
    return [];
  }

  const parsed = parseJsonc<unknown>(text);
  if (!parsed.ok) {
    logSafely(
      deps.log,
      `user fallback keybindings (${path}) line ${parsed.line}, column ${parsed.column}: ${parsed.message}`,
    );
    return [];
  }
  if (!Array.isArray(parsed.value)) {
    logSafely(deps.log, `user fallback keybindings (${path}) must be a JSON array at the top level`);
    return [];
  }

  return parsed.value as KeybindingContribution[];
}
