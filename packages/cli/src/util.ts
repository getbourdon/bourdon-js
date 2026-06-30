/**
 * Shared CLI helpers — the thin glue between commander and the @getbourdon/*
 * engine packages. Mirrors the small private helpers in `cli/main.py`
 * (`_parse_since`, `_print_yaml`, `_write_yaml_if_requested`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { stringify as yamlStringify } from "yaml";

export type Dict = Record<string, unknown>;

/** The message every not-yet-ported command prints before exiting non-zero. */
export const NOT_PORTED_MESSAGE =
  "not yet available in the TS CLI (Python: pip install bourdon)";

/** Exit code used by the not-yet-ported stubs (mirrors argparse usage exit 2). */
export const NOT_PORTED_EXIT = 2;

/**
 * Register a not-yet-ported leaf: it keeps the full parser surface (so the
 * `--help` checklist still lists it) but refuses to run, printing a clear
 * pointer to the Python implementation. Never silently omitted.
 */
export function notYetPorted(command: string): number {
  process.stderr.write(`bourdon ${command}: ${NOT_PORTED_MESSAGE}\n`);
  return NOT_PORTED_EXIT;
}

/** Faithful port of `_parse_since`: ISO date or datetime → Date (or null). */
export function parseSince(value: string | undefined | null): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

/** `_print_yaml`: dump a mapping to stdout with insertion order preserved. */
export function printYaml(data: Dict): void {
  process.stdout.write(yamlStringify(data, { sortMapEntries: false }));
}

/** `_write_yaml_if_requested`: write YAML to `path` (creating parents). */
export function writeYamlIfRequested(data: Dict, path: string | undefined | null): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(data, { sortMapEntries: false }), "utf8");
}
