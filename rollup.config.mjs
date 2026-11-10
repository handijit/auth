import { builtinModules } from "node:module";

import typescript from "@rollup/plugin-typescript";
import { dts } from "rollup-plugin-dts";

// One entry per process context (and one for React, so the renderer entry loads without it).
// Each is bundled on its own, so no entry shares a chunk with another: the renderer file can
// never pull in code that was written for main, and the preload entry stays a file without a
// single import, ready to be inlined into a sandboxed preload.
const ENTRIES = ["index", "main", "preload", "renderer", "react"];

// Peer dependencies and Node built-ins stay imports; nothing else is left to bundle.
const EXTERNAL = [
  "electron",
  "zod",
  "react",
  "@handijit/core",
  "@handijit/core/errors",
  "@handijit/core/pkce",
  "@handijit/electron",
  "@handijit/electron/main",
  "@handijit/electron/renderer",
  ...builtinModules.map((name) => `node:${name}`),
];

// TypeScript alone downlevels to the tsconfig target; no Babel anywhere.
const ts = () => typescript({ tsconfig: "./tsconfig.json" });

export default ENTRIES.flatMap((entry) => [
  {
    input: `./lib/${entry}.ts`,
    external: EXTERNAL,
    output: [
      { file: `./build/${entry}.mjs`, format: "es", sourcemap: true },
      {
        file: `./build/${entry}.cjs`,
        format: "cjs",
        exports: "named",
        sourcemap: true,
      },
    ],
    plugins: [ts()],
  },
  {
    // One bundled declaration, written twice: TypeScript reads the format of a declaration file
    // from its extension, so the ESM entry needs a .d.mts next to the CommonJS .d.ts.
    input: `./lib/${entry}.ts`,
    external: EXTERNAL,
    output: [
      { file: `./build/${entry}.d.ts`, format: "es" },
      { file: `./build/${entry}.d.mts`, format: "es" },
    ],
    plugins: [dts({ tsconfig: "./tsconfig.json" })],
  },
]);
