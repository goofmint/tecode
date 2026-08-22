/**
 * `Uri` <-> filesystem-path conversion (design.md §7.2). `@tecode/api`'s
 * `Uri` is a plain `file://...` string (Req 5, `primitives.ts`); the MVP
 * has no virtual filesystem, so every `Uri` `DocumentManager` handles maps
 * 1:1 onto an absolute path via `node:url`'s `fileURLToPath`/
 * `pathToFileURL`.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import type { Uri } from "@tecode/api";

/**
 * Convert a `file://...` {@link Uri} to an absolute filesystem path.
 * `uri` not being a well-formed `file:` URI is a programmer error (every
 * `Uri` `DocumentManager` is asked to open is expected to come from
 * `pathToUri`, a prior `openDocument` call, or another host-internal
 * source) — it throws `TypeError`, matching the codebase's validation
 * policy for programmer errors (see `lineBuffer.ts`'s range validation).
 */
export function uriToPath(uri: Uri): string {
  try {
    return fileURLToPath(uri);
  } catch (cause) {
    throw new TypeError(
      `Invalid file URI "${uri}": expected a well-formed file:// URI (${describeError(cause)})`,
    );
  }
}

/**
 * Convert an absolute filesystem path to a `file://...` {@link Uri}. The
 * inverse of {@link uriToPath} for well-formed input.
 */
export function pathToUri(path: string): Uri {
  return pathToFileURL(path).href;
}

/** Render a caught `unknown` value as a message string without risking a
 * second throw (matches document.ts's `describeError`). */
function describeError(err: unknown): string {
  try {
    if (err instanceof Error) return err.message;
    return String(err);
  } catch {
    return "Unknown error";
  }
}
