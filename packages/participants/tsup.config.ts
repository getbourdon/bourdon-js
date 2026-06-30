import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // Non-composite tsconfig for the dts rollup: rollup-plugin-dts trips TS6307
  // when composite + references are set (the solution-style `tsc -b` layout).
  // tsconfig.json keeps composite/references for `pnpm typecheck`.
  tsconfig: "tsconfig.build.json",
  dts: { compilerOptions: { composite: false } },
  target: "node20",
  clean: true,
  sourcemap: true,
  // better-sqlite3 is a native addon — never bundle it; resolve at runtime.
  external: ["better-sqlite3"],
});
