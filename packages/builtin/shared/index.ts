/**
 * Pure utilities shared across built-in extensions (Task 3.2/3.3, Req
 * 11.2, 11.3) — `command-palette`'s `ctrl+p` file quick-open and the
 * `explorer` built-in both consume `ignore.ts`'s real `.gitignore`-aware
 * `IgnoreChecker` and (`command-palette` only) `walkFiles.ts`'s recursive
 * traversal shape. Everything here imports only `@tecode/api` types (plus
 * platform globals like `URL`/`Bun.spawn` and Node/Bun builtins like
 * `node:url`) — never `@tecode/core` — the same ESLint layering rule every
 * `packages/builtin/**` file is already held to (`eslint.config.mjs`).
 */

export { fuzzyMatch, type FuzzyMatchResult } from "./fuzzyMatch";
export { evaluateWhen, filterByWhen, type WhenContextGetter } from "./whenFilter";
export {
  createIgnoreChecker,
  type FilterEntriesOptions,
  type IgnoreChecker,
  type IgnoreCheckerDeps,
} from "./ignore";
export { parseGitignore, type GitignoreMatcher } from "./gitignoreMatcher";
export { createBunGitRunner, uriToGitPath, type GitRunner } from "./gitRunner";
export { joinChildUri, walkFiles, type WalkedFile, type WalkFilesDeps, type WalkFilesResult } from "./walkFiles";
