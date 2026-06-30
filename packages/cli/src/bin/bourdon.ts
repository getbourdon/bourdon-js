#!/usr/bin/env node
/**
 * `bourdon` — executable entry point. Self-locating (resolves `@getbourdon/*`
 * from its own install tree so it works under an MCP host's minimal PATH), and
 * maps `main(argv)`'s return value to the process exit code. Both `npx bourdon`
 * and a global install resolve here.
 */

import { main } from "../main.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${String(err instanceof Error ? (err.stack ?? err.message) : err)}\n`);
    process.exit(1);
  },
);
