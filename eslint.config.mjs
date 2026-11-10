import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

// The layer rule of the package: which entry may import what.
const NODE_AND_ELECTRON = [
  { group: ["node:*"], message: "This layer must run without Node." },
  // A regular expression, not a group: a group would also match `@handijit/electron`.
  {
    regex: "^electron(/.*)?$",
    message: "This layer must run without Electron.",
  },
];
const OTHER_LAYERS = (layers) => ({
  group: layers.map((layer) => `**/${layer}/**`),
  message: "A process layer imports only itself, shared/ and types/.",
});
const MAIN_ONLY_PACKAGES = {
  group: ["@handijit/core", "@handijit/core/*", "@handijit/electron/main"],
  message: "The API client and the main-process helpers stay in main.",
};

export default defineConfig([
  globalIgnores(["build/**", "coverage/**", "e2e/out/**"]),
  {
    files: ["**/*.ts", "**/*.mts", "**/*.tsx"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
    },
  },
  {
    // The public contract must not be a side effect of type inference.
    files: ["lib/**/*.ts"],
    rules: { "@typescript-eslint/explicit-module-boundary-types": "error" },
  },
  {
    // Pure: loaded by main, preload and renderer alike. Zod is the only run-time import, and
    // only in the contract file; everything else here is free of it (see the next block).
    files: ["lib/index.ts", "lib/shared/**/*.ts", "lib/types/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...NODE_AND_ELECTRON,
            MAIN_ONLY_PACKAGES,
            OTHER_LAYERS(["main", "preload", "renderer", "react"]),
            {
              group: ["zod"],
              allowTypeImports: true,
              message:
                "Only shared/auth-contract.ts carries Zod at run time: preload and renderer bundle the rest of shared/.",
            },
          ],
        },
      ],
    },
  },
  {
    // The contract fragment: schemas for both sides of the IPC boundary.
    files: ["lib/index.ts", "lib/shared/auth-contract.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...NODE_AND_ELECTRON,
            MAIN_ONLY_PACKAGES,
            OTHER_LAYERS(["main", "preload", "renderer", "react"]),
          ],
        },
      ],
    },
  },
  {
    // The preload entry is a channel list: no import at all survives bundling.
    files: ["lib/preload.ts", "lib/preload/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...NODE_AND_ELECTRON,
            MAIN_ONLY_PACKAGES,
            { group: ["zod"], message: "Schemas stay in main." },
            { group: ["react"], message: "A preload renders nothing." },
            OTHER_LAYERS(["main", "renderer", "react"]),
          ],
        },
      ],
    },
  },
  {
    // A web page: no Node, no Electron, no schemas, no framework.
    files: ["lib/renderer.ts", "lib/renderer/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...NODE_AND_ELECTRON,
            MAIN_ONLY_PACKAGES,
            { group: ["zod"], message: "Schemas stay in main." },
            { group: ["react"], message: "React lives in the react entry." },
            OTHER_LAYERS(["main", "preload", "react"]),
          ],
        },
      ],
    },
  },
  {
    // The React entry: the renderer layer plus React.
    files: ["lib/react.ts", "lib/react/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...NODE_AND_ELECTRON,
            MAIN_ONLY_PACKAGES,
            { group: ["zod"], message: "Schemas stay in main." },
            OTHER_LAYERS(["main", "preload"]),
          ],
        },
      ],
    },
  },
  {
    files: ["lib/main.ts", "lib/main/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["react"], message: "Main renders nothing." },
            OTHER_LAYERS(["preload", "renderer", "react"]),
          ],
        },
      ],
    },
  },
  {
    // Build and release tooling and the Electron fixture: plain scripts that report on the console.
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortSignal: "readonly",
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        window: "readonly",
        document: "readonly",
        location: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
      },
    },
  },
  prettier,
]);
