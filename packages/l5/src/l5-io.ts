/**
 * L5 I/O — atomic write + lenient read, and the byte-faithful `toDict`.
 *
 * Ported from core/l5_io.py + participants/base.py::L5Manifest.to_dict().
 *
 * `toDict` is the L6 change-detection hash key, so it must be byte-faithful:
 *   (1) None/undefined field  -> OMITTED (never serialized as null)
 *   (2) empty list ([])       -> OMITTED
 *   (3) Visibility            -> its lowercase string value (already stored as such)
 *   (4) lists                 -> mapped element-wise
 *   (5) nested dataclasses    -> recurse with the same drop rules
 *   key order = dataclass field-definition order (insertion order of the model
 *   objects produced by the `make*` factories in model.ts).
 *
 * On-disk persistence is YAML block-style with key order preserved
 * (PyYAML safe_dump(sort_keys=False)). The conformance fixtures assert the
 * in-memory toDict() OBJECT, not YAML bytes.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import type { L5ManifestModel } from "./model.js";

/**
 * Recursive `_dict_from`: drop None/undefined + empty-list fields, pass scalars
 * (incl. lowercase Visibility strings) through, map lists element-wise. A direct
 * port of participants/base.py::L5Manifest.to_dict's inner `_dict_from`.
 */
function dictFrom(obj: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) return obj.map((i) => dictFrom(i));
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = dictFrom(v);
    }
    return out;
  }
  return obj;
}

/**
 * Convert an L5 manifest model to its JSON-Schema-compatible dict, applying the
 * drop-None + drop-empty-list + lowercase-Visibility rules in dataclass key
 * order. Build the input via the `make*` factories so the key order is canonical.
 */
export function toDict(manifest: L5ManifestModel): Record<string, unknown> {
  return dictFrom(manifest) as Record<string, unknown>;
}

/**
 * Atomically write a manifest dict to `path` (tmp + fsync + rename). Creates
 * parent dirs. Mirrors core/l5_io.py::write_l5_dict. On failure, best-effort
 * removes the tmp file and re-throws.
 */
export function writeL5Dict(manifest: Record<string, unknown>, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, "w");
    writeSync(fd, yamlStringify(manifest, { sortMapEntries: false }));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Atomically write an L5 manifest model to `path`. Serializes via `toDict`
 * (drop-None + drop-empty-list cleanup). Mirrors core/l5_io.py::write_l5.
 */
export function writeL5(manifest: L5ManifestModel, path: string): void {
  writeL5Dict(toDict(manifest), path);
}

/**
 * Read an L5 manifest dict from `path`. Lenient: returns `undefined` on missing
 * file / YAML error / non-dict (mirrors core/l5_io.py::read_l5_dict, which logs
 * at WARNING and returns None).
 */
export function readL5Dict(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let data: unknown;
  try {
    data = yamlParse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  return data as Record<string, unknown>;
}
