/**
 * Extracts the workspace root folder's own name from `workspace.rootUri`
 * (Issue #103: "the explorer sidebar header reads a fixed 'Explorer'... it
 * should show the name of the workspace root folder, the way VS Code
 * does"). `index.ts`'s `activate` calls this once and, when it returns a
 * name, publishes it as the sidebar view's live title via `tecode.ui.
 * registerView`'s `options.title` (`@tecode/api`'s `RegisterViewOptions`).
 *
 * **Why this can't just be `path.basename(rootUri)`**: `Uri` (`@tecode/
 * api`'s `primitives.ts`) is a plain `file://` HREF, not a filesystem
 * path — `@tecode/core`'s `buffer/uri.ts`'s `pathToUri` (what `cli/
 * main.ts` calls to build `workspace.rootUri`) is `pathToFileURL(path).
 * href`, i.e. PERCENT-ENCODED
 * (`file:///home/user/my%20project`, not `/home/user/my project`).
 * `@tecode/core` owns the exact inverse of that, `uriToPath` — but
 * `packages/builtin` may never import `@tecode/core` (the ESLint layering
 * rule, `eslint.config.mjs`'s `no-restricted-imports`), so this is this
 * package's OWN small, local stand-in for just the one piece it actually
 * needs: the URI's last path segment, decoded — not a general URI-to-path
 * converter.
 *
 * **`URL`, not `node:url`'s `fileURLToPath`**: the WHATWG `URL` parser
 * already normalizes a trailing slash and percent-encoding in `.pathname`
 * without deciding anything about OS path SEMANTICS the way
 * `fileURLToPath` does (it treats a `file:///C:/...` drive-letter host
 * differently depending on `process.platform`) — unnecessary risk here,
 * since this function only ever wants the last `/`-separated segment,
 * decoded, never a reconstructed filesystem path.
 */

import type { Uri } from "@tecode/api";

/**
 * The workspace root's own folder name, or `undefined` when there is none
 * to show — the caller's cue to publish no `title` at all and leave the
 * manifest's static "Explorer" in place (`@tecode/api`'s
 * `RegisterViewOptions.title` TSDoc: omitting `title` keeps whatever is
 * already on record). `undefined` covers every case that is not a real,
 * named folder, deliberately rather than guessing at one:
 *  - `rootUri` is `undefined` (no workspace open — a single file, or none).
 *  - The URI's last path segment is empty — a filesystem root itself
 *    (`file:///` on POSIX; a Windows drive root's own trailing-slash
 *    form, `file:///C:/`, still yields one non-empty segment, `"C:"`, and
 *    is NOT covered by this case — see this module's TSDoc).
 *  - `rootUri` is not a well-formed URL at all, or its last segment is not
 *    validly percent-encoded (`decodeURIComponent` throwing on a lone
 *    `%`) — both are folded into the same "could not parse" outcome,
 *    never a thrown exception out of this function.
 */
export function rootFolderName(rootUri: Uri | undefined): string | undefined {
  if (!rootUri) return undefined;
  try {
    const segments = new URL(rootUri).pathname.split("/").filter((segment) => segment.length > 0);
    const last = segments.at(-1);
    if (!last) return undefined;
    return decodeURIComponent(last);
  } catch {
    return undefined;
  }
}
