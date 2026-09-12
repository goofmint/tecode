/**
 * Hello World sample extension activation (Issue #148). Registers the one
 * command `manifest.ts` declares and, when it runs, shows a notification
 * via `tecode.window.showMessage` — the smallest possible "it's alive"
 * loop, with no sidebar view, configuration key, or keybinding.
 */

import type { ExtensionContext } from "@tecode/api";
import { HELLO_WORLD_COMMAND_ID } from "./manifest";

export function activate(ctx: ExtensionContext): void {
  ctx.subscriptions.push(
    ctx.api.commands.register(HELLO_WORLD_COMMAND_ID, () => {
      ctx.api.window.showMessage("Hello, World!", "info");
      return "hello-world-ran";
    }),
  );
}

export function deactivate(): void {
  // No-op: the host disposes everything pushed onto `ctx.subscriptions`
  // automatically on deactivation (this extension owns no other
  // resources).
}
