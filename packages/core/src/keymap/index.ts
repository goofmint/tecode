// The keymap service (design.md §6): the when-clause evaluator (§6.4),
// context service, layered binding table (§6.2), and chord state machine
// (§6.3, Req 4.4) are wired up here. The full input pipeline (§6.1) —
// subscribing to real OpenTUI key events and driving this state machine
// from them — lands with the UI shell task.

export {
  compileWhen,
  WhenParseError,
  type CompiledWhen,
  type WhenAndNode,
  type WhenContextGetter,
  type WhenEqNode,
  type WhenKeyNode,
  type WhenNode,
  type WhenNotNode,
  type WhenOrNode,
} from "./when";
export { createContextService, type ContextService } from "./context";
export { normalizeKey, normalizeKeySequence } from "./normalize";
export { keyEventToStroke, type KeyEventLike } from "./keyEvent";
export {
  createBindingTable,
  type BindingLayer,
  type BindingTable,
  type BindingTableDeps,
  type KeymapLayers,
  type ResolvedBinding,
} from "./bindingTable";
export {
  createChordStateMachine,
  CHORD_TIMEOUT_MS,
  type ChordStateMachine,
  type ChordStateMachineDeps,
  type ChordScheduler,
} from "./chords";
export {
  BUNDLED_FALLBACK_KEYBINDINGS,
  loadFallbackKeybindings,
  type FallbackKeybindingsFs,
  type LoadFallbackKeybindingsDeps,
} from "./fallbackKeybindings";
