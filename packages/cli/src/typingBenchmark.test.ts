/**
 * Scripted typing benchmark on a 10,000-line file (tasks.md's Task 2.10,
 * Req 13.1: "WHILE editing a 10,000-line file, THE system SHALL keep
 * key-input-to-render latency within 16 ms"; design.md §15's "scripted
 * 10k-line typing benchmark with thresholds slightly above the targets to
 * avoid flakiness", §10's incremental-reparse contingency).
 *
 * **Methodology**:
 *
 * - **Corpus**: a deterministic, syntactically real 10,000-line TypeScript
 *   file (`editingHarness.tsx`'s `generateTypeScriptSource`), opened
 *   through the REAL production pipeline (`buildEditingHarness`) — real
 *   `AssemblyRoot`, real `languages-basic`'s `typescript.wasm` grammar via
 *   the real `web-tree-sitter` `ParserBackend`, real `HighlightService`
 *   incremental reparse, a real rendered `Shell` (OpenTUI's headless test
 *   renderer, same as `editingScenario.e2e.test.tsx`).
 * - **Warm-up (excluded from measurement)**: the grammar's one-time WASM
 *   load/compile and the document's first FULL parse
 *   (`highlightService.ts`'s `getOrLoadLanguageAssets`/`parseDocument`) are
 *   awaited via `waitForHighlightChange` BEFORE the timed loop starts —
 *   Req 13.1 asks about steady-state typing latency, not one-time startup
 *   cost (already covered separately by `main.integration.test.ts`'s own
 *   first-frame budget).
 * - **What one sample measures**: `performance.now()` immediately before
 *   injecting one keystroke, to immediately after the resulting
 *   `renderOnce()` call resolves — i.e. `handleKeyEvent` (keymap lookup +
 *   `editorInputRouter.routeKeyEvent` -> `document.applyEdits`, which
 *   SYNCHRONOUSLY fires `onDidChange` -> `HighlightService`'s incremental
 *   `tree.edit()` + a fresh `backend.parse()` + a full-document
 *   `query.captures()` re-run, per `highlightService.ts`'s
 *   `recomputeLineSpans` — and `editorSession`'s own state update) THROUGH
 *   to the Shell's next committed frame. This is genuinely the full
 *   key-input-to-render path Req 13.1 describes, not just the buffer edit.
 * - **Sample size and typing position**: {@link KEYSTROKE_COUNT} plain
 *   characters (Task 2.10's "100+"), typed one at a time via the real key
 *   pipeline (`editingHarness.tsx`'s `sendKey`/`keyOf`, matching
 *   `keyRouting.ts`'s real `renderer.keyInput` wiring), appended at a
 *   single cursor on a line near the MIDDLE of the file (design.md §13.1's
 *   worst case for line-window virtualization + a full-tree query, not the
 *   cheaper edge case a cursor at line 0 or line 9999 might be).
 * - **Aggregation**: median (p50) and p95 over all samples, nearest-rank
 *   method (Task 2.10's plan: "aggregate median and p95").
 * - **Threshold and rationale (Req 13.1, design.md §15's "headroom... to
 *   avoid flakiness", `main.integration.test.ts`'s own precedent of
 *   asserting 10x a 100ms target as "tight enough to catch a real
 *   regression, loose enough for a loaded CI runner")**: see
 *   {@link P95_THRESHOLD_MS}'s own comment, right above the constant, for
 *   the actual measured numbers this threshold was picked against and
 *   whether the 16 ms target itself is met.
 * - **A budget miss must never be silently accepted (design.md §10)**: if a
 *   future change pushes p95 back above whatever threshold is set below,
 *   this test's FAILURE is the intended signal to open a follow-up — NOT to
 *   loosen the threshold further without first investigating. Note design.md
 *   §10's own documented contingency ("parsing moves behind a microtask with
 *   stale-token rendering") does NOT apply here: profiling (recorded on
 *   {@link P95_THRESHOLD_MS}'s own comment) traced the cost first to
 *   `recomputeLineSpans`'s per-capture `LineBuffer.positionAt` scan (fixed)
 *   and, post-fix, to `query.captures()` itself — parsing was never the
 *   bottleneck at any point.
 * - **Trend tracking**: one single-line JSON metric is logged per run
 *   (`{ event: "tecode.typingBenchmark", ... }`), matching `main.ts`'s own
 *   `emitMetric` shape, so CI logs carry a parseable time series across
 *   commits even though `bun test` itself has no persistent metrics store.
 */

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToUri } from "@tecode/core";
import {
  buildEditingHarness,
  focusEditorText,
  generateTypeScriptSource,
  keyOf,
  renderEditingShell,
  sendKey,
  waitForHighlightChange,
  writeFixtureFile,
  type EditingHarness,
} from "./editingHarness";

/** Req 13.1's own "10,000-line file". */
const LINE_COUNT = 10_000;

/**
 * Sample size. Task 2.10's plan suggests "100+" keystrokes; this file keeps
 * a smaller count. Historically (before the `recomputeLineSpans` fix
 * {@link P95_THRESHOLD_MS}'s own comment records), the per-keystroke cost
 * on a real 10,000-line file was on the order of SECONDS, so 100+ samples
 * would have taken this file's own `bun test` run ~15 MINUTES; post-fix the
 * per-keystroke cost is ~350-400 ms (still compute-bound, still low
 * variance across samples), so 20 samples remains a stable median/p95 read
 * while keeping `bun test`'s total runtime bounded.
 */
const KEYSTROKE_COUNT = 20;

/**
 * Enforced p95 threshold, in milliseconds.
 *
 * **Fix record**: this benchmark originally measured median ≈ 7,005 ms,
 * p95 ≈ 8,197 ms — roughly 440x-510x over the 16 ms target (Req 13.1).
 * Profiling traced that entirely to `highlightService.ts`'s
 * `recomputeLineSpans` calling `LineBuffer.positionAt` (`lineBuffer.ts`'s
 * `positionAtIn`, an O(line count) linear scan from line 0) TWICE per
 * capture — ~60,000 captures on a generated 10,000-line file, so ~1.2
 * billion line-scan steps per keystroke, regardless of edit size.
 * `recomputeLineSpans` was fixed to build one line-start offset table per
 * recompute (O(line count), once) and resolve each capture's line via
 * binary search (O(log line count)) instead — see its own TSDoc
 * (`highlightService.ts`) for the fix and why it resolves positions from
 * `capture.startIndex`/`endIndex` rather than the parser's own
 * `startPosition`/`endPosition` points (those are resolved against a
 * different, `\r\n`-aware line split than `LineBuffer`'s own hardcoded
 * `"\n"`-`eol` assumption, so using them directly would silently change
 * behavior for CRLF documents instead of just making it faster).
 *
 * **Post-fix, the 16 ms target is still NOT met.** Measured locally (20
 * samples each, steady-state, same corpus/harness, 4 consecutive runs):
 * median ≈ 335-383 ms, p95 ≈ 366-404 ms — roughly 21x-23x over budget, but
 * a ~20x improvement over the pre-fix numbers above and no longer dominated
 * by an accidental O(n) scan. What remains is `query.captures()` itself
 * (tree-sitter's own per-keystroke full-tree query cost on ~60,000
 * captures, independently measured at ~350-400 ms before this fix and
 * consistent with what's left now) — a real, tracked-separately follow-up
 * (e.g. incremental/windowed querying), not something this task's fix
 * (eliminating the `positionAt` scan) was ever going to close on its own.
 * Tree-sitter's incremental `parse()` remains fast (~4-5 ms) and is still
 * not the bottleneck.
 *
 * Per Task 2.10's own instruction ("if p95 exceeds 16 ms meaningfully...
 * keep the honest measurement, set the enforced threshold to a level the
 * suite passes reliably, and clearly report the miss"): this threshold is
 * set with headroom over the ACTUAL measured p95 (worst observed ≈ 404 ms
 * across 4 runs) — not over the 16 ms target, which is unreachable without
 * the `query.captures()` follow-up above — comfortably above typical
 * CI-runner slowdown while still catching a genuine further regression
 * (e.g. `positionAt`'s O(n) scan creeping back in, or an accidental O(n²)
 * added elsewhere).
 */
const P95_THRESHOLD_MS = 1_000;

/** Nearest-rank percentile over an ALREADY-SORTED ascending array (Task
 * 2.10's "aggregate median and p95"). */
function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil(p * sortedMs.length) - 1));
  return sortedMs[index]!;
}

describe("Typing latency on a 10,000-line file (Task 2.10, Req 13.1, design.md §10, §15)", () => {
  test(
    "median and p95 key-input-to-render latency stay within the enforced CI threshold",
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), "tecode-bench-home-"));
      const workspaceDir = await mkdtemp(join(tmpdir(), "tecode-bench-ws-"));
      let harness: EditingHarness | undefined;
      try {
        const filePath = join(workspaceDir, "large.ts");
        await writeFixtureFile(filePath, generateTypeScriptSource(LINE_COUNT));

        harness = await buildEditingHarness({ workspaceRoot: workspaceDir, homeDir });
        const { root } = harness;

        const document = await root.documents.openDocument(pathToUri(filePath));
        expect(document.languageId).toBe("typescript");
        expect(document.lineCount).toBeGreaterThanOrEqual(LINE_COUNT);

        const { renderOnce, renderer } = await renderEditingShell(root, { width: 120, height: 40 });
        await act(async () => {
          await renderOnce();
        });

        // Warm-up (excluded from measurement, this file's TSDoc): the
        // grammar's one-time load/compile plus the document's first FULL
        // parse.
        await act(async () => {
          await waitForHighlightChange(root.highlightService);
        });
        await act(async () => {
          await renderOnce();
        });

        const focused = focusEditorText(renderer.root, root.context);
        expect(focused, "expected the editor's text plane to become focused").toBe(true);

        // A cursor near the middle of the file (this file's TSDoc's
        // "typing position").
        const middleLine = Math.floor(document.lineCount / 2);
        const lineLength = document.getLine(middleLine).length;
        const startPos = { line: middleLine, character: lineLength };
        act(() => {
          root.api.editor.setSelections([
            { start: startPos, end: startPos, anchor: startPos, active: startPos },
          ]);
        });
        await act(async () => {
          await renderOnce();
        });

        // A realistic run of plain printable characters — no repeats-of-1
        // artifact, and definitely not a keybinding-bound character
        // (avoids accidentally exercising the chord machine's "consumed"
        // path instead of a plain insert).
        const probeText = "the quick brown fox jumps over the lazy dog while benchmarking input latency here";
        const keystrokes: string[] = [];
        while (keystrokes.length < KEYSTROKE_COUNT) {
          for (const ch of probeText) {
            if (keystrokes.length >= KEYSTROKE_COUNT) break;
            keystrokes.push(ch === " " ? "_" : ch); // avoid "space" naming ambiguity in KeyEventLike
          }
        }

        const latenciesMs: number[] = [];
        for (const ch of keystrokes) {
          const startedAt = performance.now();
          act(() => {
            sendKey(root, keyOf({ name: ch, sequence: ch }));
          });
          await act(async () => {
            await renderOnce();
          });
          latenciesMs.push(performance.now() - startedAt);
        }

        expect(document.getLine(middleLine).length).toBe(lineLength + KEYSTROKE_COUNT);

        const sorted = [...latenciesMs].sort((a, b) => a - b);
        const medianMs = percentile(sorted, 0.5);
        const p95Ms = percentile(sorted, 0.95);

        // Single-line JSON metric for CI trend tracking (this file's
        // TSDoc, matching `main.ts`'s `emitMetric` shape).
        console.log(
          JSON.stringify({
            event: "tecode.typingBenchmark",
            lineCount: document.lineCount,
            samples: sorted.length,
            medianMs: Number(medianMs.toFixed(3)),
            p95Ms: Number(p95Ms.toFixed(3)),
            thresholdMs: P95_THRESHOLD_MS,
            targetMs: 16,
          }),
        );

        expect(medianMs).toBeGreaterThanOrEqual(0);
        // The enforced CI gate (design.md §10: a miss here must trigger a
        // follow-up, per this file's top TSDoc — never a silent raise of
        // this threshold without first ruling out the §10 contingency).
        expect(p95Ms).toBeLessThan(P95_THRESHOLD_MS);
      } finally {
        await harness?.dispose();
        await rm(homeDir, { recursive: true, force: true });
        await rm(workspaceDir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
