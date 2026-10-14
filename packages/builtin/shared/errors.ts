/**
 * Error-shape helpers shared across built-in extensions — the `builtin`-side
 * copy of `@tecode/core`'s `util/errors.ts`. The duplication across the two
 * packages is deliberate and enforced: the extension/core layering rule
 * (`eslint.config.mjs`, Req 1.3) forbids `packages/builtin/**` from importing
 * `@tecode/core`, and `@tecode/api` is by contract a type-only package whose
 * sole runtime export is `API_VERSION`. So there is no third place both
 * packages could import this from. Within `builtin` it is imported, not
 * re-copied.
 */

/** Render a caught `unknown` value as a message string without risking a
 * second throw (identical contract to `@tecode/core`'s `describeError`). */
export function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}
