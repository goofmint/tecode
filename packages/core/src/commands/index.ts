// The command registry (Req 3, design.md §5).
export {
  createCommandRegistry,
  isValidCommandId,
  type CommandRegistry,
  type CommandRegistryDeps,
  type RegisterLazyOptions,
} from "./registry";
