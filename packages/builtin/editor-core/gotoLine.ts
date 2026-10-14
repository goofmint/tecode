/**
 * Pure validation/resolution for `editor.action.gotoLine` (Issue #162,
 * Emacs' `goto-line` / VS Code's Ctrl+G equivalent). Input is taken
 * 1-based (matching the status bar's `Ln <line+1>` display —
 * `statusbar/index.ts`), converted here to a 0-based {@link Position} the
 * way every other part of this package represents document positions
 * (`movement.ts`). No document mutation and no `@tecode/core` import
 * (only `@tecode/api`'s `Position` type, same as `movement.ts`) — this
 * module only reads the two plain values its callers already have
 * (`value`, `lineCount`), so it is trivial to unit test in isolation.
 */

import type { Position } from "@tecode/api";

/** Extracts the line-number portion of `value` — split out on its own so a
 * future `<line>:<column>` extension (Issue #162's "論点 3", deliberately
 * out of scope here) can reuse this same parsing without touching
 * {@link validateGotoLineInput}/{@link resolveGotoLinePosition}'s own
 * logic. Trims surrounding whitespace; does not itself validate the
 * result. */
function extractLinePart(value: string): string {
  return value.trim();
}

/**
 * Validates a `showInputBox` value for `editor.action.gotoLine` — called
 * on every keystroke (`InputBoxOptions.validateInput`'s documented
 * contract) and again, defensively, right before the handler acts on the
 * resolved value (the `commands.execute` bypass explorer's rename/create
 * commands guard against). Returns an error message for: an empty/
 * whitespace-only value, a value that is not a valid integer (including
 * fractional numbers), a value below 1, or a value beyond `lineCount`.
 * Returns `undefined` when `value` is a valid 1-based line number.
 */
export function validateGotoLineInput(value: string, lineCount: number): string | undefined {
  const linePart = extractLinePart(value);
  if (linePart === "") return "Enter a line number.";
  if (!/^\d+$/.test(linePart)) return "Enter a valid line number.";
  const line = Number(linePart);
  if (line < 1 || line > lineCount) {
    return `Line number must be between 1 and ${lineCount}.`;
  }
  return undefined;
}

/**
 * Resolves a validated `showInputBox` value into the target {@link
 * Position}: the 1-based `value` becomes a 0-based `line`, clamped to
 * `[0, lineCount - 1]` (defense in depth — every caller is expected to
 * have already run {@link validateGotoLineInput}), with `character: 0`
 * (Emacs' `goto-line` lands at the start of the line, per Issue #162).
 */
export function resolveGotoLinePosition(value: string, lineCount: number): Position {
  const linePart = extractLinePart(value);
  const requestedLine = Number(linePart) - 1;
  const maxLine = Math.max(0, lineCount - 1);
  const line = Math.min(Math.max(requestedLine, 0), maxLine);
  return { line, character: 0 };
}
