/**
 * Completeness test for `@tecode/core`'s `keymap/keybindings.fallback.json`
 * (Req 4.7, 13.3; design.md §6.5; Task 4.2's completion requirement "Every
 * default binding that requires the Kitty protocol has a fallback entry").
 *
 * ## Which bindings actually need a fallback entry — and which do NOT
 *
 * A naive reading of Req 4.7 ("terminal capability... fallback keymap...
 * remaps bindings that need disambiguated modifiers") might assume every
 * `ctrl+shift+*` default needs one, including the modified-arrow/Home/End
 * family (`ctrl+shift+left`/`right`/`home`/`end`, `editor-core/
 * manifest.ts`). **That assumption is wrong, and this test deliberately
 * does NOT flag those.** A legacy (non-Kitty) terminal reports a modified
 * arrow/Home/End key via the traditional CSI-with-modifier-parameter form
 * (`\x1b[1;{n}A`-style — `tabCommands.ts`'s TSDoc verifies the sibling
 * `ctrl+pagedown`/`ctrl+pageup` case against this exact form), which
 * carries an explicit numeric modifier bitmask INCLUDING the Shift bit —
 * fully distinguishable from `ctrl+left` with no Kitty protocol involved
 * at all. The genuinely lossy encoding — a raw single-byte `Ctrl+<char>`
 * control code, computed by clearing bits 5-6 of the character's own ASCII
 * value — only applies to LETTER keys and to Tab specifically
 * (`editor-core/manifest.ts`'s "ctrl+shift+<letter> combos are UNSAFE"
 * paragraph; `tabCommands.ts`'s "Ctrl+Tab / Ctrl+Shift+Tab collapse into
 * plain Tab" paragraph) — arrows/Home/End were never at risk in the first
 * place. `keyRouting.test.ts` (~line 230+) already pins this exact
 * distinction empirically against the real vendored `@opentui/core` key
 * parser for the letter case.
 *
 * So the true hazard set this test enumerates PROGRAMMATICALLY (not by
 * copying a list into this comment, which could silently drift from the
 * real manifests) is exactly:
 *
 * - `ctrl+shift+<single letter>` (a raw `Ctrl+<letter>` control byte
 *   discards case/shift entirely).
 * - `ctrl+tab` (collapses to the identical raw byte plain Tab sends).
 * - `ctrl+shift+tab` (has no legacy raw-byte encoding at all — silently
 *   unreachable, not merely ambiguous — but the same "needs a
 *   distinguishable alternate" fix applies).
 *
 * For each hazard, this test requires ONE of two remedies to already be in
 * place, mirroring how the ones that already have a fix were actually
 * fixed:
 *
 * 1. **An unambiguous alternate already lives in the `defaults`/`extension`
 *    layer**, bound to the exact same command, on a key that is NOT itself
 *    one of these three hazard shapes — `ctrl+/`'s `ctrl+_` dual binding,
 *    `redo`'s `ctrl+y`, `tab.next`/`tab.previous`'s `ctrl+pagedown`/
 *    `ctrl+pageup` (`editor-core/manifest.ts`, `tabCommands.ts`). No
 *    fallback-keymap entry is needed for these — Task 4.2's fallback layer
 *    would just be redundant with a fix that already existed before this
 *    task, per `command-palette/manifest.ts`'s own TSDoc, which names
 *    Task 4.2 as "the intended, more general fix" for the ones that did
 *    NOT already have one.
 * 2. **`keybindings.fallback.json` covers it** — bound to the same
 *    command via yet another different, non-colliding key. This is the
 *    genuinely uncovered set this task adds: `ctrl+shift+p`
 *    (`workbench.action.showCommands` — collides with `ctrl+p`'s
 *    `workbench.action.quickOpen`, a REAL collision, not just an
 *    unreachable key), `ctrl+shift+e` (`explorer.focus` — `ctrl+e` itself
 *    is unclaimed, so the fallback entry is simply that same unclaimed
 *    key bound directly), and `ctrl+shift+k` (`editor.action.deleteLine`
 *    — `ctrl+k` is nothing today, but is the design's own reserved
 *    chord-prefix example (`KeybindingContribution`'s TSDoc's
 *    `"ctrl+k ctrl+s"`), so the fallback entry deliberately picks a
 *    DIFFERENT key rather than squatting that namespace with a
 *    single-stroke command).
 *
 * **Deviation from design.md §6.5's own literal example** —
 * `ctrl+shift+p -> ctrl+p p` — worth flagging explicitly: `chords.ts`'s
 * `handleIdleStroke` checks `hasSequencePrefix` BEFORE an exact-match
 * `lookup`, unconditionally ("Prefix wins over a simultaneous
 * single-stroke exact match"). Registering a `"ctrl+p p"` chord would
 * therefore make EVERY bare `ctrl+p` keystroke enter pending state first,
 * permanently breaking `ctrl+p`'s own direct `workbench.action.quickOpen`
 * binding for as long as the fallback layer is active — a real
 * regression, not a hypothetical one. `keybindings.fallback.json` uses a
 * plain, non-chord, non-colliding single-stroke alternate instead
 * (`ctrl+g`) for exactly this reason.
 */

import { expect, test } from "bun:test";
import type { KeybindingContribution } from "@tecode/api";
import { BUNDLED_FALLBACK_KEYBINDINGS, MODAL_DEFAULT_KEYBINDINGS, TAB_DEFAULT_KEYBINDINGS } from "@tecode/core";
import { builtinManifests } from "@tecode/builtin";

/** Every keybinding that lands in the `defaults` or `extension` layer in
 * a real run (`main.ts`'s `buildAssemblyRoot`/`runDeferredPhase`): the two
 * core-owned defaults arrays plus every built-in manifest's
 * `contributes.keybindings`. Deliberately mirrors `main.ts`'s own
 * composition exactly (same two constants, same `builtinManifests`
 * aggregate) rather than hand-copying key strings, so this test tracks
 * the real manifests, not a snapshot of them. */
const ALL_NON_FALLBACK_KEYBINDINGS: KeybindingContribution[] = [
  ...MODAL_DEFAULT_KEYBINDINGS,
  ...TAB_DEFAULT_KEYBINDINGS,
  ...builtinManifests.flatMap((manifest) => manifest.contributes.keybindings ?? []),
];

/** A single-stroke `ctrl+shift+<letter>` key, e.g. `"ctrl+shift+p"` —
 * NOT `"ctrl+shift+left"`/`"ctrl+shift+home"` etc. (this module's TSDoc's
 * "which bindings actually need a fallback entry" section: the `[a-z]$`
 * anchor matches exactly one trailing letter, so a multi-character key
 * name like `left`/`home`/`tab` never matches this pattern). */
const CTRL_SHIFT_LETTER = /^ctrl\+shift\+[a-z]$/;

/** The three genuinely-ambiguous key SHAPES on a non-Kitty terminal (this
 * module's TSDoc) — `ctrl+tab`/`ctrl+shift+tab` checked as exact strings
 * since Tab has no single-letter form for {@link CTRL_SHIFT_LETTER} to
 * catch. */
function isHazardKey(key: string): boolean {
  return CTRL_SHIFT_LETTER.test(key) || key === "ctrl+tab" || key === "ctrl+shift+tab";
}

interface Hazard {
  key: string;
  command: string;
}

const hazards: Hazard[] = ALL_NON_FALLBACK_KEYBINDINGS.filter((entry) => isHazardKey(entry.key)).map(
  (entry) => ({ key: entry.key, command: entry.command }),
);

test("sanity: scanning the real manifests actually finds hazard keys (the test isn't vacuously passing)", () => {
  expect(hazards.length).toBeGreaterThan(0);
});

test("the enumerated hazard set matches Fact 4's expected list exactly (a change here needs deliberate review)", () => {
  const sorted = hazards.map((h) => `${h.key} -> ${h.command}`).sort();
  expect(sorted).toEqual(
    [
      "ctrl+shift+e -> explorer.focus",
      "ctrl+shift+k -> editor.action.deleteLine",
      "ctrl+shift+p -> workbench.action.showCommands",
      "ctrl+shift+tab -> tab.previous",
      "ctrl+shift+z -> editor.action.redo",
      "ctrl+tab -> tab.next",
    ].sort(),
  );
});

test("every hazard has EITHER an unambiguous defaults/extension-layer alternate for the same command, OR a keybindings.fallback.json entry for it", () => {
  const uncovered: string[] = [];

  for (const hazard of hazards) {
    const hasUnambiguousAlternate = ALL_NON_FALLBACK_KEYBINDINGS.some(
      (entry) =>
        entry.command === hazard.command && entry.key !== hazard.key && !isHazardKey(entry.key),
    );
    const hasFallbackEntry = BUNDLED_FALLBACK_KEYBINDINGS.some(
      (entry) => entry.command === hazard.command,
    );

    if (!hasUnambiguousAlternate && !hasFallbackEntry) {
      uncovered.push(`${hazard.key} -> ${hazard.command}`);
    }
  }

  expect(uncovered).toEqual([]);
});

test("every keybindings.fallback.json entry's own key is itself unambiguous (not another hazard shape, not a chord starting with an already-claimed single-stroke prefix)", () => {
  const singleStrokeDefaultKeys = new Set(
    ALL_NON_FALLBACK_KEYBINDINGS.filter((entry) => !entry.key.includes(" ")).map((entry) => entry.key),
  );

  for (const entry of BUNDLED_FALLBACK_KEYBINDINGS) {
    expect(isHazardKey(entry.key)).toBe(false);

    // A chord's first stroke must not coincide with any key that already
    // has its OWN single-stroke binding elsewhere in the defaults/
    // extension layers — `chords.ts`'s "prefix wins" rule means a chord
    // sharing a prefix with an existing single-stroke binding would
    // silently swallow that binding's direct resolution (this module's
    // TSDoc's "Deviation from design.md §6.5" paragraph is exactly this
    // hazard, caught here structurally so it can never come back).
    const firstStroke = entry.key.split(" ")[0]!;
    if (entry.key.includes(" ")) {
      expect(singleStrokeDefaultKeys.has(firstStroke)).toBe(false);
    }
  }
});

test("no two keybindings.fallback.json entries claim the same key (no self-collision)", () => {
  const keys = BUNDLED_FALLBACK_KEYBINDINGS.map((entry) => entry.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("no keybindings.fallback.json entry's key collides with an EXISTING defaults/extension-layer single-stroke key bound to a DIFFERENT command", () => {
  const byKey = new Map<string, string>();
  for (const entry of ALL_NON_FALLBACK_KEYBINDINGS) {
    if (!entry.key.includes(" ")) byKey.set(entry.key, entry.command);
  }

  for (const entry of BUNDLED_FALLBACK_KEYBINDINGS) {
    const existingCommand = byKey.get(entry.key);
    if (existingCommand !== undefined) {
      expect(existingCommand).toBe(entry.command);
    }
  }
});
