/**
 * `languages-basic`'s module (Req 8.4, 11.5; design.md §13's
 * "pure-contribution extensions (no `activate` logic beyond
 * registration)"). Every contribution this extension makes (its 12
 * languages) is already registered by the host from `manifest.ts`'s
 * `contributes.languages` during discovery/registration
 * (`@tecode/core`'s `host/registration.ts`), which never executes this
 * file — and `manifest.ts`'s `activationEvents` exist only so a
 * `user`/`workspace` extension could declare interest in one of these
 * language ids; nothing in THIS extension ever triggers its own
 * activation. `activate` is exported anyway, purely to satisfy
 * `@tecode/builtin/index.ts`'s `BuiltinExtensionModule` shape — see
 * `themes-default/index.ts`'s identical TSDoc for the full reasoning.
 */
export function activate(): void {
  // No-op: see this module's TSDoc.
}
