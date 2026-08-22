// The keymap service (design.md §6): the when-clause evaluator (§6.4) and
// context service land here first; the input pipeline, resolution model
// (§6.2), and chord state machine (§6.3) are later tasks.
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
