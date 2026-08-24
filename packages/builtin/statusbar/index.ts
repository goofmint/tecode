/**
 * `statusbar`'s `activate(ctx)` (Task 3.4, Req 11.6; design.md §13:
 * "subscribes to active-editor selection changes, document events, and
 * theme changes; registers left items (language, EOL, dirty) and right
 * items (line/column, theme name) via `setStatusBarItem`"). Only imports
 * `@tecode/api` (the ESLint layering rule) — every read/write goes through
 * `ctx.api`; the two CORE-INTERNAL status bar surfaces this task also
 * covers (the chord-pending indicator, the host-error sink) are wired
 * directly at the composition root instead (`ui/chordPendingIndicator.ts`,
 * `ui/hostErrorSink.ts`) — a plain extension has no access to
 * `ChordStateMachine`/`StatusSink`.
 *
 * **Left-to-right layout** (design.md §13's own left/right split, Req
 * 5.5's read-only indicator folded in): left side, descending priority —
 * language id (30), EOL style (20), read-only (15), dirty (10); right
 * side — cursor line/column (20), active theme name (10). Every item is
 * PER-ACTIVE-DOCUMENT except the theme name, which is global; with no
 * active editor, every left/right item except the theme name is removed
 * outright (`setItem`'s `undefined` branch) rather than showing stale or
 * placeholder text.
 *
 * **Read-only vs. dirty are mutually exclusive by construction** (Req 5.5,
 * design.md §7.1: "> 10 MB sets `readonly: true`"; `Document.applyEdits`'s
 * own TSDoc: "On a `readonly` document this... does nothing" — a readonly
 * document can never become dirty) but are still two SEPARATE status bar
 * items, not one combined indicator, so each traces directly to its own
 * bullet in Req 11.6/this task's plan and neither's id/priority depends on
 * the other's current value.
 *
 * **Update mechanics — dispose-then-re-register, not a raw re-
 * `registerView` call** (the plan's "IMPORTANT mechanics check"): `tecode.
 * window.setStatusBarItem` (`windowMessageService.ts`'s real backing)
 * calls `SlotRegistry.registerView` fresh on every invocation, and
 * `registerView` on an id that already holds a NON-lazy entry logs a
 * "View re-registered" warning every time (`slotRegistry.ts`'s
 * `storeEntry`) — acceptable for an occasional `showMessage` call, but this
 * builtin's items update on every keystroke/cursor move. {@link setItem}
 * therefore disposes the PREVIOUS registration (if any) before calling
 * `setStatusBarItem` again, so the registry never sees back-to-back
 * registrations under the same still-live id — the exact mechanics
 * `windowMessageService.ts`'s own `showMessage`/`hostErrorSink.ts`'s
 * `error()` already use for the identical "update by replacing" problem.
 *
 * **Live updates, precisely**: `api.editor.onDidChange` (Req 11.6, fires on
 * both an active-editor SWITCH and a plain cursor/selection move,
 * `@tecode/api`'s own TSDoc) and `api.themes.onDidChange` both trigger a
 * full {@link renderAll} — the "just re-read every getter" pattern this
 * task's plan calls for, cheap enough (five plain reads plus at most five
 * dispose+register pairs) not to need finer-grained diffing. `api.
 * workspace.onDidOpen`/`onDidClose`/`onDidSave` do the same, since any of
 * the three can change which document is active (open/close) or its dirty
 * state (save). Additionally, {@link syncActiveDocumentSubscription} keeps
 * exactly one live `document.onDidChange` subscription pointed at whichever
 * document is CURRENTLY active — re-subscribed (old one disposed first)
 * only when the active document's `uri` actually changes, not on every
 * `editor.onDidChange` firing (a plain cursor move must not tear down and
 * rebuild this subscription) — so a plain text edit (which bumps `dirty`
 * without moving the cursor or firing any of the other four events) still
 * triggers a redraw.
 */

import type { Disposable, Document, ExtensionContext, StatusBarItem, Tecode, Uri } from "@tecode/api";

/** Every id this builtin registers, namespaced like every other core/
 * built-in status bar item (`tecode.window.message`, `tecode.host.error`). */
const LANGUAGE_ITEM_ID = "tecode.statusbar.language";
const EOL_ITEM_ID = "tecode.statusbar.eol";
const READONLY_ITEM_ID = "tecode.statusbar.readonly";
const DIRTY_ITEM_ID = "tecode.statusbar.dirty";
const CURSOR_ITEM_ID = "tecode.statusbar.cursor";
const THEME_ITEM_ID = "tecode.statusbar.theme";

/** Pad an item's text with a leading/trailing space — `StatusBar` (`ui/
 * shell.tsx`) renders adjacent items as immediately-touching `<text>` runs
 * with no separator of its own, so each of THIS builtin's segments pads
 * itself for visual separation (matches `windowMessageService.ts`'s own
 * `kindGlyph`-as-prefix convention of formatting for display at the call
 * site, not relying on the renderer to add spacing). */
function pad(text: string): string {
  return ` ${text} `;
}

/** `doc.eol`'s display form (Req 11.6). */
function eolLabel(eol: Document["eol"]): string {
  return eol === "\r\n" ? "CRLF" : "LF";
}

/** `Ln <line>, Col <character>`, 1-based (Req 11.6) — matches this
 * codebase's existing status bar text convention (`ui/shell.test.tsx`'s
 * `"Ln 1, Col 1"` fixture). */
function cursorLabel(line: number, character: number): string {
  return `Ln ${line + 1}, Col ${character + 1}`;
}

/**
 * Build and register `statusbar`'s six items (Task 3.4, Req 11.6). Kept as
 * a small class-free closure (house convention: `createX(deps)` factories,
 * not classes) so `activate`/`deactivate` stay thin.
 */
function createStatusBarRenderer(api: Tecode): { renderAll(): void; dispose(): void } {
  /** One `Disposable` per currently-registered item id — `undefined`
   * (absent from the map) means that item is not currently shown. Shared
   * "dispose old, register new" helper is {@link setItem} below. */
  const registrations = new Map<string, Disposable>();

  /** Dispose-then-re-register (this module's TSDoc) — `undefined` disposes
   * and leaves the item absent, matching a no-active-editor/clean-document
   * state. */
  function setItem(id: string, item: StatusBarItem | undefined): void {
    registrations.get(id)?.dispose();
    registrations.delete(id);
    if (item) registrations.set(id, api.window.setStatusBarItem(item));
  }

  function renderLanguage(document: Document | undefined): void {
    setItem(
      LANGUAGE_ITEM_ID,
      document && { id: LANGUAGE_ITEM_ID, text: pad(document.languageId), side: "left", priority: 30 },
    );
  }

  function renderEol(document: Document | undefined): void {
    setItem(
      EOL_ITEM_ID,
      document && { id: EOL_ITEM_ID, text: pad(eolLabel(document.eol)), side: "left", priority: 20 },
    );
  }

  function renderReadonly(document: Document | undefined): void {
    setItem(
      READONLY_ITEM_ID,
      document?.readonly ? { id: READONLY_ITEM_ID, text: pad("Read-Only"), side: "left", priority: 15 } : undefined,
    );
  }

  function renderDirty(document: Document | undefined): void {
    setItem(
      DIRTY_ITEM_ID,
      document?.dirty ? { id: DIRTY_ITEM_ID, text: pad("●"), side: "left", priority: 10 } : undefined,
    );
  }

  function renderCursor(): void {
    const editor = api.window.activeEditor;
    const active = editor?.selections[0]?.active;
    setItem(
      CURSOR_ITEM_ID,
      active
        ? { id: CURSOR_ITEM_ID, text: pad(cursorLabel(active.line, active.character)), side: "right", priority: 20 }
        : undefined,
    );
  }

  function renderTheme(): void {
    setItem(THEME_ITEM_ID, {
      id: THEME_ITEM_ID,
      text: pad(api.themes.currentLabel),
      side: "right",
      priority: 10,
    });
  }

  function renderAll(): void {
    const document = api.window.activeEditor?.document;
    renderLanguage(document);
    renderEol(document);
    renderReadonly(document);
    renderDirty(document);
    renderCursor();
    renderTheme();
  }

  function dispose(): void {
    for (const registration of registrations.values()) registration.dispose();
    registrations.clear();
  }

  return { renderAll, dispose };
}

export function activate(ctx: ExtensionContext): void {
  const { api } = ctx;
  const renderer = createStatusBarRenderer(api);

  // Re-subscribed only when the active document's `uri` actually changes
  // (this module's TSDoc) — not on every `editor.onDidChange`/`renderAll`
  // call, so a plain cursor move never tears down and rebuilds this
  // subscription.
  let activeDocUri: Uri | undefined;
  let activeDocSub: Disposable | undefined;
  function syncActiveDocumentSubscription(): void {
    const document = api.window.activeEditor?.document;
    if (document?.uri === activeDocUri) return;
    activeDocSub?.dispose();
    activeDocUri = document?.uri;
    activeDocSub = document?.onDidChange(() => renderer.renderAll());
  }

  function onLiveChange(): void {
    syncActiveDocumentSubscription();
    renderer.renderAll();
  }

  ctx.subscriptions.push(api.editor.onDidChange(onLiveChange));
  ctx.subscriptions.push(api.themes.onDidChange(() => renderer.renderAll()));
  ctx.subscriptions.push(api.workspace.onDidOpen(onLiveChange));
  ctx.subscriptions.push(api.workspace.onDidClose(onLiveChange));
  ctx.subscriptions.push(api.workspace.onDidSave(onLiveChange));
  ctx.subscriptions.push({
    dispose() {
      activeDocSub?.dispose();
      renderer.dispose();
    },
  });

  syncActiveDocumentSubscription();
  renderer.renderAll();
}

export function deactivate(): void {
  // Nothing beyond `ctx.subscriptions` (disposed by the host, Req 2.6) —
  // this extension owns no other resources.
}
