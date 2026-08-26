/**
 * Bundled keybinding presets (Req 4.8, design.md §6.6; Issue #81
 * Phase 2, 「例として、Emacsキーバインド...Windows風キーバインドのファイルを
 * 用意してほしい」): `presets/emacs.json` and `presets/windows.json`, sitting
 * right next to this module, are each a plain `KeybindingContribution[]` in
 * the same on-disk shape as the user's `keybindings.json` — exactly
 * `fallbackKeybindings.ts`'s own `keybindings.fallback.json` pattern, just
 * one preset name away from a fourth (vim) that this issue's author
 * explicitly asked NOT be built: a non-modal `"vim"` preset would be
 * misleading, since this codebase's `when` contexts (`editorTextFocus`,
 * `editorFocus`, `quickPickFocus`, `inputBoxFocus`, `findWidgetFocus`,
 * `explorerFocus`, `editorLangId`) are purely focus-based, with no mode
 * concept for a modal keymap to hook into.
 *
 * **Shipped in the binary, statically imported — no overlay-fs seam
 * needed, and no user-override seam either** (unlike
 * `fallbackKeybindings.ts`'s `loadFallbackKeybindings`, which checks
 * `~/.config/tecode/keybindings.fallback.json` first): a preset is
 * selected, not authored — {@link resolveKeybindingPreset} below is a pure
 * `name -> entries` lookup with nothing to read from disk, so there is
 * nothing that could ever be ENOENT or malformed the way a real user file
 * could be. `fallbackKeybindings.ts`'s own TSDoc explains why Bun embeds a
 * statically-imported JSON module's contents into the compiled binary at
 * build time regardless of which package does the importing — this module
 * relies on the exact same fact for {@link EMACS_KEYBINDING_PRESET}/
 * {@link WINDOWS_KEYBINDING_PRESET}.
 *
 * **A user who wants to tweak a preset still has the normal escape
 * hatch**: `keybindings.json` (the `user` layer) sits above `preset` in
 * `bindingTable.ts`'s `LAYER_ORDER`, so any entry here can be overridden or
 * `-command`-removed from there exactly like a `defaults`/`fallback`/
 * `extension` entry — no separate per-preset override file is needed the
 * way `fallbackKeybindings.ts` provides one for the terminal-capability
 * overlay (that overlay has no `keybindings.json`-editing user in the loop
 * at the moment it's chosen; a preset's user very much does).
 *
 * ## Preset content — what's bound and why
 *
 * **`emacs`** (`presets/emacs.json`) binds the handful of Emacs chords a
 * long-time Emacs user reaches for reflexively, onto `editor-core`'s real
 * commands (Req 4.8): `ctrl+a`/`ctrl+e` (`move-beginning-of-line`/
 * `move-end-of-line` -> `cursorHome`/`cursorEnd`), `ctrl+f`/`ctrl+b`/
 * `ctrl+n`/`ctrl+p` (`forward-char`/`backward-char`/`next-line`/
 * `previous-line` -> `cursorRight`/`cursorLeft`/`cursorDown`/`cursorUp`),
 * `alt+f`/`alt+b` (`forward-word`/`backward-word` -> `cursorWordRight`/
 * `cursorWordLeft`), `ctrl+k` (`kill-line`, approximated as
 * `editor.action.deleteLine` — there is no kill-ring/yank concept in this
 * editor to model a true "kill" with), `ctrl+s` (`isearch-forward`,
 * approximated as `editor.action.find` — the closest existing command),
 * and `ctrl+x ctrl+s` (`save-buffer` -> `editor.action.save`, a brand-new
 * chord; nothing else in any built-in manifest claims `ctrl+x` as a first
 * stroke). Deliberately NOT bound: undo (Emacs's own `ctrl+/`/`ctrl+x u`
 * would collide with `editor-core`'s `toggleLineComment`/introduce a
 * second `ctrl+x` chord family for one binding) and yank/kill-ring
 * navigation (no backing command exists) — "fewer, correct bindings" over
 * a large half-right set.
 *
 * **Three DELIBERATE collisions with existing higher-*visibility* (not
 * higher-*precedence* — `preset` outranks `extension` per
 * `bindingTable.ts`'s `KeymapLayers` TSDoc) bindings**, each an intentional
 * "that's the point of a preset" override, each scoped to
 * `editorTextFocus` so the overridden command still works everywhere
 * else:
 * - `ctrl+f`: `editor-core`'s own default (`editor.action.find`) is
 *   shadowed by Emacs's `forward-char` while a text buffer is focused;
 *   Emacs's own find analog moves to `ctrl+s` instead.
 * - `ctrl+s`: `editor-core`'s own default (`editor.action.save`) is
 *   shadowed by Emacs's `isearch-forward`; save moves to the `ctrl+x
 *   ctrl+s` chord instead, matching real Emacs.
 * - `ctrl+p`: `command-palette`'s own default (`workbench.action.
 *   quickOpen`, bound with NO `when` clause at all — always visible) is
 *   shadowed by Emacs's `previous-line` specifically while a text buffer
 *   is focused; `workbench.action.quickOpen` still fires on `ctrl+p`
 *   everywhere else (any other focus state), since the preset's own entry
 *   fails its `editorTextFocus` clause there and `lookup` falls through.
 *
 * **One more, structural rather than a keymap choice — the
 * `ctrl+k ctrl+s` chord-shadowing hazard**: `keybindings-editor`'s manifest
 * binds `ctrl+k ctrl+s` -> `keybindings.open` with NO `when` clause (always
 * visible). `chords.ts`'s `handleIdleStroke` checks
 * `BindingTable.hasSequencePrefix` UNCONDITIONALLY, before ever trying an
 * exact-match `lookup` ("prefix wins", design.md §6.3) — so as long as
 * that chord is registered and visible, EVERY bare `ctrl+k` keystroke
 * enters chord-pending state first, and Emacs's own `ctrl+k` ->
 * `deleteLine` binding above would NEVER fire; the user would just see a
 * `(ctrl+k)` pending indicator that times out after 3 seconds (or resolves
 * to "open keybindings.json" if they happen to follow up with `ctrl+s`).
 * `presets/emacs.json`'s trailing `{ "key": "ctrl+k ctrl+s", "command":
 * "-keybindings.open" }` entry removes that chord outright, which is what
 * makes `ctrl+k` resolve directly again. This removal is EXACTLY why
 * `preset` must sit ABOVE `extension` in `LAYER_ORDER`
 * (`bindingTable.ts`'s `KeymapLayers` TSDoc, `visibleEntries`'s own
 * "a removal masks only STRICTLY LOWER `order` bindings" rule) — verified
 * directly by `packages/cli/src/keybindingPresets.test.ts`'s
 * `handleStroke("ctrl+k")` test, which presses the real chord machine
 * rather than merely checking the table for an entry.
 *
 * **`windows`** (`presets/windows.json`) is deliberately small, and says so
 * rather than padding itself: this codebase's defaults are already
 * VS-Code-on-Windows/Linux-shaped (Ctrl-based shortcuts throughout), so
 * there is little left to change. The one real, verified divergence in the
 * shipped defaults is `editor-core/manifest.ts`'s move/duplicate-line
 * bindings, which use `alt+meta+up`/`alt+meta+down`/`shift+alt+meta+down`
 * — a macOS idiom (`meta` = Cmd; that manifest's own TSDoc explains why an
 * Alt-held arrow always carries BOTH the `alt` and `meta` tokens on this
 * terminal input pipeline). VS Code's real Windows/Linux defaults for the
 * same three actions omit the Cmd/meta modifier entirely: `alt+up`/
 * `alt+down`/`shift+alt+down`. This preset ADDS those three keys for the
 * same three commands (not a `-command` removal — the meta-flavored keys
 * stay bound too, harmlessly unreachable on a real Windows/Linux terminal
 * since there is no meta key to hold) rather than any User-facing rename;
 * everything else in the default keymap (Ctrl+S/Ctrl+F/Ctrl+Z/Ctrl+Shift+K/
 * arrows/Home/End/Tab/...) already matches Windows/Linux convention with
 * no divergence to bind.
 */

import type { KeybindingContribution } from "@tecode/api";
import type { HostLog } from "../host/errors";
import emacsPresetJson from "./presets/emacs.json";
import windowsPresetJson from "./presets/windows.json";

/**
 * `presets/emacs.json`'s entries, typed as plain `KeybindingContribution[]`
 * — same "trust nothing from JSON, let `bindingTable.ts`'s `compileEntry`
 * defensively validate every field at build time" posture every other raw
 * keybinding source in this codebase has (`fallbackKeybindings.ts`'s
 * `BUNDLED_FALLBACK_KEYBINDINGS` TSDoc says the same). See this module's
 * TSDoc for the full rationale behind every binding.
 */
export const EMACS_KEYBINDING_PRESET: KeybindingContribution[] =
  emacsPresetJson as KeybindingContribution[];

/**
 * `presets/windows.json`'s entries, typed as plain `KeybindingContribution[]`
 * — same posture as {@link EMACS_KEYBINDING_PRESET}. See this module's
 * TSDoc for why this preset is intentionally small.
 */
export const WINDOWS_KEYBINDING_PRESET: KeybindingContribution[] =
  windowsPresetJson as KeybindingContribution[];

/**
 * Every valid `keybindings.preset` setting value (Req 4.8, design.md
 * §6.6), in no particular order — `"default"` is the explicit no-op
 * (`resolveKeybindingPreset` returns `[]` for it, same as for any unknown
 * name, just silently rather than with a warning). Exported so
 * `config/coreDefaults.ts`'s schema registration and tests can enumerate
 * the real set rather than duplicating a literal list that could drift.
 */
export const KEYBINDING_PRESET_NAMES = ["default", "emacs", "windows"] as const;

/** One valid `keybindings.preset` value — see {@link KEYBINDING_PRESET_NAMES}. */
export type KeybindingPresetName = (typeof KEYBINDING_PRESET_NAMES)[number];

/** The `keybindings.preset` schema default (Req 4.8) — no preset active,
 * `resolveKeybindingPreset` returns `[]`. Duplicated as a literal
 * `"default"` string in `config/coreDefaults.ts` rather than imported
 * there, matching that module's own `DEFAULT_COLOR_THEME_ID` precedent:
 * `config/` has no existing import from `keymap/` (only the reverse,
 * `fallbackKeybindings.ts`'s `../config/jsonc`), and this single-string
 * duplication is far cheaper than introducing a new reverse edge between
 * the two for one literal. Kept in sync with
 * `config/coreDefaults.ts`'s own default by
 * `packages/cli/src/keybindingPresets.test.ts`, which asserts against
 * BOTH constants rather than trusting them to agree by inspection. */
export const DEFAULT_KEYBINDING_PRESET_NAME: KeybindingPresetName = "default";

function isKeybindingPresetName(value: string): value is KeybindingPresetName {
  return (KEYBINDING_PRESET_NAMES as readonly string[]).includes(value);
}

/** Guarded `log.append` (matches `fallbackKeybindings.ts`'s own
 * `logSafely`): an injected log must not be able to break this loader. */
function logSafely(log: HostLog, message: string): void {
  try {
    log.append("warning", { message });
  } catch {
    // Swallowed: reporting a reporting failure has nowhere left to go.
  }
}

/** Dependencies for {@link resolveKeybindingPreset}. */
export interface ResolveKeybindingPresetDeps {
  log: HostLog;
}

/**
 * Resolve the `preset` layer's entries for the given `keybindings.preset`
 * setting value (Req 4.8, design.md §6.6). `"default"` — the schema
 * default — and any name this module does not recognize both resolve to
 * `[]`, the only difference being that an unrecognized name is reported to
 * `deps.log` first (a typo'd setting value is a silently-dead preset
 * otherwise, worth surfacing; `"default"` is the deliberate, expected
 * no-op and logging it would just be noise on every normal startup).
 * Synchronous and NEVER throws — there is no filesystem or JSON parsing
 * involved at all (this module's TSDoc's "nothing to read from disk"), so
 * every path here is a plain, already-known-valid array lookup. Always
 * returns a fresh array (`.slice()`) — callers (`cli/keymapState.ts`'s
 * `setPresetEntries`) are free to treat the result as owned.
 */
export function resolveKeybindingPreset(
  name: string,
  deps: ResolveKeybindingPresetDeps,
): KeybindingContribution[] {
  if (name === DEFAULT_KEYBINDING_PRESET_NAME) return [];

  if (!isKeybindingPresetName(name)) {
    logSafely(
      deps.log,
      `Unknown keybindings.preset "${name}" — expected one of ${KEYBINDING_PRESET_NAMES.join(", ")}. Falling back to no preset.`,
    );
    return [];
  }

  // `name` is now narrowed to `KeybindingPresetName`, but `"default"` was
  // already handled (and returned) above — these two `if`s, not a
  // `switch`, avoid a spurious "not all code paths return" complaint from
  // an exhaustiveness check that can't see the earlier early return.
  if (name === "emacs") return EMACS_KEYBINDING_PRESET.slice();
  if (name === "windows") return WINDOWS_KEYBINDING_PRESET.slice();
  return [];
}
