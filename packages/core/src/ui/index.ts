// The UI shell (Req 6.1-6.5, 7.3, design.md §8, §9; Task 1.14): slot
// registry, layout-state persistence, theming, focus tracking, the common
// component library, and the Shell/ActivityBar/Sidebar/EditorArea/Panel/
// StatusBar components themselves.

export {
  createSlotRegistry,
  type RegisterViewMeta,
  type SidebarPair,
  type SlotRegistry,
  type SlotRegistryDeps,
  type SlotViewEntry,
  type StatusBarPlacement,
} from "./slotRegistry";

export {
  createLayoutStateService,
  DEFAULT_LAYOUT_STATE,
  type LayoutState,
  type LayoutStateFs,
  type LayoutStateService,
  type LayoutStateServiceDeps,
  type LayoutStateTimer,
} from "./layoutState";

export {
  ThemeProvider,
  toColorInput,
  styleToTextColors,
  useLiveTheme,
  useTheme,
  type ThemeProviderProps,
} from "./theme";

export {
  buildXterm256Palette,
  quantizeTheme,
  quantizeToXterm256,
} from "./colorQuantize";

export {
  loadThemeFallbackForReadError,
  loadThemeFromJsonText,
  parseHexColor,
  resolveCaptureStyle,
  type LoadThemeOptions,
  type ThemeJson,
  type ThemeTokenStyleJson,
} from "./themeLoader";

export {
  BASE_THEME_ID,
  BASE_THEME_LABEL,
  createThemeRegistry,
  type ColorDepth,
  type ThemeListEntry,
  type ThemeRegistry,
  type ThemeRegistryDeps,
  type ThemeRegistryEntry,
  type ThemeRegistryFs,
} from "./themeRegistry";

export {
  createThemeService,
  type ThemeService,
  type ThemeServiceDeps,
} from "./themeService";

export {
  applyColorThemeSetting,
  createThemeSettingsWriter,
  type ThemeSettingsWriter,
  type ThemeSettingsWriterDeps,
  type ThemeSettingsWriterFs,
} from "./themeSettingsWriter";

export {
  createThemeSelectHandler,
  registerThemeSelectCommand,
  THEME_SELECT_COMMAND_ID,
  type ThemeSelectDeps,
} from "./themeSelectCommand";

export {
  createOpenFileCommandHandler,
  HIDDEN_FROM_LISTINGS_WHEN,
  OPEN_FILE_COMMAND_ID,
  registerOpenFileCommand,
  type OpenFileCommandDeps,
} from "./openFileCommand";

export {
  applyConfiguredTheme,
  wireThemeConfigSync,
  type WireThemeConfigSyncDeps,
} from "./themeConfigSync";

export {
  createShowPanelCommandHandler,
  registerShowPanelCommand,
  SHOW_PANEL_COMMAND_ID,
  type ShowPanelCommandDeps,
} from "./panelCommands";

export {
  createExtensionsReloadHandler,
  EXTENSIONS_RELOAD_COMMAND_ID,
  registerExtensionsReloadCommand,
  type ExtensionsReloadDeps,
} from "./extensionsReloadCommand";

export {
  createKeybindingsCommandsHandlers,
  KEYBINDINGS_ENSURE_FILE_COMMAND_ID,
  KEYBINDINGS_RESOLVE_TABLE_COMMAND_ID,
  KEYBINDINGS_TEMPLATE,
  registerKeybindingsCommands,
  type KeybindingsCommandsDeps,
  type KeybindingsCommandsFs,
  type KeybindingsCommandsHandlers,
  type KeybindingsCommandsRegistrar,
  type ResolvedBindingRow,
} from "./keybindingsCommands";

export {
  ContextFocusTracker,
  useFocusTracking,
  type ContextFocusTrackerProps,
  type FocusableNode,
  type FocusEmitter,
} from "./focus";

export {
  Input,
  List,
  RegisteredView,
  TAB_DIRTY_MARKER,
  Tabs,
  Tree,
  type InputProps,
  type ListItem,
  type ListProps,
  type TabItem,
  type TabsProps,
  type TreeNode,
  type TreeProps,
} from "./components";

export {
  ActivityBar,
  EditorArea,
  Panel,
  Shell,
  Sidebar,
  StatusBar,
  type ActivityBarProps,
  type EditorAreaProps,
  type PanelProps,
  type ShellProps,
  type SidebarProps,
  type StatusBarProps,
} from "./shell";

export { cellWidth, cellWidthUpTo, truncateToWidth } from "./cellWidth";

export {
  computeVisibleLineRange,
  gutterDigitWidth,
  revealLine,
  type VisibleLineRange,
} from "./viewport";

export {
  createInitialEditorState,
  createInitialFindState,
  useLineTicks,
  type EditorState,
  type FindState,
  type LineTicks,
} from "./editorState";

export {
  createFindService,
  type FindService,
  type FindServiceDeps,
} from "./findService";

export { FindWidget, type FindWidgetProps } from "./findWidget";

export { cursorCellColumn, EditorView, type EditorViewProps } from "./editorView";

export {
  buildTerminalRowRuns,
  TerminalGridView,
  type TerminalGridViewProps,
  type TerminalRowRun,
} from "./terminalGridView";

export {
  createEditorSessionService,
  type EditorSessionService,
  type EditorSessionServiceDeps,
} from "./editorSession";

export {
  wireEditorLangIdContext,
  type WireEditorLangIdContextDeps,
} from "./editorLangId";

export {
  createModalService,
  filterQuickPickItems,
  type ModalService,
  type ModalState,
} from "./modalService";

export {
  INPUT_BOX_FOCUS_CONTEXT_KEY,
  MODAL_ACCEPT_COMMAND,
  MODAL_CLOSE_COMMAND,
  MODAL_DEFAULT_KEYBINDINGS,
  MODAL_SELECT_NEXT_COMMAND,
  MODAL_SELECT_PREVIOUS_COMMAND,
  QUICK_PICK_FOCUS_CONTEXT_KEY,
  registerModalCommands,
  type ModalCommandsRegistrar,
} from "./modalCommands";

export { ModalOverlay, type ModalOverlayProps } from "./modalOverlay";

export {
  createCloseDocumentWithPrompt,
  createTabCommandHandlers,
  registerTabCommands,
  TAB_CLOSE_COMMAND,
  TAB_CLOSE_OTHERS_COMMAND,
  TAB_DEFAULT_KEYBINDINGS,
  TAB_NEXT_COMMAND,
  TAB_PREVIOUS_COMMAND,
  type CloseOutcome,
  type TabCommandHandlers,
  type TabCommandsDeps,
  type TabCommandsRegistrar,
} from "./tabCommands";

export {
  createWindowMessageService,
  DEFAULT_MESSAGE_TIMEOUT_MS,
  WINDOW_MESSAGE_STATUS_BAR_ITEM_ID,
  type WindowMessageService,
  type WindowMessageServiceDeps,
} from "./windowMessageService";

export {
  createHostErrorStatusSink,
  DEFAULT_HOST_ERROR_TIMEOUT_MS,
  HOST_ERROR_STATUS_BAR_ITEM_ID,
  HOST_ERROR_STATUS_BAR_PRIORITY,
  type HostErrorStatusSink,
  type HostErrorStatusSinkDeps,
} from "./hostErrorSink";

export {
  CHORD_PENDING_STATUS_BAR_ITEM_ID,
  CHORD_PENDING_STATUS_BAR_PRIORITY,
  createChordPendingIndicator,
  type ChordPendingIndicatorDeps,
} from "./chordPendingIndicator";
