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
  useTheme,
  type ThemeProviderProps,
} from "./theme";

export {
  ContextFocusTracker,
  useFocusTracking,
  type ContextFocusTrackerProps,
  type FocusEmitter,
} from "./focus";

export {
  Input,
  List,
  RegisteredView,
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
