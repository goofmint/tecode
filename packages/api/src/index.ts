/**
 * `@tecode/api` — the complete public type surface extensions are written
 * against. This package has no dependencies and contains no runtime
 * behavior beyond {@link API_VERSION} (Req 1.3, design.md §2): `core`
 * implements these types, `builtin` and third-party extensions import only
 * from here, and neither imports from `core` directly.
 */

export type {
  Position,
  Range,
  Selection,
  TextEdit,
  Uri,
  Disposable,
  Listener,
  Event,
} from "./primitives";

export type { Eol, Document, DocumentChangeEvent, DirtyRange } from "./document";

export type {
  UiColorKey,
  BaseCaptureName,
  CaptureName,
  RGB,
  Style,
  ResolvedTheme,
  ThemeContribution,
} from "./theme";

export type {
  ActivationEvent,
  CommandMeta,
  CommandContribution,
  KeybindingContribution,
  ViewSlot,
  ViewContribution,
  LanguageComments,
  BracketPair,
  LanguageContribution,
  ConfigurationPropertySchema,
  ConfigurationContribution,
  Contributes,
  Manifest,
  ExtensionContext,
} from "./manifest";

export type {
  CommandHandler,
  CommandDescriptor,
  CommandsNamespace,
  FileType,
  FileStat,
  DirEntry,
  FileChangeType,
  FileChangeEvent,
  FileSystem,
  WorkspaceNamespace,
  MessageKind,
  QuickPickItem,
  QuickPickOptions,
  InputBoxOptions,
  StatusBarItem,
  Editor,
  WindowNamespace,
  FindNamespace,
  EditorNamespace,
  SlotId,
  ComponentType,
  UiNamespace,
  ConfigChangeEvent,
  ConfigNamespace,
  ContextNamespace,
  LanguagesNamespace,
  ThemesNamespace,
  Tecode,
} from "./namespaces";

/**
 * The `@tecode/api` version, as `"<major>.<minor>"` (design.md §4.3). This
 * is the package's only runtime code — everything else is type-only.
 *
 * **Compatibility rule** (Req 2.7): a manifest declares the API version it
 * targets as `apiVersion: "<major>"` or `"<major>.<minor>"`. An extension
 * is compatible with the running host when the major versions match and
 * the host's minor version is greater than or equal to the extension's
 * requested minor version (an omitted minor is treated as `0`). An
 * incompatible extension is skipped at registration with a surfaced error
 * rather than crashing the host.
 */
export const API_VERSION = "1.0";
