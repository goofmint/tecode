/**
 * Guards every hand-wrapped Markdown doc in this repository against one
 * specific rendering defect: an inline-code span whose content is broken
 * across a source line at a point where the break is NOT a word boundary.
 *
 * Markdown collapses the newline inside a `` `...` `` span into a single
 * space, so source text like
 *
 * ```md
 * the bundled keymap (`packages/core/src/keymap/
 * keybindings.fallback.json`) ships …
 * ```
 *
 * renders as `packages/core/src/keymap/ keybindings.fallback.json` — a
 * path that does not exist and that a reader copies straight out of the
 * rendered page. The source looks correct in an editor, which is exactly
 * why this needs a test rather than review attention (it reached `main`
 * in `docs/` and was only caught on README by a reviewer).
 *
 * **Why the rule keys on the character before the break, not on "spans
 * must be single-line"**: plenty of spans legitimately wrap, because they
 * quote a shell command whose arguments are space-separated —
 * `` `grep -rn "process.platform" packages` `` reads identically whether
 * the break lands before `"process` or not, since a space belongs there.
 * The corrupting case is a break immediately after a character that never
 * has a space after it inside a path, filename, or identifier: `/`, `\`,
 * `.`, `-`, `_`. Flagging exactly those catches every real defect found
 * so far while leaving legitimately-wrapped command spans alone.
 *
 * Fenced code blocks are exempt: a fence preserves its newlines verbatim,
 * so a break inside one is not a rendering defect.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Characters that never have a space after them inside a path, filename,
 * or identifier — so a line break immediately following one renders as a
 * space that corrupts the span's content.
 */
const NEVER_FOLLOWED_BY_SPACE = new Set(["/", "\\", ".", "-", "_"]);

interface BadBreak {
  readonly file: string;
  readonly line: number;
  readonly rendered: string;
}

/**
 * Walk `markdown` character by character, toggling in/out of inline-code
 * on each backtick and skipping fenced blocks, and report every span that
 * breaks across a line right after a {@link NEVER_FOLLOWED_BY_SPACE}
 * character.
 *
 * Deliberately a small hand-rolled scanner rather than a Markdown parser
 * dependency: the property under test is about the RAW source layout, and
 * a parser hands back an already-collapsed string in which the defect is
 * no longer visible.
 */
function findBadBreaks(file: string, markdown: string): readonly BadBreak[] {
  const found: BadBreak[] = [];
  let inFence = false;
  let inCode = false;
  let buffer = "";
  let openedAtLine = 0;

  const lines = markdown.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (const character of line) {
      if (character !== "`") {
        if (inCode) buffer += character;
        continue;
      }
      if (!inCode) {
        inCode = true;
        buffer = "";
        openedAtLine = index + 1;
        continue;
      }
      inCode = false;
      for (const [offset, seam] of [...buffer].entries()) {
        if (seam !== "\n") continue;
        const before = buffer[offset - 1];
        if (before !== undefined && NEVER_FOLLOWED_BY_SPACE.has(before)) {
          found.push({
            file,
            line: openedAtLine,
            rendered: buffer.replaceAll(/\s*\n\s*/gu, " "),
          });
          break;
        }
      }
    }

    // An unterminated span continues onto the next source line; record the
    // break so the seam check above can see it.
    if (inCode) buffer += "\n";
  }

  return found;
}

function markdownFiles(): readonly string[] {
  const docs = readdirSync(join(REPO_ROOT, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join("docs", name));
  return ["README.md", ...docs.sort()];
}

test("every repository Markdown doc is free of corrupting inline-code line breaks", () => {
  const files = markdownFiles();
  // Guards against the whole suite passing vacuously if the docs move or
  // the directory listing silently returns nothing.
  expect(files.length).toBeGreaterThan(1);
  expect(files).toContain("README.md");

  const bad = files.flatMap((file) =>
    findBadBreaks(file, readFileSync(join(REPO_ROOT, file), "utf8")),
  );

  expect(
    bad.map(({ file, line, rendered }) => `${file}:${line} renders as \`${rendered}\``),
  ).toEqual([]);
});

test("the scanner actually detects a corrupting break, and tolerates a legitimate one", () => {
  const corrupted = findBadBreaks(
    "fixture.md",
    "the keymap (`packages/core/src/keymap/\nkeybindings.fallback.json`) ships\n",
  );
  expect(corrupted).toHaveLength(1);
  expect(corrupted[0]?.rendered).toBe("packages/core/src/keymap/ keybindings.fallback.json");

  // A break at a real word boundary renders correctly and must not be
  // flagged, or the rule would force unnatural wrapping on command spans.
  expect(findBadBreaks("fixture.md", 'run `grep -rn\n"process.platform" packages` now\n')).toEqual(
    [],
  );

  // A fenced block preserves its newlines verbatim — not a defect.
  expect(
    findBadBreaks("fixture.md", "```md\nsee `packages/core/src/keymap/\nkeybindings.json`\n```\n"),
  ).toEqual([]);
});
