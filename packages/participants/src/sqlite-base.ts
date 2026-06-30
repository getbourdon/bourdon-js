/**
 * Shared read-only SQLite + normalization helpers — port of
 * `participants/_sqlite_base.py`.
 *
 * A SQLite-backed participant (hermes today; cursor/copilot_cli in the follow-on
 * slice) reads a foreign agent's native DB read-only so a live writer's lock can
 * never block the export, probes the schema defensively (native schemas drift
 * across versions), and turns epoch timestamps + paths into the L5 shapes.
 *
 * `better-sqlite3` is a NATIVE addon. It is loaded lazily through `createRequire`
 * inside a try/catch so this package — and the file/network readers — keep
 * working even on a toolchain where the addon failed to build: in that case
 * {@link sqliteAvailable} returns false and the sqlite readers degrade rather
 * than crashing import. Nothing here applies visibility or builds manifests;
 * that stays in the participant (per PARTICIPANT_CONTRACT.md).
 */

import { statSync } from "node:fs";
import { createRequire } from "node:module";

import type DatabaseT from "better-sqlite3";

/** A better-sqlite3 connection (re-exported type alias for reader signatures). */
export type SqliteDatabase = DatabaseT.Database;

// `import.meta.url` in ESM; esbuild empties it in the CJS bundle, where the
// native `__filename` global is the real path — fall back to it so createRequire
// resolves better-sqlite3 from either module format.
declare const __filename: string | undefined;
const moduleUrl =
  (typeof import.meta !== "undefined" && import.meta.url) ||
  (typeof __filename !== "undefined" ? __filename : process.cwd());
const nodeRequire = createRequire(moduleUrl);

let driver: typeof DatabaseT | null | undefined;

/** Lazily resolve the better-sqlite3 constructor, or null if the addon is
 * unavailable (failed native build). Cached after the first attempt. */
function loadDriver(): typeof DatabaseT | null {
  if (driver !== undefined) return driver;
  try {
    driver = nodeRequire("better-sqlite3") as typeof DatabaseT;
  } catch {
    driver = null;
  }
  return driver;
}

/** True when the better-sqlite3 native addon loaded successfully. Tests gate
 * the SQLite-reader assertions on this so a missing addon skips, not fails. */
export function sqliteAvailable(): boolean {
  return loadDriver() !== null;
}

export interface OpenReadonlyOptions {
  /** `immutable=1`: skip locks + ignore the WAL. Only for genuinely static
   * snapshots; against a live writer it risks stale reads / SQLITE_CORRUPT. */
  immutable?: boolean;
  /** SQLite busy-timeout in milliseconds (Python's `timeout=2.0` seconds). */
  timeoutMs?: number;
}

// -- Read-only connection -----------------------------------------------------

/**
 * Open a SQLite DB read-only so a live writer is never disturbed. The default
 * (`immutable` omitted) is the safe `mode=ro`: it respects SQLite locking and
 * reads the `-wal` sidecar of a live, actively-writing agent. Raises on a
 * genuine open failure; callers wanting the never-raises contract use
 * {@link tryOpenReadonly}.
 */
export function openReadonly(dbPath: string, opts: OpenReadonlyOptions = {}): SqliteDatabase {
  const Ctor = loadDriver();
  if (!Ctor) {
    throw new Error("better-sqlite3 native addon is not available");
  }
  // better-sqlite3 maps `{readonly:true}` to SQLITE_OPEN_READONLY. There is no
  // first-class `immutable=1` knob; for our static snapshots `readonly` is
  // sufficient (we never open a concurrently-written fixture DB).
  return new Ctor(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: opts.timeoutMs ?? 2000,
  });
}

/**
 * Like {@link openReadonly} but returns null instead of raising — for the
 * export/health path where a missing or corrupt DB must degrade to "no rows".
 */
export function tryOpenReadonly(
  dbPath: string,
  opts: OpenReadonlyOptions = {},
): SqliteDatabase | null {
  try {
    if (!statSync(dbPath).isFile()) return null;
  } catch {
    return null;
  }
  try {
    return openReadonly(dbPath, opts);
  } catch {
    return null;
  }
}

// -- Defensive schema probes --------------------------------------------------

/** True if `name` is a table in the connected DB (swallows errors → false). */
export function tableExists(db: SqliteDatabase, name: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
      .get(name);
    return row !== undefined;
  } catch {
    return false;
  }
}

/** Column names for `table` (empty set if absent / on error). PRAGMA cannot be
 * parameterized, matching the Python f-string. */
export function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set<string>();
  }
}

// -- Normalization ------------------------------------------------------------

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert epoch seconds (number/string) to an ISO `YYYY-MM-DD` UTC date, or
 * null for missing/unparseable values. Mirrors `epoch_to_iso_date`.
 */
export function epochToIsoDate(value: unknown): string | null {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Convert epoch seconds to a full ISO 8601 UTC datetime, or null. The offset is
 * rendered `+00:00` (Python `datetime(...).isoformat()` style) rather than `Z`.
 */
export function epochToIsoDatetime(value: unknown): string | null {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00").replace(/Z$/, "+00:00");
}

function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * Derive a lowercase project key from a working-directory path: the basename
 * lowercased, or null when the cwd is empty or its basename is "generic"
 * (carries no project identity). Mirrors `project_key_from_cwd`.
 */
export function projectKeyFromCwd(
  cwd: string | null | undefined,
  genericNames: ReadonlySet<string> = new Set(),
): string | null {
  if (!cwd) return null;
  const name = basenameOf(cwd).trim().toLowerCase();
  if (!name || genericNames.has(name)) return null;
  return name;
}

/** Turn a slug-ish key (`my-cool_project`) into a Title Case label. */
export function friendlyLabel(key: string): string {
  return key
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
