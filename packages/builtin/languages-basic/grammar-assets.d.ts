/**
 * Ambient module declarations for the two Bun import-attribute forms
 * `assets.ts` uses to embed this extension's vendored grammar/query files
 * (Req 8.4, 8.5; design.md §10, §13) — bun-types' `extensions.d.ts`
 * declares the built-in `*.txt`/`*.toml`/`*.yaml`/... loader shapes but has
 * no entry for `*.wasm` or `*.scm`
 * (neither is a format Bun has a bespoke loader for), so TypeScript would
 * otherwise reject both import specifiers outright, regardless of the
 * `with { type: ... }` attribute actually used at the import site.
 *
 * - `import path from "./x.wasm" with { type: "file" }` — Bun's "file"
 *   loader: the binding is the asset's resolved path (a real filesystem
 *   path under `bun run`; a `/$bunfs/...` virtual path once embedded by
 *   `bun build --compile`) — `Bun.file(path).arrayBuffer()` reads the
 *   actual bytes correctly either way (verified empirically for this task
 *   — see this package's `NOTICE.md`).
 * - `import text from "./x.scm" with { type: "text" }` — Bun's "text"
 *   loader: the binding IS the file's decoded UTF-8 text already, inlined
 *   as a JS string literal at bundle time — nothing further to read, in
 *   either dev or compiled mode.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}

declare module "*.scm" {
  const text: string;
  export default text;
}
