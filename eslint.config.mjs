// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/*.d.ts",
      // Temp fixtures written by layering.test.ts. Ignored here so a
      // concurrent `eslint .` never lints them; the test itself passes
      // --no-ignore to lint them deliberately.
      "**/__lint-fixture__*/**",
      "**/__lint-fixture__*",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
  },
  {
    // Layering rule (Req 1.3, design.md §2): `builtin` extensions must
    // import only from `@tecode/api`, never reach across the
    // extension/core boundary by importing `@tecode/core` directly. `cli`
    // is exempt — it is core's sole privileged wiring point.
    files: ["packages/**/*.{ts,tsx}"],
    ignores: ["packages/cli/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tecode/core", "@tecode/core/*"],
              message:
                "Calls across the extension/core boundary must go through the command registry (tecode.commands), not a direct import of @tecode/core. Only packages/cli may import @tecode/core.",
            },
          ],
        },
      ],
    },
  },
);
