import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // Use a non-composite tsconfig for the build/dts program: tsup's dts rollup
  // (rollup-plugin-dts) trips TS6307 when the tsconfig sets `composite` + has
  // `references` (the solution-style layout `tsc -b` needs). The main
  // tsconfig.json keeps composite/references for `pnpm typecheck`.
  tsconfig: "tsconfig.build.json",
  dts: { compilerOptions: { composite: false } },
  target: "node20",
  // clean:false on purpose. The VERIFY flow runs `tsup` (this) BEFORE the
  // solution-style `tsc -b` typecheck, which emits per-file modules into this
  // same dist/. A `clean:true` wipe deletes those modules, and incremental
  // `tsc -b` then trusts its tsbuildinfo and refuses to re-emit them — leaving
  // dist/index.js a re-export hub pointing at files that no longer exist. Not
  // cleaning keeps the dist self-consistent regardless of build/typecheck order.
  clean: false,
  sourcemap: true,
});
