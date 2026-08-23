/**
 * Pure utilities shared across built-in extensions (Task 3.2, Req 11.3),
 * imported for the first time by `command-palette` — `explorer` (Task 3.3)
 * is expected to reuse `ignore.ts`'s real successor and `walkFiles.ts`'s
 * traversal shape once it lands. Everything here imports only
 * `@tecode/api` types (plus platform globals like `URL`) — never
 * `@tecode/core` — the same ESLint layering rule every `packages/builtin/**`
 * file is already held to (`eslint.config.mjs`).
 */

export { fuzzyMatch, type FuzzyMatchResult } from "./fuzzyMatch";
export { evaluateWhen, filterByWhen, type WhenContextGetter } from "./whenFilter";
export { createDefaultIgnorer, type Ignorer } from "./ignore";
export { walkFiles, type WalkedFile, type WalkFilesDeps } from "./walkFiles";
