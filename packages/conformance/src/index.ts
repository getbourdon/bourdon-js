import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Typed loaders for the language-neutral parity fixtures produced by the Python
 * oracle (`~/repos/bourdon/tools/gen_conformance.py`). Python is the source of
 * truth; the @bourdon/* TypeScript mirror asserts against these exact bytes.
 *
 * Resolution (Phase 0–1): `BOURDON_CONFORMANCE_DIR` env var, else the sibling
 * Python checkout `../bourdon/conformance` relative to the cwd. Once published,
 * the fixtures ship inside this package and resolution points at the bundled copy.
 */

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
  return (
    process.env.BOURDON_CONFORMANCE_DIR ?? resolve(process.cwd(), "..", "bourdon", "conformance")
  );
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
