// The editor input-routing domain (Task 2.2, design.md §6.1, §8.3):
// mapping a batch of `TextEdit`s onto cursor positions
// (`positionTransform.ts`), and turning keymap-fallthrough key events into
// multi-cursor `applyEdits` calls (`inputRouter.ts`).

export { comparePositions, transformPosition } from "./positionTransform";
export {
  createEditorInputRouter,
  type EditorInputRouter,
  type EditorInputRouterDeps,
} from "./inputRouter";
