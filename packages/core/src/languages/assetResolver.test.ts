/**
 * Tests for {@link createAssetResolver} (Req 8.2, 8.5).
 */

import { describe, expect, test } from "bun:test";
import { createAssetResolver, type AssetResolverFs } from "./assetResolver";

function fakeFs(): AssetResolverFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readBinary: async (path) => {
      reads.push(`binary:${path}`);
      return new Uint8Array([1, 2, 3]);
    },
    readText: async (path) => {
      reads.push(`text:${path}`);
      return `(query text for ${path})`;
    },
  };
}

describe("createAssetResolver — path resolution (Req 8.2)", () => {
  test("resolveGrammar joins baseDir with the contribution's grammar path", async () => {
    const fs = fakeFs();
    const resolver = createAssetResolver({ fs });
    const bytes = await resolver.resolveGrammar("ts.wasm", "/ext/languages-basic");
    expect(fs.reads).toEqual(["binary:/ext/languages-basic/ts.wasm"]);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("resolveHighlights joins baseDir with the contribution's highlights path", async () => {
    const fs = fakeFs();
    const resolver = createAssetResolver({ fs });
    const text = await resolver.resolveHighlights("ts.scm", "/ext/languages-basic");
    expect(fs.reads).toEqual(["text:/ext/languages-basic/ts.scm"]);
    expect(text).toBe("(query text for /ext/languages-basic/ts.scm)");
  });

  test("an omitted baseDir uses the path as-is (runtime tecode.languages.register)", async () => {
    const fs = fakeFs();
    const resolver = createAssetResolver({ fs });
    await resolver.resolveGrammar("/absolute/ts.wasm");
    expect(fs.reads).toEqual(["binary:/absolute/ts.wasm"]);
  });
});
