/**
 * Error-shape helpers shared by every `@tecode/core` module that catches an
 * `unknown` (Qodana `DuplicatedCode`): both of these were previously copied
 * verbatim into each module that needed one — `describeError` into 30 of
 * them, `errorCode` into 9 — on the house-style reasoning that a two-line
 * leaf helper is cheaper duplicated than exported. At that multiplicity the
 * trade stops paying: the copies are byte-identical, so every one of them is
 * a place the never-throws contract below can silently drift.
 *
 * `packages/builtin/**` carries its own copy in `builtin/shared/errors.ts`
 * rather than importing these — the extension/core layering rule
 * (`eslint.config.mjs`) forbids a built-in from importing `@tecode/core` at
 * all, and `@tecode/api` is a type-only package by contract. `packages/cli`
 * is core's privileged wiring point and imports these from `@tecode/core`
 * directly.
 */

/** Render a caught `unknown` value as a message string without risking a
 * second throw: a value whose `message` getter or `toString` itself throws
 * (a null-prototype object, a Proxy) must still yield a loggable string
 * rather than replace the original failure. */
export function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Extract an errno-style `code` (e.g. `"ENOENT"`, `"EEXIST"`) from a caught
 * unknown, or `undefined` when it carries none — including when it carries a
 * non-string `code`, which callers branching on `"ENOENT"` must not see. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
