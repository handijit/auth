import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // main, preload and the shared code run in node with `electron` mocked; the renderer and
    // React entries run in a real DOM.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["__tests__/**/*.test.ts"],
          exclude: ["__tests__/**/*.dom.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["__tests__/**/*.dom.test.ts"],
        },
      },
    ],
    // The sibling packages are part of what is tested: they are loaded through Vitest, so the
    // `electron` they import is the test's stand-in and not the path of the binary.
    server: { deps: { inline: [/@handijit\//] } },
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
      // Type-only files have no behaviour; the logic-free barrels are measured by index.test.ts.
      exclude: [
        "lib/index.ts",
        "lib/main.ts",
        "lib/preload.ts",
        "lib/renderer.ts",
        "lib/react.ts",
        "lib/types/**",
      ],
      thresholds: { 100: true },
    },
  },
});
