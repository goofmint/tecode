// Placeholder entry point for @tecode/core. Real wiring lands in later tasks.
export { HOST_PLACEHOLDER } from "./host/index";
export {
  createCommandRegistry,
  isValidCommandId,
  type CommandRegistry,
  type CommandRegistryDeps,
} from "./commands/index";
export {
  compileWhen,
  createBindingTable,
  createContextService,
  normalizeKey,
  WhenParseError,
  type BindingLayer,
  type BindingTable,
  type BindingTableDeps,
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
export { BUFFER_PLACEHOLDER } from "./buffer/index";
export { UI_PLACEHOLDER } from "./ui/index";
export { CONFIG_PLACEHOLDER } from "./config/index";
export { API_BUILDER_PLACEHOLDER } from "./api/index";
