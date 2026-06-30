import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // Use a non-composite tsconfig for the build/dts program: tsup's dts rollup
  // (rollup-plugin-dts) trips TS6307 when the tsconfig sets `composite` + has
  // `references`. The main tsconfig.json keeps composite/references for
  // `pnpm typecheck`.
  tsconfig: "tsconfig.build.json",
  dts: { compilerOptions: { composite: false } },
  target: "node20",
  clean: true,
  sourcemap: true,
});
