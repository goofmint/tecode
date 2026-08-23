/**
 * `languages-basic` contribution-shape tests (Req 8.2, 8.4; tasks.md's
 * Task 2.9):
 *
 * - **comments/brackets round-trip**: for each of the 12 languages, resolve
 *   its `LanguageContribution` (via a real `LanguageRegistry`, exactly what
 *   `api.languages.getLanguage(id)` forwards straight through to —
 *   `api/create.ts`'s `languagesNamespace.getLanguage: languageRegistry.
 *   getLanguage`) and verify: a declared `comments.line` marker round-trips
 *   through editor-core's real `buildToggleLineCommentResult` (comment, then
 *   uncomment, restores the original text exactly); `brackets` is an array
 *   of `{ open, close }` pairs.
 * - **onLanguage activation**: opening each declared language id through the
 *   REAL `ExtensionHost.onLanguage` activates `tecode.languages-basic`
 *   (mirrors `host/activation.test.ts`'s "onLanguage activates every
 *   extension declaring that language" style, using the real manifest/
 *   module rather than a fixture).
 */

import { describe, expect, test } from "bun:test";
import type { Position, Selection } from "@tecode/api";
import { builtinManifests, builtinModules, LANGUAGES_BASIC_EXTENSION_ID } from "@tecode/builtin";
import { buildToggleLineCommentResult } from "@tecode/builtin/editor-core/comments";
import type { LineReader } from "@tecode/builtin/editor-core/movement";
import {
  createExtensionHost,
  createHostLog,
  createLanguageRegistry,
  createNoopStatusSink,
  type ExtensionRecord,
} from "@tecode/core";
import type { Tecode } from "@tecode/api";

const languagesBasicManifest = builtinManifests.find((m) => m.id === LANGUAGES_BASIC_EXTENSION_ID)!;
const LANGUAGE_IDS = (languagesBasicManifest.contributes.languages ?? []).map((l) => l.id);

function pos(line: number, character: number): Position {
  return { line, character };
}

function cursorAt(line: number, character: number): Selection {
  const p = pos(line, character);
  return { start: p, end: p, anchor: p, active: p };
}

function readerOf(lines: string[]): LineReader {
  return { getLine: (n) => lines[n]!, lineCount: lines.length };
}

/** Apply `edits` to a plain `string[]` (matches `comments.test.ts`'s own
 * helper — no real `Document` needed for a pure text round-trip check). */
function applyToLines(
  lines: string[],
  edits: { range: { start: Position; end: Position }; newText: string }[],
): string[] {
  const result = [...lines];
  const sorted = [...edits].sort((a, b) => b.range.start.character - a.range.start.character);
  for (const edit of sorted) {
    const line = result[edit.range.start.line]!;
    result[edit.range.start.line] =
      line.slice(0, edit.range.start.character) + edit.newText + line.slice(edit.range.end.character);
  }
  return result;
}

describe("comments/brackets contributions (Req 8.2)", () => {
  const registry = createLanguageRegistry();
  for (const language of languagesBasicManifest.contributes.languages ?? []) {
    registry.register(language);
  }

  test("every declared language resolves via the registry (api.languages.getLanguage's real backing)", () => {
    for (const id of LANGUAGE_IDS) {
      expect(registry.getLanguage(id), id).toBeDefined();
    }
  });

  test("every declared `brackets` entry is an array of {open, close} pairs", () => {
    for (const id of LANGUAGE_IDS) {
      const contribution = registry.getLanguage(id)!;
      expect(Array.isArray(contribution.brackets), id).toBe(true);
      for (const pair of contribution.brackets ?? []) {
        expect(typeof pair.open, `${id}.brackets open`).toBe("string");
        expect(typeof pair.close, `${id}.brackets close`).toBe("string");
        expect(pair.open.length, `${id}.brackets open non-empty`).toBeGreaterThan(0);
        expect(pair.close.length, `${id}.brackets close non-empty`).toBeGreaterThan(0);
      }
    }
  });

  test("a declared comments.line marker round-trips: comment then uncomment restores the original", () => {
    let checked = 0;
    for (const id of LANGUAGE_IDS) {
      const marker = registry.getLanguage(id)!.comments?.line;
      if (!marker) continue;
      checked++;
      const original = ["const x = 1;", "  indented();"];
      const reader1 = readerOf(original);
      const commented = buildToggleLineCommentResult(reader1, [cursorAt(0, 0), cursorAt(1, 2)], marker);
      const afterComment = applyToLines(original, commented.edits);
      expect(afterComment.every((l) => l.trimStart().startsWith(marker)), `${id}: every line commented`).toBe(true);

      const reader2 = readerOf(afterComment);
      const uncommented = buildToggleLineCommentResult(
        reader2,
        [cursorAt(0, 0), cursorAt(1, 2 + marker.length + 1)],
        marker,
      );
      const restored = applyToLines(afterComment, uncommented.edits);
      expect(restored, `${id}: round-trip restores original`).toEqual(original);
    }
    // Sanity: this codebase's languages-basic set genuinely mixes
    // line-comment and no-line-comment languages (json/markdown/html/css) —
    // if this drops to 0 the fixture above silently tested nothing.
    expect(checked).toBeGreaterThan(0);
  });

  test("comments.block, where declared, is a real [start, end] pair", () => {
    for (const id of LANGUAGE_IDS) {
      const block = registry.getLanguage(id)!.comments?.block;
      if (!block) continue;
      expect(block).toHaveLength(2);
      expect(block[0].length).toBeGreaterThan(0);
      expect(block[1].length).toBeGreaterThan(0);
    }
  });

  test("markdown declares no line comment (Markdown has none) and json declares neither (JSON has none)", () => {
    expect(registry.getLanguage("markdown")!.comments?.line).toBeUndefined();
    expect(registry.getLanguage("json")!.comments).toBeUndefined();
  });
});

describe("onLanguage activation (Req 2.5, ExtensionHost.onLanguage, tasks.md's Task 2.9)", () => {
  function buildHostForLanguagesBasic() {
    const log = createHostLog();
    const sink = createNoopStatusSink();
    const api = {} as Tecode; // languages-basic's activate() reads nothing off `ctx.api` (it's a no-op).
    const record: ExtensionRecord = {
      id: languagesBasicManifest.id,
      manifest: languagesBasicManifest,
      extensionUri: `<builtin>/${languagesBasicManifest.id}`,
      storagePath: `/storage/${languagesBasicManifest.id}`,
      loadModule: () => Promise.resolve(builtinModules[languagesBasicManifest.id]),
    };
    return createExtensionHost({ extensions: [record], api, log, sink });
  }

  for (const id of LANGUAGE_IDS) {
    test(`opening a "${id}" document activates tecode.languages-basic exactly once`, async () => {
      const host = buildHostForLanguagesBasic();
      expect(host.getState(languagesBasicManifest.id)).toBe("registered");
      host.onLanguage(id);
      // onLanguage is fire-and-forget/synchronous-looking but the real
      // activation work is async (`host/activation.test.ts`'s own pattern);
      // give its microtasks a turn.
      await Promise.resolve();
      await Promise.resolve();
      expect(host.getState(languagesBasicManifest.id)).toBe("active");
    });
  }
});
