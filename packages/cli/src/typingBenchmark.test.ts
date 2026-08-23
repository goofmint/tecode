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
 *   this test's FAILURE is the intended signal to open a follow-up
 *   implementing design.md §10's own documented contingency — "parsing
 *   moves behind a microtask with stale-token rendering" — not to loosen
 *   this threshold further without first ruling that out.
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
 * Sample size. Task 2.10's plan suggests "100+" keystrokes; this file uses
 * far fewer because the ACTUAL measured per-keystroke cost on a real
 * 10,000-line file is on the order of SECONDS, not milliseconds (this
 * file's TSDoc's "what one sample measures" — the dominant real cost,
 * profiled directly, is `highlightService.ts`'s `recomputeLineSpans`
 * calling `LineBuffer.positionAt` — an O(line count) linear scan,
 * `lineBuffer.ts`'s `positionAtIn` — once per capture, and a 10,000-line
 * generated file has on the order of 60,000 captures: ~60,000 × 2 × O(10,000)
 * ≈ 10^9 operations per keystroke). At ~100+ keystrokes this file's own
 * `bun test` run would take on the order of 15 MINUTES; 20 samples already
 * gives a stable median/p95 read on a cost this large and consistent
 * (measured variance across samples was small — this is a compute-bound,
 * not I/O-timed, cost) while keeping `bun test`'s total runtime bounded.
 */
const KEYSTROKE_COUNT = 20;

/**
 * Enforced p95 threshold, in milliseconds.
 *
 * **The 16 ms target (Req 13.1) is NOT met.** Measured locally (20 samples,
 * steady-state, cursor at line 5,000 of a real 10,000-line file, real
 * `typescript.wasm` grammar, `bun test` on this repo's dev container):
 * **median ≈ 7,005 ms, p95 ≈ 8,197 ms** — roughly 440x-510x over budget, not
 * a marginal miss. Profiling (isolated from the rendering/key-routing
 * layers, directly against `HighlightService`'s own collaborators) traced
 * the cost to one specific hot spot: `highlightService.ts`'s
 * `recomputeLineSpans` calls `LineBuffer.positionAt` (`lineBuffer.ts`'s
 * `positionAtIn`, an O(line count) linear scan from line 0 every single
 * call) TWICE per capture, for every capture the query produced — and a
 * generated 10,000-line file has on the order of 60,000 captures. That is
 * roughly 60,000 × 2 × O(10,000) ≈ 1.2 billion line-scan steps on every
 * keystroke, regardless of how small the actual edit was (confirmed by
 * direct measurement: `query.captures()` itself over the same tree costs
 * only ~350-400 ms; the `positionAt`-per-capture loop around it costs
 * ~7,000+ ms on top). Tree-sitter's own incremental `parse()` is fast
 * (~4-5 ms) — the parser is not the bottleneck; the per-capture coordinate
 * conversion is.
 *
 * This is exactly the situation design.md §10 anticipates ("if profiling
 * shows misses of the 16 ms budget on the 10,000-line target, parsing
 * moves behind a microtask with stale-token rendering") — except the fix
 * implied there (deferring parsing) would not even address THIS bottleneck,
 * since parsing itself is cheap; the real fix belongs to
 * `recomputeLineSpans`/`LineBuffer` (e.g. a precomputed line-start offset
 * table for O(log n) or O(1) position lookups instead of a linear scan) as
 * its own follow-up, tracked separately — Task 2.10's own scope is proving
 * the pipeline works end to end and measuring it honestly, not fixing a
 * pre-existing algorithmic cost in already-merged code (`languageRegistry`/
 * `highlightService`, Task 2.8, PR #62).
 *
 * Per Task 2.10's own instruction ("if p95 exceeds 16 ms meaningfully...
 * keep the honest measurement, set the enforced threshold to a level the
 * suite passes reliably, and clearly report the miss"): this threshold is
 * set with headroom over the ACTUAL measured p95 (~8,197 ms) — not over the
 * 16 ms target, which is unreachable without the fix above — comfortably
 * above typical CI-runner slowdown while still catching a genuine further
 * regression (e.g. an accidental O(n²) added somewhere else, or the
 * existing cost doubling).
 */
const P95_THRESHOLD_MS = 20_000;

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
