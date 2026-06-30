import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin/bourdon.ts"],
  format: ["esm", "cjs"],
  // Non-composite tsconfig for the dts rollup: rollup-plugin-dts trips TS6307
  // when composite + references are set (the solution-style `tsc -b` layout).
  // tsconfig.json keeps composite/references for `pnpm typecheck`.
  tsconfig: "tsconfig.build.json",
  dts: { entry: { index: "src/index.ts" } },
  target: "node20",
  clean: true,
  sourcemap: true,
  // The shebang lives literally at the top of src/bin/bourdon.ts; esbuild
  // preserves a leading shebang so `dist/bin/bourdon.js` is executable.
});
