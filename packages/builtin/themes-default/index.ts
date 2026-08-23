/**
 * `themes-default`'s module (Req 11.4; design.md §13's "pure-contribution
 * extensions (no `activate` logic beyond registration)"). Both themes this
 * extension provides are registered directly from `manifest.ts`'s
 * `contributes.themes` during discovery/registration
 * (`@tecode/core`'s `host/registration.ts`), which never executes this
 * file — and `manifest.ts` declares no `activationEvents` at all, so in
 * this MVP `activate` below is never actually invoked. It is exported
 * anyway, purely to satisfy `@tecode/builtin/index.ts`'s
 * `BuiltinExtensionModule` shape (every entry in `builtinModules` needs a
 * module to resolve to) and to degrade safely — rather than reporting a
 * "no static module wiring" error (`packages/cli/src/extensionRecords.ts`'s
 * TSDoc) — in the hypothetical case a future change adds an activation
 * event to this manifest without also updating this file.
 */
export function activate(): void {
  // No-op: every contribution this extension makes (its two themes) is
  // already registered by the host from manifest.ts's `contributes.themes`
  // before `index.ts` could ever run — see this module's TSDoc.
}
