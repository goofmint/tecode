/**
 * Key-string normalization (Req 4.1-4.3, design.md §6.2: "Lookup normalizes
 * key strings (`ctrl+shift+p` — order-insensitive modifiers, lowercase key)
 * into a canonical form used as the table key"). {@link normalizeKey} turns
 * any VS Code-style key string into that canonical form so bindings
 * contributed with different modifier order/case/aliases (`Shift+Ctrl+P`,
 * `ctrl+shift+p`, `control+shift+p`) collapse onto the same
 * {@link createBindingTable} entry.
 *
 * `normalizeKey` operates on a single stroke; {@link normalizeKeySequence}
 * (Req 4.4, Task 1.6) is the multi-stroke chord counterpart — it splits on
 * whitespace and normalizes each stroke independently, exactly as this
 * comment always said a sequence-aware caller must.
 */

/** Fixed modifier ordering for the canonical form (design.md §6.2). Known
 * modifiers sort into this order; anything else (an unrecognized modifier
 * token, kept rather than dropped so normalization never silently loses
 * input) sorts after, in first-seen order. */
const MODIFIER_ORDER = ["ctrl", "shift", "alt", "meta"] as const;

/** Minimal alias table (task 1.5's brief: "minimal set") mapping the VS
 * Code/Electron modifier spellings tecode also accepts onto the four
 * canonical modifier names. */
const MODIFIER_ALIASES: Record<string, string> = {
  control: "ctrl",
  cmd: "meta",
  command: "meta",
  option: "alt",
};

/** Rank a (already-aliased, lowercased) modifier token for sorting: its
 * index in {@link MODIFIER_ORDER}, or `+Infinity` to push unrecognized
 * tokens after the four known ones. */
function modifierRank(modifier: string): number {
  const index = MODIFIER_ORDER.indexOf(modifier as (typeof MODIFIER_ORDER)[number]);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/** Lowercase and alias-map one modifier token. */
function canonicalizeModifier(token: string): string {
  const lower = token.toLowerCase();
  return MODIFIER_ALIASES[lower] ?? lower;
}

/** Deduplicate and sort a list of already-canonicalized modifier tokens
 * into {@link MODIFIER_ORDER} (stable for unrecognized tokens, so repeated
 * normalization is idempotent). */
function sortModifiers(modifiers: string[]): string[] {
  const deduped = Array.from(new Set(modifiers));
  return deduped
    .map((modifier, index) => ({ modifier, index }))
    .sort((a, b) => {
      const rankDiff = modifierRank(a.modifier) - modifierRank(b.modifier);
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index; // stable: preserve first-seen order among ties
    })
    .map(({ modifier }) => modifier);
}

/** Join sorted modifiers and the key into the canonical `mod+...+key`
 * string (design.md §6.2). */
function join(modifiers: string[], key: string): string {
  return modifiers.length === 0 ? key : `${modifiers.join("+")}+${key}`;
}

/**
 * Normalize a single VS Code-style key stroke into a canonical form: all
 * lowercase, aliases mapped (`control`→`ctrl`, `cmd`/`command`→`meta`,
 * `option`→`alt`), modifiers deduplicated and sorted `ctrl, shift, alt,
 * meta`, joined with the key as `mod+...+key` (Req 4.1-4.3, design.md
 * §6.2).
 *
 * Defensive on odd input — malformed strokes must never throw, since a bad
 * `keybindings.json` entry should be reported and skipped by the binding
 * table (Task 1.5), not crash key resolution:
 * - `"+"` (and any run of only `+` characters, e.g. `"++"`) normalizes to
 *   the literal `"+"` key with no modifiers — there is no modifier text to
 *   parse, so the whole string must be the key.
 * - A trailing `"+"` after some modifier text — `"ctrl+"` or `"ctrl++"` —
 *   is read as "the key IS `+`": the final `+` is the key, and the `+`
 *   immediately before it (if any) is the separator introducing it.
 * - Empty modifier tokens produced by other odd chaining (e.g. a stray
 *   double `+` in the middle) are dropped rather than propagated.
 */
export function normalizeKey(key: string): string {
  // Tolerate sloppy whitespace ("ctrl + p", " Ctrl+Shift+P ") by trimming
  // the ends and collapsing spaces around "+" separators. Single strokes
  // never legitimately contain whitespace — chord splitting (Task 1.6)
  // happens on whitespace before normalizeKey is called.
  const raw = (key ?? "").trim().replace(/\s*\+\s*/g, "+");

  // A run of only "+" characters has no modifier text to parse — the
  // entire input names the "+" key itself.
  if (raw.length > 0 && /^\+*$/.test(raw)) {
    return "+";
  }

  if (raw.endsWith("+") && raw.length > 1) {
    // Trailing "+" names the "+" key. Strip it, then strip one more
    // trailing "+" if present — that one is the separator between the
    // last modifier and the "+" key, not a modifier boundary of its own
    // (so "ctrl+" and "ctrl++" both mean ctrl + the "+" key).
    let modifierPart = raw.slice(0, -1);
    if (modifierPart.endsWith("+")) {
      modifierPart = modifierPart.slice(0, -1);
    }
    const modifiers = modifierPart
      .split("+")
      .filter((token) => token.length > 0)
      .map(canonicalizeModifier);
    return join(sortModifiers(modifiers), "+");
  }

  const parts = raw.split("+");
  const keyToken = (parts[parts.length - 1] ?? "").toLowerCase();
  const modifiers = parts
    .slice(0, -1)
    .filter((token) => token.length > 0)
    .map(canonicalizeModifier);
  return join(sortModifiers(modifiers), keyToken);
}

/**
 * Normalize a (possibly multi-stroke) chord sequence into its canonical
 * table-key form (Req 4.4, design.md §6.3): split `sequence` on whitespace,
 * {@link normalizeKey} each stroke independently, and rejoin with a single
 * space — `"Ctrl+K  Shift+Ctrl+S"` becomes `"ctrl+k ctrl+shift+s"`.
 *
 * `normalizeKey` alone cannot do this: it treats its whole input as one
 * stroke, so feeding it a raw multi-stroke string (splitting on `"+"`
 * without first splitting on whitespace) misparses the space-containing
 * modifier run between strokes. A single-stroke input passes through
 * exactly as {@link normalizeKey} would produce it, so every existing
 * single-stroke binding is unaffected — this is a superset, not a
 * replacement.
 *
 * Never throws: empty/whitespace-only input normalizes to `""`, matching
 * `normalizeKey("")`.
 */
export function normalizeKeySequence(sequence: string): string {
  return (sequence ?? "")
    .trim()
    .split(/\s+/)
    .filter((stroke) => stroke.length > 0)
    .map(normalizeKey)
    .join(" ");
}
