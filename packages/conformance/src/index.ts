import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Typed loaders for the language-neutral parity fixtures produced by the Python
 * oracle (`~/repos/bourdon/tools/gen_conformance.py`). Python is the source of
 * truth; the @getbourdon/* TypeScript mirror asserts against these exact bytes.
 *
 * Resolution order:
 *   1. `BOURDON_CONFORMANCE_DIR` env var — the oracle checkout (parity tests +
 *      oracle dev use this; highest priority so a build always asserts against
 *      the live oracle).
 *   2. the fixtures BUNDLED in this package (`<pkg>/fixtures`, shipped in the
 *      tarball) — what an installed `@getbourdon/conformance` consumer gets.
 *   3. the sibling Python checkout `../../bourdon/conformance` — dev fallback.
 *
 * The bundled copy is a vendored snapshot refreshed from the oracle by
 * `pnpm --filter @getbourdon/conformance sync-fixtures` (and in the release
 * workflow before publish), so the published package is self-contained.
 */

// `import.meta.url` in ESM; esbuild empties it in the CJS bundle, where the
// native `__dirname` global is the real directory — fall back to it.
declare const __dirname: string | undefined;
function moduleDir(): string {
  if (typeof import.meta !== "undefined" && import.meta.url) {
    return dirname(fileURLToPath(import.meta.url));
  }
  return typeof __dirname !== "undefined" ? __dirname : process.cwd();
}

export interface RedactionSecretCase {
  /** Joined at load (`assembleSecret`) so no contiguous secret literal lands in git. */
  fragments: string[];
  expect_redacted: string;
  expect_contains_secret: boolean;
}

export interface RedactionBenignCase {
  text: string;
  expect_redacted: string;
  expect_contains_secret: boolean;
}

export interface RedactionBattery {
  redacted_sentinel: string;
  benign_limit: number;
  secrets: RedactionSecretCase[];
  benign: RedactionBenignCase[];
}

export interface ConformanceFixtureMeta {
  path: string;
  sha256: string;
  producer: string;
}

export interface ConformanceManifest {
  conformance_version: string;
  produced_against: { bourdon_version: string };
  fixtures: ConformanceFixtureMeta[];
}

export function conformanceDir(): string {
  const override = process.env.BOURDON_CONFORMANCE_DIR;
  if (override) return override;
  // Bundled snapshot: <pkg>/fixtures, one level up from src/ or dist/.
  const bundled = resolve(moduleDir(), "..", "fixtures");
  if (existsSync(resolve(bundled, "manifest.json"))) return bundled;
  // Dev fallback: the sibling Python oracle checkout.
  return resolve(process.cwd(), "..", "..", "bourdon", "conformance");
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(conformanceDir(), name), "utf8")) as T;
}

export function loadManifest(): ConformanceManifest {
  return loadJson<ConformanceManifest>("manifest.json");
}

export function loadRedactionBattery(): RedactionBattery {
  return loadJson<RedactionBattery>("redaction_battery.json");
}

/** Reconstruct a secret case's runtime string from its fragments. */
export function assembleSecret(secret: RedactionSecretCase): string {
  return secret.fragments.join("");
}
