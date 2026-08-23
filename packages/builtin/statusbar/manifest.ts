/**
 * `statusbar`'s manifest (Task 3.4, Req 11.6; design.md §13): a pure-
 * contribution-free `onStartup` activation, following `command-palette/
 * manifest.ts`'s precedent — everything this built-in does is registering
 * `statusBar.item`s directly via `tecode.window.setStatusBarItem`
 * (`index.ts`), not a manifest-declared `contributes` entry (there is no
 * `statusBar.item` contribution point in `Contributes`, `@tecode/api`'s
 * `manifest.ts` — only `tecode.ui.registerView`'s `SlotId` union includes
 * it, and that is a RUNTIME registration call, not a static manifest
 * declaration).
 */

import type { Manifest } from "@tecode/api";

export default {
  id: "tecode.statusbar",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: ["onStartup"],
  contributes: {},
} satisfies Manifest;
