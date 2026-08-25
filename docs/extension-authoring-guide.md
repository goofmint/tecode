# Extension authoring guide (Issue #37 "5.1 Extension authoring guide")

Req 2.3, 2.7, 10; design.md §4, §12. This is the guide a third-party
extension author reads to build a real tecode extension: a walkthrough that
builds one end to end, a complete reference for every `tecode.*` namespace
the walkthrough (and every built-in) is written against, how to bundle an
extension that has npm dependencies, and the API-version compatibility
policy that governs whether your extension loads at all against a given
host build.

Everything below is written against the real source in `packages/api/src/`
and the real host behavior in `packages/core/src/host/`, not from memory of
what the API "should" look like — where a source file's own doc comment is
the more precise statement, this guide says so and points at it.

**What "verified" means for this document**: the walkthrough extension
below is the literal, verbatim content of a real fixture driven through the
real discover → validate → register → activate pipeline by
`packages/cli/src/extensionAuthoringGuideWalkthrough.test.ts`, which reads
this very file, extracts the `manifest.ts`/`index.ts` listings by exact
text, writes them to a real extensions directory, and asserts the extension
reaches the `"active"` state, its contributed command executes, its
contributed view resolves, and its contributed configuration key reads back
its declared default — all through the same `loadExtensions` →
`buildExtensionRecords` → `createExtensionHost` pipeline a real tecode
process runs at startup. What that test **cannot** do, because this
environment has no TTY and ships no released binary, is prove that copying
this extension into a compiled `tecode` binary's
`~/.config/tecode/extensions/` directory and launching it on a real
terminal produces the same result for a human. See "What remains unverified" at the very end of
this document for the precise, unsoftened statement of that gap.

## Contents

1. [Walkthrough: a Word Count extension](#1-walkthrough-a-word-count-extension)
2. [The `tecode.*` API reference](#2-the-tecode-api-reference)
3. [Bundling extensions with npm dependencies](#3-bundling-extensions-with-npm-dependencies)
4. [API-version policy](#4-api-version-policy)

## 1. Walkthrough: a Word Count extension

We're going to build a small extension that reports the word (and,
optionally, character) count of the active document. By the end it will
have a manifest declaring `id`/`apiVersion`/`activationEvents`, an
`activate(ctx)` that runs on startup, one contributed command, one sidebar
view registered with `tecode.ui.registerView`, one configuration key, and
one keybinding — every piece Req 2.3, 2.7, and 10 (and Issue #37) ask this
guide to cover, each one runnable as soon as you add it.

**Where an extension lives**: a directory containing at minimum a
`manifest.ts` and (once it does anything) an `index.ts`, under one of two
places `packages/core/src/host/paths.ts`'s `getUserExtensionsDir`/
`getWorkspaceExtensionsDir` resolve (design.md §4.1, Req 2.1):

- `~/.config/tecode/extensions/<your-extension-name>/` (or
  `%APPDATA%\tecode\extensions\<your-extension-name>\` on Windows) — loads
  for every workspace you open.
- `<workspace-root>/.tecode/extensions/<your-extension-name>/` — loads only
  when tecode is opened on that workspace, and is the natural place for an
  extension you're developing alongside a specific project.

Create the directory now — `word-count/` — under whichever of those two
paths fits how you're working, and follow along.

### Step 1 — the manifest skeleton

`manifest.ts` is read and validated by the host **without executing your
extension's code** (Req 2.2) — it has to be plain, side-effect-free data,
conventionally written as `export default {...} satisfies Manifest`
(`@tecode/api`'s `manifest.ts`'s own TSDoc). Start with just the three
fields Issue #37 calls out plus an empty `contributes`:

```ts
import type { Manifest } from "@tecode/api";

export default {
  id: "example.word-count",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: ["onStartup"],
  contributes: {},
} satisfies Manifest;
```

- `id` — a globally unique string. There's no host-enforced namespace
  convention (unlike command IDs — see Step 3), but `<publisher>.<name>`
  reads clearly and avoids collisions with built-ins (which use
  `tecode.<name>`, e.g. `tecode.explorer` —
  `packages/builtin/explorer/manifest.ts`).
- `apiVersion` — the `@tecode/api` version you're targeting, as
  `"<major>"` or `"<major>.<minor>"`. `"1.0"` targets the current
  `API_VERSION` exactly; see [§4](#4-api-version-policy) for what happens
  when this doesn't match the running host.
- `activationEvents` — when `activate(ctx)` runs. `"onStartup"` runs it
  right after the UI shell's first frame; this is the simplest choice for a
  tutorial, though a real extension usually prefers a narrower event (see
  the callout after Step 3) so it costs nothing at startup until it's
  actually needed.

**Runnable now**: point tecode at a workspace with this extension in place
(`TECODE_HEADLESS=1 bun packages/cli/src/main.ts <dir>` from a checkout of
this repo, or a released binary once one exists) and check its startup log
— your extension should be counted among the extensions loaded, even
though it contributes nothing yet and has no `index.ts`. An extension with
no `index.ts` is legal: `contributes` can register commands/views/
keybindings/configuration on its own, with nothing to `activate()` at all.

### Step 2 — activation code

Add `index.ts` next to `manifest.ts`:

```ts
import type { ExtensionContext } from "@tecode/api";

export function activate(ctx: ExtensionContext): void {
  ctx.api.window.showMessage("Word Count activated", "info");
}

export function deactivate(): void {}
```

`activate(ctx)` receives an `ExtensionContext { api, extensionUri,
subscriptions, storagePath }` (Req 2.6, `@tecode/api`'s `manifest.ts`) —
`api` is the live, frozen `tecode` object ([§2](#2-the-tecode-api-reference)
documents every member of it), `subscriptions` is where you push every
`Disposable` you create so the host can tear them down in reverse order on
deactivation, and `storagePath` is a directory reserved for this
extension's own persisted state. `deactivate()` is optional — export it
only if you have cleanup to do beyond what `subscriptions` already covers.

**Runnable now**: on a real terminal (not the headless mode above, which
has nowhere to render a notification), launching tecode with this extension
present shows "Word Count activated" in the notification area once the
shell's first frame is up.

### Step 3 — register a command

Commands are how every cross-module behavior in tecode is invoked —
keybindings, the palette, other extensions — never a direct function call
(Req 1.5). IDs follow a `namespace.verb` convention (Req 3.2, e.g.
`editor.action.deleteLine`, `explorer.reveal`); ours is
`wordCount.refresh`. Declare it in the manifest so the palette can list it
even before the extension activates (registration walks `contributes`
independently of `index.ts` — design.md §4.1), then register the real
handler in `activate`:

```ts
// manifest.ts — add to contributes:
contributes: {
  commands: [
    { id: "wordCount.refresh", title: "Word Count: Refresh", category: "Word Count" },
  ],
},
```

```ts
// index.ts — inside activate(ctx):
ctx.subscriptions.push(
  ctx.api.commands.register("wordCount.refresh", () => {
    ctx.api.window.showMessage("Word Count: Refresh ran", "info");
  }),
);
```

`commands.register` returns a `Disposable` that unregisters the command —
push it onto `ctx.subscriptions` rather than discarding it, so deactivation
actually cleans it up. `commands.execute` never throws to its caller (Req
3.4, 3.5): an unknown ID or a throwing handler is caught, reported in the
status bar, and the returned promise resolves to `undefined` — see the
compatibility-gate discussion in [§4](#4-api-version-policy) for how this
is proven, not just asserted.

**Runnable now**: `ctrl+shift+p` → "Word Count: Refresh" runs it and shows
the notification, with no sidebar view or keybinding yet.

**A note on `activationEvents`, now that there's a command to hang one on**:
this walkthrough uses `"onStartup"` throughout for the simplest possible
narrative — every step is visible without needing to trigger anything
first. A real extension with nothing else to do at startup would instead
declare `activationEvents: ["onCommand:wordCount.refresh"]` and drop
`"onStartup"` — the command is still registered (lazily) and listed in the
palette immediately, but `activate()` itself only runs the first time
someone actually invokes it (design.md §4.2), exactly how the built-in
`explorer` extension defers its own activation until `explorer.focus` is
first invoked (`packages/builtin/explorer/manifest.ts`'s own TSDoc walks
through why). Either choice is valid; `"onStartup"` costs you nothing here
since this extension is tiny, but it's worth knowing the tradeoff exists.

### Step 4 — a sidebar view

Sidebar views come in two parts: a `views` contribution (which pairs the
view 1:1 with an activity-bar icon of the same `id` — Req 6.2) and a
runtime `tecode.ui.registerView` call that supplies the actual component:

```ts
// manifest.ts — add to contributes:
contributes: {
  // ...commands from Step 3...
  views: [{ id: "wordCount.view", title: "Word Count", slot: "sidebar", icon: "🔤" }],
},
```

```ts
// index.ts — inside activate(ctx):
ctx.subscriptions.push(
  ctx.api.ui.registerView("sidebar.view", "wordCount.view", () => null),
);
```

Two different `id`-shaped things are in play here and it's easy to
conflate them: `ViewContribution.slot` (`"sidebar"` or `"panel"` — which
part of the shell the view's activity-bar pairing lives in) versus
`registerView`'s first argument, a `SlotId` literal (`"sidebar.view"` here
— the specific slot the component itself renders into). The walkthrough's
component is deliberately the simplest possible legal one, `() => null` —
a `ComponentType` that renders nothing — because this step is about proving
the *registration* mechanics, not about UI composition. `@tecode/api`'s
`ComponentType` is React-free by design (`namespaces.ts`'s TSDoc: "so
`@tecode/api` has no dependency on React"), and the host renders whatever
you register as a real React element internally; if you want to render real
content, look at the built-in `explorer` extension's `ExplorerView.tsx`
(`packages/builtin/explorer/`), which builds a real view over
`tecode.ui.Tree` and depends on `react`/`@opentui/react` as ordinary npm
dependencies of its own package — exactly the kind of dependency
[§3](#3-bundling-extensions-with-npm-dependencies) covers bundling for.

**Runnable now**: the activity bar shows a 🔤 icon; clicking it opens the
(empty) Word Count sidebar.

### Step 5 — a configuration key

Declare the setting's schema in the manifest — this seeds its default into
the merged configuration view the moment the manifest registers, before
`activate()` ever runs (`packages/core/src/config/service.ts`'s
`registerConfiguration`):

```ts
// manifest.ts — add to contributes:
contributes: {
  // ...commands, views from Steps 3-4...
  configuration: {
    title: "Word Count",
    properties: {
      "wordCount.showChars": {
        type: "boolean",
        default: false,
        description: "Also show the character count alongside the word count.",
      },
    },
  },
},
```

Read it with `tecode.config.get`, and react live to a user editing it with
`tecode.config.onDidChange` — the same pattern the built-in `explorer`
extension uses for its own `explorer.showHidden` setting
(`packages/builtin/explorer/index.ts`):

```ts
// index.ts — inside activate(ctx), replacing Step 3's handler body:
function summarize(): string {
  const editor = ctx.api.window.activeEditor;
  if (!editor) return "No document open.";
  const lines: string[] = [];
  for (let i = 0; i < ctx.api.editor.lineCount; i++) lines.push(ctx.api.editor.getLine(i));
  const words = lines.join(" ").split(/\s+/).filter((w) => w.length > 0).length;
  const showChars = ctx.api.config.get<boolean>("wordCount.showChars") ?? false;
  return showChars ? `${words} words, ${lines.reduce((n, l) => n + l.length, 0)} chars` : `${words} words`;
}

ctx.subscriptions.push(
  ctx.api.config.onDidChange((event) => {
    if (event.affectsConfiguration("wordCount.showChars")) {
      ctx.api.window.showMessage(summarize(), "info");
    }
  }),
);
```

Note there is no `Document.getText()` — `applyEdits` is the only mutation
path and there's deliberately no bulk-read counterpart either
(`@tecode/api`'s `document.ts`); reading a whole document's text the way
this extension does is `api.editor.lineCount` + `api.editor.getLine(n)` in
a loop, both scoped to whichever document is the *active* editor's, not an
arbitrary open one.

**Runnable now**: add `"wordCount.showChars": true` to
`~/.config/tecode/settings.json` (or `<workspace>/.tecode/settings.json`)
while tecode is running — `onDidChange` fires without a restart, and the
next "Word Count: Refresh" (or the notification this snippet itself
triggers) includes the character count.

### Step 6 — a keybinding

```ts
// manifest.ts — add to contributes:
contributes: {
  // ...commands, views, configuration from Steps 3-5...
  keybindings: [{ key: "ctrl+alt+w", command: "wordCount.refresh" }],
},
```

`key` is a canonical key or two-stroke chord string (Req 4.4, e.g.
`"ctrl+k ctrl+s"`); `command` is any registered command ID, or `"-<id>"` to
*remove* a default binding for `<id>` on this key (Req 4.3) rather than add
one. There is no `extensionId` field to set here yourself — the host stamps
that on during registration (`@tecode/api`'s `manifest.ts`'s
`KeybindingContribution.extensionId` TSDoc is explicit that an
author-supplied value is silently dropped).

**Runnable now**: `ctrl+alt+w` runs `wordCount.refresh` directly, with no
palette detour.

### The complete extension

Here is the whole thing, both files, exactly as the six steps above leave
them — this is the literal fixture
`packages/cli/src/extensionAuthoringGuideWalkthrough.test.ts` extracts from
this document and runs through the real pipeline (see that file for
exactly what it asserts):

<!-- walkthrough-fixture:manifest.ts -->

```ts
import type { Manifest } from "@tecode/api";

export const WORD_COUNT_REFRESH_COMMAND_ID = "wordCount.refresh";
export const WORD_COUNT_VIEW_ID = "wordCount.view";
export const WORD_COUNT_SHOW_CHARS_CONFIG_KEY = "wordCount.showChars";

export default {
  id: "example.word-count",
  version: "0.1.0",
  apiVersion: "1.0",
  activationEvents: ["onStartup"],
  contributes: {
    commands: [
      { id: WORD_COUNT_REFRESH_COMMAND_ID, title: "Word Count: Refresh", category: "Word Count" },
    ],
    views: [{ id: WORD_COUNT_VIEW_ID, title: "Word Count", slot: "sidebar", icon: "🔤" }],
    keybindings: [{ key: "ctrl+alt+w", command: WORD_COUNT_REFRESH_COMMAND_ID }],
    configuration: {
      title: "Word Count",
      properties: {
        [WORD_COUNT_SHOW_CHARS_CONFIG_KEY]: {
          type: "boolean",
          default: false,
          description: "Also show the character count alongside the word count.",
        },
      },
    },
  },
} satisfies Manifest;
```

<!-- walkthrough-fixture:index.ts -->

```ts
import type { ExtensionContext } from "@tecode/api";
import {
  WORD_COUNT_REFRESH_COMMAND_ID,
  WORD_COUNT_SHOW_CHARS_CONFIG_KEY,
  WORD_COUNT_VIEW_ID,
} from "./manifest";

function countWords(lines: string[]): number {
  return lines.join(" ").split(/\s+/).filter((word) => word.length > 0).length;
}

function countChars(lines: string[]): number {
  return lines.reduce((total, line) => total + line.length, 0);
}

export function activate(ctx: ExtensionContext): void {
  const { api } = ctx;

  function summarize(): string {
    const editor = api.window.activeEditor;
    if (!editor) return "No document open.";
    const lines: string[] = [];
    for (let i = 0; i < api.editor.lineCount; i++) lines.push(api.editor.getLine(i));
    const showChars = api.config.get<boolean>(WORD_COUNT_SHOW_CHARS_CONFIG_KEY) ?? false;
    const words = countWords(lines);
    return showChars ? `${words} words, ${countChars(lines)} chars` : `${words} words`;
  }

  ctx.subscriptions.push(
    api.commands.register(
      WORD_COUNT_REFRESH_COMMAND_ID,
      () => {
        const summary = summarize();
        api.window.showMessage(summary, "info");
        return summary;
      },
      { title: "Word Count: Refresh", category: "Word Count" },
    ),
  );

  ctx.subscriptions.push(api.ui.registerView("sidebar.view", WORD_COUNT_VIEW_ID, () => null));

  ctx.subscriptions.push(
    api.config.onDidChange((event) => {
      if (event.affectsConfiguration(WORD_COUNT_SHOW_CHARS_CONFIG_KEY)) {
        api.window.showMessage(summarize(), "info");
      }
    }),
  );
}

export function deactivate(): void {}
```

Two small differences from the incremental snippets above, both harmless:
the command handler now returns the summary string as well as showing it
(so the pipeline test can assert on the return value directly — `tecode`
itself ignores a command handler's return value except when another caller
`await`s `commands.execute`), and every ID is pulled from an exported
constant so `manifest.ts` and `index.ts` can't drift apart from each other
inside the same extension the way two independently-typed string literals
could.

## 2. The `tecode.*` API reference

Every namespace below is a field of the `Tecode` interface
(`@tecode/api`'s `namespaces.ts`), handed to every extension — built-in or
third-party — as `ExtensionContext.api`, and available as the `"tecode"`
module alias at runtime (design.md §2). The whole object, and each
namespace inside it, is shallow-frozen by the host (`Object.freeze`) so one
extension cannot monkey-patch another's view of it — [§4](#4-api-version-policy)
describes exactly how that's proven, not just documented.

Shared types referenced throughout (all from `@tecode/api`, re-exported
from its `primitives.ts`/`document.ts`/`theme.ts`/`manifest.ts`):

- **`Position { line, character }`** — zero-based, UTF-16 code units,
  LSP-compatible.
- **`Range { start, end }`** — half-open, `[start, end)`.
- **`Selection extends Range { anchor, active }`** — `anchor` is where a
  selection began, `active` is the live caret end; equal for a collapsed
  cursor.
- **`TextEdit { range, newText }`** — one text replacement; `applyEdits`
  batches are the only document mutation path (Req 5.2).
- **`Uri`** — a plain `string` alias (typically `file://...`).
- **`Disposable { dispose(): void }`** — returned by every registration/
  subscription method; push these onto `ExtensionContext.subscriptions`.
- **`Listener<T> = (e: T) => void`** and **`Event<T> = (listener) =>
  Disposable`** — every `onDidX` member below is one of these.

### `tecode.commands` — `CommandsNamespace`

The command registry (Req 3, 10.1) — all cross-module behavior goes
through here rather than a direct function call (Req 1.5).

| Member | Signature | Notes |
|---|---|---|
| `register` | `(id: string, handler: CommandHandler, meta?: CommandMeta) => Disposable` | `id` follows `namespace.verb` (Req 3.2). Re-registering an existing `id` replaces its handler. `CommandHandler = (...args: unknown[]) => unknown`. |
| `execute` | `(id: string, ...args: unknown[]) => Promise<unknown>` | Never throws (Req 3.4, 3.5): an unknown `id` or a throwing handler is caught, surfaced in the status bar, and resolves to `undefined`. |
| `list` | `() => CommandDescriptor[]` | Every registered command, for the palette to filter by `when` and fuzzy-match. `CommandDescriptor extends CommandMeta { id }`. |

`CommandMeta { title?, category?, when? }` — `title`/`category` drive the
palette's display; `when` is a boolean context expression over
`tecode.context` (design.md §6.4).

### `tecode.workspace` — `WorkspaceNamespace`

The open workspace (a single root directory in the MVP) and its open
documents (Req 10.1).

| Member | Signature | Notes |
|---|---|---|
| `rootUri` | `readonly Uri` (or `undefined`) | `undefined` when tecode opened a single file with no enclosing workspace. |
| `openDocument` | `(uri: Uri) => Promise<Document>` | Opens (or returns the already-open) document for `uri`. |
| `documents` | `readonly Document[]` (read-only property) | Every currently open document. |
| `fs` | `FileSystem` | See below. |
| `onDidOpen` / `onDidClose` / `onDidSave` | `Event<Document>` | Fire in that order for one document's lifecycle — proven, not just documented; see [§4](#4-api-version-policy). |
| `save` | `(uri: Uri) => Promise<void>` | Saves `uri`'s current text (Req 11.1). Never rejects — an unopened `uri`, a readonly document, or a write failure surfaces a status-bar error instead and this still resolves, matching `applyEdits`'s own no-throw discipline. Fires `onDidSave` on success. |

`tecode.workspace.fs` — `FileSystem`, wrapping `node:fs/promises` +
`fs.watch` (no sandboxing in the MVP — Req 10.2):

| Member | Signature | Notes |
|---|---|---|
| `read` | `(uri: Uri) => Promise<Uint8Array>` | |
| `write` | `(uri: Uri, content: Uint8Array) => Promise<void>` | |
| `stat` | `(uri: Uri) => Promise<FileStat>` | `FileStat { type, size, mtime, ctime }`. |
| `readdir` | `(uri: Uri) => Promise<DirEntry[]>` | `DirEntry { name, type }`. |
| `watch` | `(uri: Uri, listener: Listener<FileChangeEvent>) => Disposable` | One file or directory (non-recursive). `FileChangeEvent { type, uri }`, where `type` is `"created"`, `"changed"`, or `"deleted"`. |
| `delete` | `(uri: Uri) => Promise<void>` | File or (empty or non-empty) directory. Rejects on failure. |
| `rename` | `(oldUri: Uri, newUri: Uri) => Promise<void>` | Rejects on failure. |
| `mkdir` | `(uri: Uri) => Promise<void>` | Rejects on failure. |

`FileType = "file" | "directory" | "symlink" | "unknown"`.

### `tecode.window` — `WindowNamespace`

Window-level UI: notifications, pickers, the status bar (Req 10.1).

| Member | Signature | Notes |
|---|---|---|
| `activeEditor` | `readonly Editor` (or `undefined`) | `Editor { document, selections }`. `undefined` when nothing is focused. |
| `showMessage` | `(message: string, kind?: MessageKind) => void` | `MessageKind` is `"info"`, `"warning"`, or `"error"`. |
| `showQuickPick` | `(items: QuickPickItem[], options?: QuickPickOptions) => Promise<...>` | Resolves to the selected `QuickPickItem`, or `undefined` if dismissed. `QuickPickItem { label, description?, detail? }`; `QuickPickOptions { placeHolder?, canPickMany? }`. |
| `showInputBox` | `(options?: InputBoxOptions) => Promise<...>` | Resolves to the entered `string`, or `undefined` if dismissed. `InputBoxOptions { prompt?, value?, placeHolder?, password?, validateInput? }` — `validateInput` runs on every keystroke *and once on open* with the initial value, so a required-field validator reports immediately. |
| `setStatusBarItem` | `(item: StatusBarItem) => Disposable` | `StatusBarItem { id, text, tooltip?, side, priority }`, where `side` is `"left"` or `"right"` — higher `priority` renders first within its side (Req 6.2). |

### `tecode.editor` — `EditorNamespace`

Operations on the active editor (Req 10.1). Every call below no-ops (with
a status-bar notice) when there is no active editor — proven in the
contract suite, see [§4](#4-api-version-policy).

| Member | Signature | Notes |
|---|---|---|
| `selections` | `readonly Selection[]` (read-only property) | `[]` with no active editor. |
| `cursor` | `readonly Position` | The active end of `selections[0]`. |
| `revealLine` | `(line: number) => void` | Scrolls so `line` is visible. |
| `insertSnippet` | `(snippet: string) => void` | Tab-stop syntax is host-defined. |
| `applyEdits` | `(edits: TextEdit[]) => void` | Applies to the active document — see `Document.applyEdits` below. |
| `getLine` | `(line: number) => string` | Line `n` (0-based), no terminator. `""` if no active editor or out of bounds — there is deliberately no `Document.getText()`; this loop is how you read a whole document (Step 5 above). |
| `lineCount` | `readonly number` | `0` with no active editor. |
| `setSelections` | `(selections: readonly Selection[]) => void` | Replaces the active editor's carets/selections wholesale; no-ops on an empty array (a document always has at least one selection). |
| `find` | `FindNamespace` | See below. |
| `onDidChange` | `Event<void>` | Fires on active-editor SWITCH and on selection/cursor change — **not** on every keystroke by itself (a plain text edit with no selection change fires `Document.onDidChange` instead, reachable via `window.activeEditor.document.onDidChange`). |

`tecode.editor.find` — `FindNamespace`, per-editor in-buffer find/replace
(Req 11.1, design.md §13). All state (query, matches, case-sensitivity,
open/closed) lives host-side; every method no-ops with no active editor,
same as the rest of `EditorNamespace`.

| Member | Signature | Notes |
|---|---|---|
| `open` | `() => void` | Preserves whatever query/matches the widget already had. |
| `close` | `() => void` | Only visibility toggles — state is preserved for a later `open`. |
| `setQuery` | `(query: string) => void` | Recomputes matches against the current text, jumps to the nearest match at/after the cursor. |
| `setReplaceQuery` | `(query: string) => void` | Does not affect matches. |
| `toggleCaseSensitive` | `() => void` | Recomputes matches. |
| `next` / `previous` | `() => void` | Wraps past the last/first match. No-op with no matches. |
| `replaceCurrent` | `() => void` | Replaces the current match, advances to whatever now occupies its place. No-op with no active match or a readonly document. |
| `replaceAll` | `() => void` | Replaces every match as a single undo step. No-op with no matches or a readonly document. |

### `tecode.ui` — `UiNamespace`

View registration and the common component library (Req 10.1, 6.3).

| Member | Signature | Notes |
|---|---|---|
| `registerView` | `(slot: SlotId, id: string, component: ComponentType) => Disposable` | `SlotId` is one of `"activityBar.item"`, `"sidebar.view"`, `"panel.tab"`, `"statusBar.item"`, `"editor.viewType"`. |
| `useTheme` | `() => ResolvedTheme` | Components must source every color from here, never a hard-coded literal (Req 7.3). |
| `List` | `ComponentType` | A minimal selectable list. |
| `Tree` | `ComponentType` | A minimal expandable tree (what `explorer` renders over). |
| `Input` | `ComponentType` | A minimal text input. |
| `Tabs` | `ComponentType` | A minimal tab strip. |

`ComponentType<P = Record<string, unknown>> = (props: P) => unknown` — no
dependency on React or any UI framework (`@tecode/api` has none); the host
substitutes the real React component type at the integration boundary. Use
`List`/`Tree`/`Input`/`Tabs` as JSX (`<List items={...} />`) inside a
component you author, not by calling them as plain functions — see Step 4's
callout for where a real, JSX-based view lives (`explorer`'s
`ExplorerView.tsx`) and why that needs `react`/`@opentui/react` as your own
extension's dependencies.

### `tecode.config` — `ConfigNamespace`

Read access to the merged (defaults ← user ← workspace) settings tree (Req
9, 10.1).

| Member | Signature | Notes |
|---|---|---|
| `get` | `<T = unknown>(key: string) => T` (or `undefined`) | |
| `onDidChange` | `Event<ConfigChangeEvent>` | `ConfigChangeEvent { affectsConfiguration(key: string): boolean }` — reports whether `key` (or a child of it) changed. |

### `tecode.context` — `ContextNamespace`

The flat context-key store `when` clauses evaluate against (Req 4.6, 10.1).

| Member | Signature |
|---|---|
| `set` | `(key: string, value: unknown) => void` |
| `get` | `<T = unknown>(key: string) => T` (or `undefined`) |

### `tecode.languages` — `LanguagesNamespace`

Programmatic language registration — a runtime equivalent of
`contributes.languages` — plus language-ID lookup (Req 8.2, 10.1).

| Member | Signature | Notes |
|---|---|---|
| `register` | `(contribution: LanguageContribution) => Disposable` | See `LanguageContribution` below. |
| `getLanguageId` | `(uri: Uri) => string` | `"plaintext"` if no declared language matches (Req 8.3). |
| `getLanguage` | `(id: string) => LanguageContribution` (or `undefined`) | Reads back a registered language's `comments`/`brackets` metadata without maintaining your own copy. |

`LanguageContribution { id, extensions: string[], grammar, highlights,
comments?: LanguageComments, brackets?: BracketPair[] }` — `extensions`
includes the leading dot (`[".ts", ".tsx"]`); `grammar` and `highlights`
are paths to a tree-sitter WASM grammar and its `.scm` highlight query.
`LanguageComments { line?, block?: [start, end] }`; `BracketPair { open,
close }`.

### `tecode.themes` — `ThemesNamespace`

Theme registration and the active theme (Req 7, 10.1).

| Member | Signature | Notes |
|---|---|---|
| `register` | `(contribution: ThemeContribution) => Disposable` | `ThemeContribution { id, label, path }` — `path` points at the theme's VS Code-subset color JSON. |
| `current` | `readonly ResolvedTheme` | `ResolvedTheme { colors: Record<UiColorKey, RGB>, tokens: Partial<Record<CaptureName, Style>> }` — every color resolved and quantized for the terminal's color depth (Req 7.4). |
| `currentLabel` | `readonly string` | The active theme's display name — the one place `tecode.themes` exposes a human-readable identity (`ThemeRegistry.list`'s id/label listing is a privileged, core-internal surface with no `tecode.*` equivalent). |
| `onDidChange` | `Event<void>` | Fires on `theme.select`'s preview/commit/revert or a live `workbench.colorTheme` config switch. |

`UiColorKey` is a ~57-member string union of VS Code-style color IDs
(`editor.background`, `sideBar.background`, `statusBar.background`, ...);
see `@tecode/api`'s `theme.ts` for the exhaustive list rather than
duplicating all of them here — a theme that omits a key falls back to the
base palette for it. `CaptureName` is `BaseCaptureName` itself, or a dotted
refinement of one (a TypeScript template literal type — `BaseCaptureName`
plus an optional `.<string>` suffix, e.g. `"function.builtin"`, `"string.escape"`).
`BaseCaptureName` is one of `"keyword"`, `"string"`, `"comment"`,
`"function"`, `"type"`, `"variable"`, `"number"`, `"operator"`,
`"punctuation"`; an unstyled refinement falls back to its base capture by
longest-prefix match. `RGB { r, g, b }` (0-255 each). `Style { foreground?,
background?, bold?, italic?, underline? }`.

### `Document` — what `workspace.openDocument`/`window.activeEditor.document` return

Not a `tecode.*` namespace itself, but referenced by two of them above, so
documented here in full (Req 5, design.md §7):

| Member | Signature | Notes |
|---|---|---|
| `uri` | `Uri` | |
| `languageId` | `string` | `"plaintext"` when nothing matches. |
| `version` | `number` | Bumped on every applied edit. |
| `dirty` | `boolean` | |
| `readonly` | `boolean` | Whether the document rejects edits, e.g. files over 10 MB open read-only (Req 5.5). |
| `eol` | `Eol` | Either `"\n"` or `"\r\n"`; detected on load, preserved on save. |
| `applyEdits` | `(edits: TextEdit[]) => void` | The **only** mutation path (Req 5.2) — no `setText`, no direct buffer access. On a readonly document: status-bar error, no-op. |
| `transaction` | `(fn: () => void) => void` | Groups every `applyEdits` call inside `fn` into one undo step (Req 5.4). |
| `undo` / `redo` | `() => Selection[]` (or `undefined`) | `undefined` = nothing to undo/redo; a non-empty array is the selections to restore; an empty array means the entry carried no selection snapshot — treat it the same as `undefined` for caret placement. |
| `onDidChange` | `Event<DocumentChangeEvent>` | Fires once per `applyEdits` call. `DocumentChangeEvent { document, edits, version, dirtyRange, inverseEdits }` — `dirtyRange: { startLine, endLine, lineCountDelta }` is the touched line span (pre-edit coordinates) plus the net line-count change, so a view can repaint only what moved. |

### `ExtensionContext` — what `activate(ctx)` receives

`{ api: Tecode, extensionUri: Uri, subscriptions: Disposable[],
storagePath: string }` (Req 2.6). Covered in full in Step 2 above.

## 3. Bundling extensions with npm dependencies

An extension is a directory with a manifest and a loadable entry point:
`manifest.ts` (or `manifest.js` — `discovery.ts` prefers `.ts`) plus
`index.ts` while you develop, or a bundled `index.js` for distribution.
Note the two preferences run in *opposite* directions: the manifest
resolver prefers `.ts`, while `extensionRecords.ts`'s
`loadUserOrWorkspaceModule` prefers `index.js` over `index.ts` precisely so
a shipped bundle wins over leftover sources. A distributed extension needs
no `index.ts` at all — `extensionBundling.test.ts` deletes it, along with
`node_modules` and `package.json`, and proves the bare `manifest.ts` +
`index.js` pair still loads and activates. Optionally `package.json` and
`node_modules` while developing (Req 10.3). Extensions run under Bun
with unrestricted access to `node:*` modules, `Bun` APIs, and npm packages
(Req 10.2) — nothing is sandboxed.

**Why `index.ts` alone isn't enough once you depend on a real npm
package**: for a `user`/`workspace`-sourced extension, the host loads your
code with a real dynamic `import()` straight off disk
(`packages/cli/src/extensionRecords.ts`'s `loadUserOrWorkspaceModule`),
which Bun transpiles on the fly the same way `bun run` would. That import
resolves any bare specifier (`import ms from "ms"`) using the ordinary
`node_modules` lookup starting at your extension's own directory — so it
works as long as `node_modules` is actually sitting there next to
`index.ts`. That's fine for local development, but shipping a
`node_modules` directory with your extension is heavier than it needs to
be, and doesn't cleanly survive being loaded from inside a compiled
`tecode` binary the way `index.ts` itself does (Req 10.4, design.md §4.4).

**The fix**: bundle your dependencies into a single `index.js` with `bun
build`, and ship that instead. `packages/cli/src/extensionRecords.ts`'s
`loadUserOrWorkspaceModule` checks for `index.js` first and only falls back
to `index.ts` when no `index.js` exists next to `manifest.ts`:

```ts
const jsPath = join(extensionDir, "index.js");
const target = (await pathExists(jsPath)) ? jsPath : join(extensionDir, "index.ts");
return import(pathToFileURL(target).href);
```

(the exact source, quoted verbatim from that module — design.md §4.4 calls
this out explicitly: "Extensions with npm dependencies ship a pre-bundled
`index.js`; the host prefers `index.js` over `index.ts` when both exist.")

**Procedure**, from inside your extension's own directory:

1. `bun add <your-dependency>` (or hand-write a `package.json` and `bun
   install`) — installs it into a local `node_modules`, same as any Bun/npm
   project.
2. `bun build ./index.ts --outfile=index.js --target=bun --format=esm` —
   bundles `index.ts` and every module it imports (including your npm
   dependency's code) into one file. `--format=esm` matters: the host's
   `loadUserOrWorkspaceModule` does a native ESM `import()`, so `index.js`
   has to be loadable that way, not CommonJS. `--target=bun` matches the
   runtime `index.js` actually executes under.
3. Ship `manifest.ts` + `index.js`. `node_modules` and `index.ts` are no
   longer needed at runtime — the bundle is self-contained — though nothing
   stops you keeping `index.ts` around in your own source control; the host
   simply ignores it once `index.js` is present.

**Verified against a real fixture, not asserted**:
`packages/cli/src/extensionBundling.test.ts` runs exactly this procedure
for real — a real `bun install` of a real (if throwaway) npm-shaped
dependency, a real `bun build ./index.ts --outfile=index.js --target=bun
--format=esm` subprocess, then deletes `node_modules`, `index.ts`, and
`package.json` entirely before driving the resulting bare `manifest.ts` +
`index.js` pair through the same real discover → validate → register →
activate pipeline the walkthrough's own fixture test uses, asserting the
extension activates and a command that calls into the bundled dependency's
code returns the right answer. See that file's own TSDoc for why its
dependency is installed via a local `file:` specifier rather than fetched
from the public npm registry (a deliberate hermeticity choice, not a gap in
what's being proven — `bun build`'s bundling behavior doesn't know or care
where a resolved package came from).

## 4. API-version policy

`@tecode/api` exports one piece of runtime code: `API_VERSION`, currently
`"1.0"` (`packages/api/src/index.ts`). A manifest declares
`apiVersion: "<major>"` or `"<major>.<minor>"` (Req 2.7); the host checks
this at registration time — before your `index.ts` is ever imported — via
`checkApiVersionCompatibility` in `packages/core/src/host/validate.ts`.

**The compat rule**, read straight from that function: the manifest's
declared major version must equal the host's, and the host's minor version
must be greater than or equal to the manifest's requested minor version. A
manifest that omits the minor (`apiVersion: "1"`) is treated as requesting
minor `0` — `parseVersion`'s own fallback, `match[2] !== undefined ?
Number(match[2]) : 0`. Concretely, against a host running `API_VERSION =
"1.0"`:

| Manifest's `apiVersion` | Compatible? | Why |
|---|---|---|
| `"1"` or `"1.0"` | yes | same major, `0 >= 0` |
| `"1.1"` | no | `0 >= 1` is false — the manifest asks for a minor feature this host doesn't have yet |
| `"2"` or `"2.0"` | no | major mismatch — the minor is never even compared once the major already differs |
| `"0"` or `"0.5"` | no | major mismatch (`0` vs host's `1`), for the same reason as `"2"` above |

**What happens on a mismatch — skipped, not thrown**: `checkApiVersionCompatibility`
returns `{ compatible: false, reason }` rather than throwing, and
`packages/core/src/host/registration.ts` acts on that by skipping the
extension and recording the reason — the extension never reaches
`activate()`, and every other extension keeps loading normally (Req 2.4,
2.7):

```ts
const compatibility = checkApiVersionCompatibility(manifest.apiVersion);
if (!compatibility.compatible) {
  skipped.push(
    reportSkip(deps, extension, compatibility.reason ?? "incompatible apiVersion"),
  );
  return;
}
```

`reportSkip` turns that into a `HostError` the status-bar/notification
surface reports (design.md §14's "Manifest invalid / API version mismatch"
row: "Skip extension, status-bar error, startup continues") — the same
skip-and-report path an outright-invalid manifest takes, not a distinct
code path with different failure characteristics.

**What the contract suite actually guarantees**:
`packages/core/src/api/create.contract.test.ts` is, by its own TSDoc,
"the compatibility gate for `API_VERSION` bumps" (design.md §16) — assembled
from the real services (`createCommandRegistry`, `createDocumentManager`,
`createConfigService`, `createContextService`, `createFileSystem`), never
fakes, specifically so it catches integration-level wiring mistakes a
per-service unit test can't see. Reading the file rather than its own
summary, it actually asserts:

- **Every namespace is reachable and identical two ways**: `ctx.api.<ns>`
  and the `"tecode"` module alias (`registerTecodeAlias`) point at the
  *same* object for all nine namespaces.
- **Freeze-ness**: `Object.isFrozen(api)` and, separately,
  `Object.isFrozen(namespace)` for every namespace — proven by actually
  attempting a mutation (`mutableApi["commands"] = {}`) and asserting it
  throws `TypeError`, not just checking the flag.
- **`commands` register/dispose symmetry**: a disposed command reports
  "not found" (via the injected `StatusSink`, not a thrown error) on the
  next `execute`, doesn't fire again, and disposing twice is a no-op.
- **`workspace` event ordering**: `onDidOpen` → `onDidSave` → `onDidClose`
  fire in exactly that order for one real document, and none of the three
  fire again once their listeners are disposed.
- **`editor` no-op behavior**: every `editor.*` call with no active editor
  is a genuine no-op that delivers a `HostError` starting with `"No active
  editor"` to the sink rather than throwing to the caller.
- **A full fixture extension touches all nine namespaces** inside one real
  `activate(ctx)`/`deactivate()` cycle without throwing, then proves its
  own `commands.register` was actually undone by post-teardown
  `dispose()` calls (in the reverse order `host/activation.ts`'s
  `disposeSubscriptions` uses).
- Three more `describe` blocks cover `tecode.editor`/`window.activeEditor`
  backed by a real `EditorSessionService` (deep-copy semantics on
  `selections`/`cursor` — mutating a returned selection object must not
  reach back into live state) and `tecode.editor.find` backed by a real
  `FindService`, including two regression cases (PR #59) proving a
  mismatched or absent `editorSession`/`findService` pairing falls back to
  a fully inert stub rather than silently mutating the wrong document.

**How a breaking change is communicated**: per `create.contract.test.ts`'s
own TSDoc, "a future `API_VERSION` bump ... that changes what a namespace
guarantees should break a test in this file first, before it ever reaches
a real extension." Concretely: `API_VERSION`'s major component only ever
changes for a change incompatible with existing manifests (per
`checkApiVersionCompatibility`'s own rule above, this is the *only* thing
that can make a previously-compatible manifest stop loading) — and any
such change to what a namespace does is expected to falsify at least one of
this file's own assertions above, which a maintainer bumping
`API_VERSION` is expected to update deliberately, in the same commit, as a
record of exactly what changed. An extension author's own signal is
simpler: your manifest's declared `apiVersion` either satisfies the compat
rule against whatever host loads it, or your extension is skipped with a
reason string naming exactly which check failed (the "major version
mismatch" / "requires minor version >=" messages quoted above) — there is
no silent partial-compatibility mode.

## What remains unverified

Per this repository's own completion requirements for Issue #37: following
this walkthrough **on a released binary** is not verified by anything in
this change. There is no released `tecode` binary to test against in this
environment (`docs/manual-release-verification.md` documents the same gap
for Issue #35's compiled-binary work, for the same underlying reason — no
target-platform machine and no real TTY here), and this environment has no
TTY, so a human watching the sidebar icon appear, the notification render,
or the keybinding fire on a real terminal has not happened as part of this
change. What **is** verified, for real, against the real pipeline:

- `packages/cli/src/extensionAuthoringGuideWalkthrough.test.ts` extracts
  this document's `manifest.ts`/`index.ts` listings by exact text and
  drives them through the real `loadExtensions` → `buildExtensionRecords` →
  `createExtensionHost` pipeline (the same one `packages/cli/src/main.ts`
  wires up for a real run), asserting the extension reaches `"active"`,
  its command executes and returns the expected value, its view resolves
  to a real (non-lazy) component, and its configuration key's default
  reads back correctly through `tecode.config.get`.
- `packages/cli/src/extensionBundling.test.ts` proves the bundling
  procedure in [§3](#3-bundling-extensions-with-npm-dependencies) for real,
  through the same pipeline, against a real `bun build` output with
  `node_modules`/`index.ts` deleted before the host ever sees it.

Neither of those is a substitute for a human running a compiled binary on
a real terminal and watching this walkthrough work end to end — that
remains an open manual-verification gap, exactly like the three gaps
`docs/manual-release-verification.md` documents for Issue #35.
