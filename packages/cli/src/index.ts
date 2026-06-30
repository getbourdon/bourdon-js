/**
 * `bourdon` — the unscoped, Apache-2.0 CLI over the @getbourdon/* engine. This
 * module exports the commander program builder + the `main` dispatcher so tests
 * (and embedders) can drive the CLI in-process. The executable entry point is
 * `dist/bin/bourdon.js` (see `src/bin/bourdon.ts`).
 */

export { buildProgram, main } from "./main.js";
export { NOT_PORTED_MESSAGE, NOT_PORTED_EXIT } from "./util.js";
