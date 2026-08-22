/**
 * Theming types (Req 7, design.md §9).
 */

/**
 * The UI color keys a theme can supply, reusing VS Code's color IDs so
 * existing VS Code theme knowledge transfers directly (Req 7.2). This is
 * the "approximately 40 keys" set called out in Req 7.2; the six keys
 * named explicitly there (`editor.background`, `editor.foreground`,
 * `sideBar.background`, `statusBar.background`, `tab.activeBackground`,
 * `list.activeSelectionBackground`) are included below. A theme that omits
 * a key falls back to the built-in base palette for it (design.md §9).
 */
export type UiColorKey =
  | "focusBorder"
  | "foreground"
  | "editor.background"
  | "editor.foreground"
  | "editor.lineHighlightBackground"
  | "editor.selectionBackground"
  | "editor.selectionForeground"
  | "editor.inactiveSelectionBackground"
  | "editorLineNumber.foreground"
  | "editorLineNumber.activeForeground"
  | "editorCursor.foreground"
  | "editorIndentGuide.background"
  | "editorIndentGuide.activeBackground"
  | "editorWhitespace.foreground"
  | "activityBar.background"
  | "activityBar.foreground"
  | "activityBar.inactiveForeground"
  | "activityBar.border"
  | "activityBarBadge.background"
  | "activityBarBadge.foreground"
  | "sideBar.background"
  | "sideBar.foreground"
  | "sideBar.border"
  | "sideBarTitle.foreground"
  | "sideBarSectionHeader.background"
  | "statusBar.background"
  | "statusBar.foreground"
  | "statusBar.border"
  | "statusBar.debuggingBackground"
  | "statusBarItem.hoverBackground"
  | "tab.activeBackground"
  | "tab.activeForeground"
  | "tab.inactiveBackground"
  | "tab.inactiveForeground"
  | "tab.border"
  | "tab.activeBorder"
  | "panel.background"
  | "panel.border"
  | "panelTitle.activeForeground"
  | "panelTitle.inactiveForeground"
  | "input.background"
  | "input.foreground"
  | "input.border"
  | "input.placeholderForeground"
  | "list.activeSelectionBackground"
  | "list.activeSelectionForeground"
  | "list.inactiveSelectionBackground"
  | "list.hoverBackground"
  | "list.focusBackground"
  | "scrollbarSlider.background"
  | "scrollbarSlider.hoverBackground"
  | "badge.background"
  | "badge.foreground"
  | "button.background"
  | "button.foreground";

/**
 * Base tree-sitter capture names for syntax highlighting (decision #3 in
 * requirements.md; Req 7.2, 8.1). A compatibility mapping from VS Code
 * TextMate scopes is out of scope for the MVP (design.md §18).
 */
export type BaseCaptureName =
  | "keyword"
  | "string"
  | "comment"
  | "function"
  | "type"
  | "variable"
  | "number"
  | "operator"
  | "punctuation";

/**
 * A tree-sitter capture name, either a base name or a dotted refinement of
 * one (e.g. `"function.builtin"`, `"string.escape"`). Refinements that a
 * theme does not style explicitly fall back to their base capture by
 * longest-prefix match (design.md §9).
 */
export type CaptureName = BaseCaptureName | `${BaseCaptureName}.${string}`;

/** A resolved, quantization-ready RGB color (0-255 per channel). */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** A resolved text style for one syntax capture. */
export interface Style {
  foreground?: RGB;
  background?: RGB;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/**
 * A fully resolved theme, ready to render: every {@link UiColorKey} has
 * been filled in (from the theme's JSON, falling back to the base palette)
 * and colors are already quantized for the terminal's detected color depth
 * (Req 7.4).
 *
 * `tokens` is keyed by {@link CaptureName}, which includes an infinite
 * template-literal union (`` `${BaseCaptureName}.${string}` ``) — no
 * concrete value can ever supply every possible key, so this is a
 * `Partial` index rather than a full `Record`. Consumers should resolve a
 * capture by exact match first, then fall back to its base capture name.
 */
export interface ResolvedTheme {
  colors: Record<UiColorKey, RGB>;
  tokens: Partial<Record<CaptureName, Style>>;
}
