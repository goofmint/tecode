import { expect, test } from "bun:test";
import pkg from "../package.json";

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
