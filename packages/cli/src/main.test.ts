import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToUri } from "@tecode/core";
import pkg from "../package.json";
import { buildAssemblyRoot } from "./main";

test("--version prints the package version and exits 0", async () => {
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/main.ts`, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  expect(stdout.trim()).toBe(pkg.version);
  expect(exitCode).toBe(0);
});

test("buildAssemblyRoot wires every core service and registers the 'tecode' module alias", async () => {
  // Importing main.ts (above) does not itself run `main()` — see main.ts's
  // `import.meta.main` guard — so calling buildAssemblyRoot() directly
  // here is safe and does not depend on this test file's own argv.
  const dir = await mkdtemp(join(tmpdir(), "tecode-cli-root-"));
  // Redirect the user-level config directory into this test's temp dir
  // (matches config/service.test.ts's real-filesystem test) so this never
  // reads or watches the real user's ~/.config/tecode files.
  const savedHome = process.env["HOME"];
  const savedAppData = process.env["APPDATA"];
  process.env["HOME"] = dir;
  process.env["APPDATA"] = dir;
  let root: ReturnType<typeof buildAssemblyRoot>;
  try {
    root = buildAssemblyRoot(dir);
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = savedAppData;
  }

  try {
    await root.config.ready;

    // Every namespace reachable via the assembled api.
    expect(Object.keys(root.api)).toEqual([
      "commands",
      "workspace",
      "window",
      "editor",
      "ui",
      "config",
      "context",
      "languages",
      "themes",
    ]);

    expect(root.api.workspace.rootUri).toBe(pathToUri(dir));
    expect(Object.isFrozen(root.api)).toBe(true);

    // buildAssemblyRoot's own TSDoc documents that registerTecodeAlias runs
    // as its last step; `create.contract.test.ts` is where the resulting
    // `"tecode"` module-alias resolution is exercised end-to-end (the one
    // sanctioned dynamic `import("tecode")` test call site) — this test
    // stays focused on cli's composition wiring itself.
  } finally {
    root.config.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
