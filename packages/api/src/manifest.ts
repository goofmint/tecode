/**
 * Extension manifest types (Req 2.3, 2.5, 2.7, 3.2, 3.3, 8.2, design.md
 * §4.1-4.3). `manifest.ts` is read and validated by the host *without*
 * executing the extension's `index.ts` (Req 2.2) — everything here is pure
 * data, constrained by convention to `export default {...} satisfies
 * Manifest`.
 */

import type { Disposable, Uri } from "./primitives";
import type { Tecode } from "./namespaces";
import type { ThemeContribution } from "./theme";

/**
 * When an extension activates (Req 2.5). The MVP supports:
 * - `"onStartup"` — activated after the UI shell's first frame.
 * - `` `onCommand:${string}` `` — activated when the named command is
 *   first executed (the command registry re-dispatches after activation).
 * - `` `onLanguage:${string}` `` — activated when a document with the
 *   named language ID is opened.
 */
export type ActivationEvent =
  | "onStartup"
  | `onCommand:${string}`
  | `onLanguage:${string}`;

/**
 * Metadata attached to a command: what the palette shows (`title`), how it
 * is grouped there (`category`), and when it should be visible/enabled
 * (`when`, a boolean context expression — Req 3.3, design.md §6.4).
 */
export interface CommandMeta {
  title?: string;
  category?: string;
  when?: string;
}

/**
 * A command declared in a manifest's `contributes.commands`.
 *
 * Command IDs follow the `namespace.verb` convention (e.g.
 * `"editor.action.deleteLine"`, `"explorer.reveal"` — Req 3.2). Declaring a
 * command here registers it (lazily) without activating the extension;
 * activation happens on first execution via the `onCommand:<id>`
 * activation event.
 */
export interface CommandContribution extends CommandMeta {
  id: string;
  /** Palette display name (required for contributed commands). */
  title: string;
}

/** A keybinding declared in a manifest's `contributes.keybindings`, in the
 * same shape as an entry in the user's `keybindings.json` (Req 4.2). */
export interface KeybindingContribution {
  /** A canonical key or two-stroke chord string (e.g. `"ctrl+shift+p"`,
   * `"ctrl+k ctrl+s"` — Req 4.4). */
  key: string;
  /** The command to run, or `"-<id>"` to remove a default binding for
   * `<id>` on this key (Req 4.3). */
  command: string;
  when?: string;
}

/** The UI slot a contributed view is rendered into (Req 6.2). */
export type ViewSlot = "sidebar" | "panel";

/**
 * A view declared in a manifest's `contributes.views`. A `"sidebar"` view
 * is paired 1:1 with an activity bar item of the same `id` (Req 6.2) —
 * `icon` is that activity bar item's glyph.
 */
export interface ViewContribution {
  id: string;
  title: string;
  slot: ViewSlot;
  icon?: string;
}

/** Line/block comment markers for a language (Req 8.2). */
export interface LanguageComments {
  line?: string;
  block?: [start: string, end: string];
}

/** A matching pair of auto-closed/matched brackets (Req 8.2). */
export interface BracketPair {
  open: string;
  close: string;
}

/**
 * A language declared in a manifest's `contributes.languages` (Req 8.2).
 * When a file's extension matches no declared language, it is treated as
 * `"plaintext"` with no highlighting (Req 8.3).
 */
export interface LanguageContribution {
  id: string;
  /** File extensions this language applies to, including the leading dot
   * (e.g. `[".ts", ".tsx"]`). */
  extensions: string[];
  /** Path to the tree-sitter WASM grammar. */
  grammar: string;
  /** Path to the tree-sitter highlight query (`.scm`) file. */
  highlights: string;
  comments?: LanguageComments;
  brackets?: BracketPair[];
}

/** One configuration property's JSON-schema-like description (Req 9.3). */
export interface ConfigurationPropertySchema {
  type: "string" | "number" | "boolean" | "array" | "object";
  default?: unknown;
  description?: string;
  enum?: unknown[];
}

/** A settings schema declared in a manifest's `contributes.configuration`
 * (Req 9.3), read back at runtime via `tecode.config.get(key)`. */
export interface ConfigurationContribution {
  title?: string;
  properties: Record<string, ConfigurationPropertySchema>;
}

/**
 * Everything a manifest can contribute to the running editor (Req 2.3).
 * All fields are optional — a manifest contributes only what it declares.
 */
export interface Contributes {
  commands?: CommandContribution[];
  keybindings?: KeybindingContribution[];
  views?: ViewContribution[];
  languages?: LanguageContribution[];
  /** Themes this extension ships, in the same shape
   * `tecode.themes.register` accepts (design.md §9). */
  themes?: ThemeContribution[];
  configuration?: ConfigurationContribution;
}

/**
 * The declarative shape of `manifest.ts`'s default export (Req 2.3). The
 * host reads and validates this without executing `index.ts` (Req 2.2).
 */
export interface Manifest {
  /** Globally unique extension ID. */
  id: string;
  /** The extension's own version (semver). */
  version: string;
  /**
   * The `@tecode/api` version this extension targets, as `"<major>"` or
   * `"<major>.<minor>"` (e.g. `"1"`, `"1.0"`). The host refuses to
   * activate an extension whose required API version is incompatible with
   * `API_VERSION` (Req 2.7) — see {@link API_VERSION}'s TSDoc for the
   * compatibility rule.
   */
  apiVersion: string;
  activationEvents: ActivationEvent[];
  contributes: Contributes;
}

/**
 * Passed to an extension's exported `activate(ctx)` (Req 2.6, design.md
 * §4.2).
 */
export interface ExtensionContext {
  /** The live `tecode` API object — identical to what every other
   * extension (built-in or third-party) receives (Req 1.4). */
  api: Tecode;
  /** The URI of the extension's own directory, for resolving bundled
   * assets. */
  extensionUri: Uri;
  /** Push disposables here to have them disposed automatically, in
   * reverse order, on deactivation. */
  subscriptions: Disposable[];
  /** A per-extension directory for persisting extension state. */
  storagePath: string;
}
