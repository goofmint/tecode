/**
 * `registerTecodeAlias`: makes `import ... from "tecode"` resolve at
 * runtime (Req 10.1, design.md §2, §12; Task 1.13) using `Bun.plugin`'s
 * virtual-module hook. Every extension is written against `@tecode/api`'s
 * *types* but reaches the live implementation through the `"tecode"`
 * module specifier (design.md §2) — this is the one place that binding is
 * actually wired up, and it must run once, after {@link createTecodeApi}
 * has built the object and *before* any extension module is imported
 * (`cli/main.ts`'s startup wiring, Task 1.15, is the intended call site;
 * `discovery.ts`'s manifest-only dynamic import runs before this and never
 * touches `index.ts`, so ordering there is unaffected).
 *
 * **Static typing for `"tecode"`**: `Bun.plugin`'s `builder.module(...)` is
 * a runtime-only hook — TypeScript has no way to see that the specifier
 * `"tecode"` will resolve to anything without help. `api/tecode-module.d.ts`
 * supplies that help with an ambient `declare module "tecode"` re-exporting
 * each namespace's type from `@tecode/api`; that file's own TSDoc explains
 * why it works across every package in one `bunx tsc --noEmit` run despite
 * living in `core`.
 *
 * **Compiled-mode (`bun build --compile`) note**: `Bun.plugin` registration
 * must still run before any extension module import inside the compiled
 * binary's own entry point — nothing about this changes for a compiled
 * build (`Bun.plugin` is a runtime call, not a bundler transform), but the
 * *build entry file* (design.md §17's `scripts/release.ts`-driven build,
 * not yet written) must be the one that calls
 * {@link createTecodeApi}/{@link registerTecodeAlias}, exactly like
 * `cli/main.ts` does in dev. No build script changes are needed for this
 * task; this note exists so Task whichever-wires-`--compile` doesn't have
 * to rediscover the constraint.
 */

import type { Tecode } from "@tecode/api";

/** The `api` object most recently registered via {@link registerTecodeAlias}
 * — tracked so a repeat call with the exact same object is a cheap no-op
 * (idempotent) while a call with a genuinely different object (e.g. a test
 * building a fresh composition root) still takes effect: `Bun.plugin`
 * itself is fine with re-registering the same module specifier (last
 * registration wins, verified empirically — it does not throw or warn), so
 * there is no correctness reason to refuse that case, only a cheap
 * optimization for the common one. */
let registeredApi: Tecode | undefined;

/**
 * Register the `"tecode"` virtual module so `import ... from "tecode"`
 * resolves to `api`'s namespaces as named exports (`commands`, `workspace`,
 * `window`, `editor`, `ui`, `config`, `context`, `languages`, `themes` —
 * matching `Tecode`'s own shape, since `Bun.plugin`'s `loader: "object"`
 * projects an object's own enumerable properties onto the module's named
 * exports). Call this exactly once per `api` object, after
 * {@link createTecodeApi} and before any extension module loads.
 */
export function registerTecodeAlias(api: Tecode): void {
  if (registeredApi === api) return;
  registeredApi = api;
  Bun.plugin({
    name: "tecode-module-alias",
    setup(builder) {
      builder.module("tecode", () => ({
        // `OnLoadResultObject.exports` is typed `Record<string, unknown>`
        // (an index signature `Tecode` deliberately does not declare — its
        // nine namespaces are named, not open-ended). The cast is safe:
        // `api`'s own enumerable properties genuinely are exactly what
        // `tecode-module.d.ts`'s ambient declaration promises callers of
        // `import ... from "tecode"`.
        exports: api as unknown as Record<string, unknown>,
        loader: "object",
      }));
    },
  });
}
