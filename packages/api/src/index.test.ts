import { expect, test } from "bun:test";
import { API_VERSION } from "./index";

test("API_VERSION is the current major.minor version", () => {
  // 1.2 -> 1.3 (Issue #150, CodeRabbit PR #155): code folding added
  // FoldRange, FoldNamespace, EditorNamespace.folds and
  // LanguageContribution.folds — purely additive, so the bump exists to
  // stop an extension that CALLS `tecode.editor.folds.*` from registering
  // against a 1.2 host that has no such namespace (index.ts's API_VERSION
  // TSDoc explains why this is a minor, not major, bump).
  expect(API_VERSION).toBe("1.3");
});

test("API_VERSION uses <major>.<minor> form", () => {
  expect(API_VERSION).toMatch(/^\d+\.\d+$/);
});
