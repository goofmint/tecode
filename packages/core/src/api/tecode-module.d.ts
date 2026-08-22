/**
 * Ambient type declaration for the `"tecode"` module specifier (Req 10.1,
 * design.md §2, §12). `alias.ts`'s `registerTecodeAlias` binds this
 * specifier at *runtime* via `Bun.plugin`'s virtual-module hook —
 * TypeScript has no static knowledge of that binding on its own, so this
 * file supplies it: each `tecode.*` namespace, re-exported here as a named
 * export of type only, mirrors exactly what `Bun.plugin`'s `loader:
 * "object"` actually does at runtime (project the registered object's own
 * enumerable properties onto the module's named exports — `alias.ts`
 * registers the `Tecode` object itself, whose own properties are these
 * nine namespaces).
 *
 * **Why this file, here, is enough**: this repo's root `tsconfig.json` sets
 * no `"include"`, so a single `bunx tsc --noEmit` run from the repo root
 * compiles one Program spanning every package's `src/` (verified: it lists
 * files from `api`, `core`, `builtin`, and `cli` together) — and an ambient
 * `declare module` is visible to every file in that one Program regardless
 * of which package's `src/` it physically lives in. `packages/cli/src/
 * main.ts`'s `import ... from "tecode"` therefore type-checks even though
 * this declaration sits under `packages/core/src/api/`.
 *
 * **Limitation**: a *per-package* `tsc` invocation scoped to just
 * `packages/cli/tsconfig.json` (its `"include": ["src"]` only reaches
 * `packages/cli/src/`) would NOT see this file and would fail to resolve
 * `"tecode"`. No such per-package script exists in this repo today — the
 * only typecheck this codebase runs is the root, whole-Program
 * `bunx tsc --noEmit` — so this is a documented latent gap rather than a
 * live break; if a per-package typecheck is ever introduced, either
 * duplicate this declaration under `packages/cli/src/` or add a `"files"`/
 * `"types"` reference from `cli`'s `tsconfig.json` to this one.
 */

declare module "tecode" {
  import type {
    CommandsNamespace,
    ConfigNamespace,
    ContextNamespace,
    EditorNamespace,
    LanguagesNamespace,
    ThemesNamespace,
    UiNamespace,
    WindowNamespace,
    WorkspaceNamespace,
  } from "@tecode/api";

  export const commands: CommandsNamespace;
  export const workspace: WorkspaceNamespace;
  export const window: WindowNamespace;
  export const editor: EditorNamespace;
  export const ui: UiNamespace;
  export const config: ConfigNamespace;
  export const context: ContextNamespace;
  export const languages: LanguagesNamespace;
  export const themes: ThemesNamespace;
}
