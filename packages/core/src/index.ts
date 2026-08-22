// Placeholder entry point for @tecode/core. Real wiring lands in later tasks.
export { HOST_PLACEHOLDER } from "./host/index";
export {
  createCommandRegistry,
  isValidCommandId,
  type CommandRegistry,
  type CommandRegistryDeps,
} from "./commands/index";
export {
  CHORD_TIMEOUT_MS,
  compileWhen,
  createBindingTable,
  createChordStateMachine,
  createContextService,
  normalizeKey,
  normalizeKeySequence,
  WhenParseError,
  type BindingLayer,
  type BindingTable,
  type BindingTableDeps,
  type ChordScheduler,
  type ChordStateMachine,
  type ChordStateMachineDeps,
  type CompiledWhen,
  type ContextService,
  type KeymapLayers,
  type ResolvedBinding,
  type WhenAndNode,
  type WhenContextGetter,
  type WhenEqNode,
  type WhenKeyNode,
  type WhenNode,
  type WhenNotNode,
  type WhenOrNode,
} from "./keymap/index";
export {
  createDocument,
  createLineBuffer,
  createSystemClock,
  createUndoStack,
  TYPING_COALESCE_WINDOW_MS,
  type AppliedEdit,
  type ApplyEditsOptions,
  type Clock,
  type CoreDocument,
  type CreateDocumentOptions,
  type LineBuffer,
  type PushInput,
  type TypingCoalesceHint,
  type UndoEntry,
  type UndoStack,
  type UndoStackDeps,
} from "./buffer/index";
export { UI_PLACEHOLDER } from "./ui/index";
export { CONFIG_PLACEHOLDER } from "./config/index";
export { API_BUILDER_PLACEHOLDER } from "./api/index";
