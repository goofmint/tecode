/**
 * Hello World sample extension manifest (Issue #148). The smallest
 * possible `manifest.ts`: metadata plus a single command contribution,
 * nothing else — a copy-and-run starting point that sits alongside
 * `docs/extension-authoring-guide.md`'s more thorough Word Count
 * walkthrough rather than replacing it.
 *
 * `activationEvents: ["onCommand:helloWorld.sayHello"]` follows the
 * guide's own recommendation (`docs/extension-authoring-guide.md`'s "A
 * note on activationEvents"): an extension with nothing to do at startup
 * should defer `activate()` to first command invocation rather than
 * using `"onStartup"`. The command itself is still registered (lazily)
 * and listed in the palette immediately.
 */

import type { Manifest } from "@tecode/api";

/** The one command this sample contributes. Exported so `index.ts` and
 * this manifest share the exact same string. */
export const HELLO_WORLD_COMMAND_ID = "helloWorld.sayHello";

export default {
  id: "example.hello-world",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: [`onCommand:${HELLO_WORLD_COMMAND_ID}`],
  contributes: {
    commands: [{ id: HELLO_WORLD_COMMAND_ID, title: "Hello World: Say Hello" }],
  },
} satisfies Manifest;
