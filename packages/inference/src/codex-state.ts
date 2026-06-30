/**
 * Codex native-state helpers the turn compiler needs from `participants/codex.py`
 * (the full Codex participant is a follow-on slice). Ports `_resolve_codex_home`,
 * `_inspect_codex_state_db`, `_empty_codex_state_report`, and the
 * `_safe_native_memory_text` redaction wrapper.
 *
 * The state DB is read READ-ONLY via `@getbourdon/participants` sqlite-base
 * (better-sqlite3, `mode=ro`). If the native addon is unavailable the inspector
 * degrades to the empty report rather than crashing.
 */

import { homedir } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";

import {
  type SqliteDatabase,
  openReadonly,
  sqliteAvailable,
  tableColumns,
  tableExists,
} from "@getbourdon/participants";
import { redactText } from "@getbourdon/redaction";

type Dict = Record<string, unknown>;

/** Thin wrapper over the redaction SSOT (kept for its many importers). */
export function safeNativeMemoryText(value: string, limit = 180): string {
  return redactText(value, limit);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Locate `~/.codex/` (the primary Codex store), honoring `CODEX_HOME`. */
export function resolveCodexHome(baseHome: string | null = null): string | null {
  const envHome = process.env.CODEX_HOME;
  if (envHome) {
    if (isDir(envHome)) return envHome;
  }
  const home = baseHome ?? homedir();
  const candidate = join(home, ".codex");
  return isDir(candidate) ? candidate : null;
}

function emptyCodexStateReport(codexHome: string | null): Dict {
  const dbPath = codexHome ? join(codexHome, "state_5.sqlite") : null;
  return {
    path: dbPath,
    present: Boolean(dbPath && isFile(dbPath)),
    readable: false,
    error: null,
    threads: { total: 0, memory_enabled: 0, active: 0, archived: 0 },
    schema: {
      tables: [],
      variant: "unknown",
      stage1_outputs_table: false,
      legacy_jobs_table: false,
      agent_jobs_table: false,
      agent_job_items_table: false,
      stage1_counters_available: false,
    },
    stage1_outputs: {
      available: false,
      source: "missing_table",
      total: 0,
      raw_memory: 0,
      rollout_summary: 0,
    },
    memory_stage1_jobs: {
      available: false,
      source: "missing_table",
      total: 0,
      by_status: {},
      errors: [],
    },
    agent_jobs: { total: 0, by_status: {}, items_total: 0, items_by_status: {}, errors: [] },
  };
}

function sqliteCount(db: SqliteDatabase, query: string, params: unknown[] = []): number {
  try {
    const row = db.prepare(query).get(...params) as Record<string, unknown> | undefined;
    if (row === undefined) return 0;
    const value = Object.values(row)[0];
    return Number(value ?? 0) || 0;
  } catch {
    return 0;
  }
}

function sqliteGroupCounts(db: SqliteDatabase, query: string, params: unknown[] = []): Dict {
  const out: Dict = {};
  try {
    const rows = db.prepare(query).raw().all(...params) as unknown[][];
    for (const row of rows) {
      out[String(row[0])] = Number(row[1] ?? 0) || 0;
    }
  } catch {
    /* degrade to {} */
  }
  return out;
}

function isSubset(needed: string[], columns: Set<string>): boolean {
  return needed.every((c) => columns.has(c));
}

/**
 * Summarize Codex's local memory pipeline state without reading auth data.
 * Faithful port of `_inspect_codex_state_db`. Returns the empty report when the
 * DB is missing/unreadable (or better-sqlite3 is unavailable).
 */
export function inspectCodexStateDb(codexHome: string | null): Dict {
  const report = emptyCodexStateReport(codexHome);
  const dbPath = codexHome ? join(codexHome, "state_5.sqlite") : null;
  if (dbPath === null || !isFile(dbPath)) {
    report.error = "missing";
    return report;
  }
  if (!sqliteAvailable()) {
    report.error = "sqlite-unavailable";
    return report;
  }

  let db: SqliteDatabase;
  try {
    db = openReadonly(dbPath);
  } catch (exc) {
    report.error = String(exc);
    return report;
  }

  const schema = report.schema as Dict;
  const threads = report.threads as Dict;
  const stage1Outputs = report.stage1_outputs as Dict;
  const memoryJobs = report.memory_stage1_jobs as Dict;
  const agentJobs = report.agent_jobs as Dict;

  try {
    report.readable = true;
    const tableRows = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .raw()
      .all() as unknown[][];
    const tables = new Set(tableRows.map((row) => String(row[0])));
    schema.tables = [...tables].sort();
    schema.stage1_outputs_table = tables.has("stage1_outputs");
    schema.legacy_jobs_table = tables.has("jobs");
    schema.agent_jobs_table = tables.has("agent_jobs");
    schema.agent_job_items_table = tables.has("agent_job_items");
    if (tables.has("stage1_outputs") || tables.has("jobs")) {
      schema.variant = "legacy_stage1";
      schema.stage1_counters_available = true;
    } else if (tables.has("agent_jobs") || tables.has("agent_job_items")) {
      schema.variant = "agent_jobs";
      stage1Outputs.source = "unavailable_new_schema";
      memoryJobs.source = "unavailable_new_schema";
    }

    if (tableExists(db, "threads")) {
      const threadColumns = tableColumns(db, "threads");
      threads.total = sqliteCount(db, "SELECT count(*) FROM threads");
      if (threadColumns.has("memory_mode")) {
        threads.memory_enabled = sqliteCount(
          db,
          "SELECT count(*) FROM threads WHERE memory_mode = ?",
          ["enabled"],
        );
      }
      if (threadColumns.has("archived")) {
        threads.active = sqliteCount(db, "SELECT count(*) FROM threads WHERE archived = 0");
        threads.archived = sqliteCount(db, "SELECT count(*) FROM threads WHERE archived = 1");
      }
    }

    if (tableExists(db, "stage1_outputs")) {
      stage1Outputs.available = true;
      stage1Outputs.source = "legacy_stage1_outputs";
      const stage1Columns = tableColumns(db, "stage1_outputs");
      stage1Outputs.total = sqliteCount(db, "SELECT count(*) FROM stage1_outputs");
      if (stage1Columns.has("raw_memory")) {
        stage1Outputs.raw_memory = sqliteCount(db, "SELECT count(raw_memory) FROM stage1_outputs");
      }
      if (stage1Columns.has("rollout_summary")) {
        stage1Outputs.rollout_summary = sqliteCount(
          db,
          "SELECT count(rollout_summary) FROM stage1_outputs",
        );
      }
    }

    if (tableExists(db, "jobs")) {
      memoryJobs.available = true;
      memoryJobs.source = "legacy_jobs";
      const jobColumns = tableColumns(db, "jobs");
      if (isSubset(["kind", "status"], jobColumns)) {
        const byStatus = sqliteGroupCounts(
          db,
          "SELECT status, count(*) FROM jobs WHERE kind = ? GROUP BY status ORDER BY status",
          ["memory_stage1"],
        );
        memoryJobs.by_status = byStatus;
        memoryJobs.total = Object.values(byStatus).reduce((a: number, b) => a + Number(b), 0);
      }
      if (isSubset(["kind", "job_key", "status", "retry_remaining", "last_error"], jobColumns)) {
        const errorRows = db
          .prepare(
            "SELECT job_key, status, retry_remaining, last_error FROM jobs " +
              "WHERE kind = ? AND status != ? ORDER BY job_key LIMIT 20",
          )
          .raw()
          .all("memory_stage1", "done") as unknown[][];
        memoryJobs.errors = errorRows.map((row) => ({
          job_key: String(row[0]),
          status: String(row[1]),
          retry_remaining: Number(row[2] ?? 0) || 0,
          last_error: String(row[3] ?? "").slice(0, 500),
        }));
      }
    }

    if (tableExists(db, "agent_jobs")) {
      const agentJobColumns = tableColumns(db, "agent_jobs");
      agentJobs.total = sqliteCount(db, "SELECT count(*) FROM agent_jobs");
      if (agentJobColumns.has("status")) {
        agentJobs.by_status = sqliteGroupCounts(
          db,
          "SELECT status, count(*) FROM agent_jobs GROUP BY status ORDER BY status",
        );
      }
      if (isSubset(["id", "name", "status", "last_error"], agentJobColumns)) {
        const errorRows = db
          .prepare(
            "SELECT id, name, status, last_error FROM agent_jobs " +
              "WHERE status NOT IN ('done', 'completed', 'success', 'succeeded') " +
              "ORDER BY updated_at DESC LIMIT 20",
          )
          .raw()
          .all() as unknown[][];
        agentJobs.errors = errorRows.map((row) => ({
          job_id: String(row[0]),
          name: String(row[1]),
          status: String(row[2]),
          last_error: String(row[3] ?? "").slice(0, 500),
        }));
      }
    }

    if (tableExists(db, "agent_job_items")) {
      const itemColumns = tableColumns(db, "agent_job_items");
      agentJobs.items_total = sqliteCount(db, "SELECT count(*) FROM agent_job_items");
      if (itemColumns.has("status")) {
        agentJobs.items_by_status = sqliteGroupCounts(
          db,
          "SELECT status, count(*) FROM agent_job_items GROUP BY status ORDER BY status",
        );
      }
    }
  } catch (exc) {
    report.readable = false;
    report.error = String(exc);
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  return report;
}

/** Convert a Codex state timestamp (epoch ms/s or ISO) to a `YYYY-MM-DD` date. */
export function dateFromStateTimestamp(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const num = Number(text);
  if (Number.isFinite(num) && text !== "" && /^[\d.+\-eE]+$/.test(text)) {
    let n = num;
    if (n > 10_000_000_000) n = n / 1000;
    const d = new Date(n * 1000);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(text.replace("Z", "+00:00"));
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Read up to `limit` lightweight thread records from `state_5.sqlite` (read-only,
 * defensive column checks). Faithful port of `_collect_lightweight_session_records`.
 * Returns `[]` when the DB is absent / unreadable / sqlite is unavailable.
 */
export function collectLightweightSessionRecords(
  codexHome: string | null,
  limit: number,
): Dict[] {
  if (codexHome === null) return [];
  const dbPath = join(codexHome, "state_5.sqlite");
  if (!isFile(dbPath)) return [];
  if (!sqliteAvailable()) return [];

  let db: SqliteDatabase;
  try {
    db = openReadonly(dbPath);
  } catch {
    return [];
  }

  let rows: Dict[];
  try {
    if (!tableExists(db, "threads")) return [];
    const columns = tableColumns(db, "threads");
    if (!columns.has("id")) return [];
    const selectable = [
      "id",
      "title",
      "first_user_message",
      "cwd",
      "rollout_path",
      "updated_at_ms",
      "updated_at",
      "created_at_ms",
      "created_at",
    ].filter((c) => columns.has(c));
    if (!selectable.includes("title") && !selectable.includes("first_user_message")) return [];
    const orderColumn =
      ["updated_at_ms", "updated_at", "created_at_ms", "created_at"].find((c) => columns.has(c)) ??
      "id";
    const escapedSelect = selectable.map((c) => `"${c}"`).join(", ");
    const query = `SELECT ${escapedSelect} FROM threads ORDER BY "${orderColumn}" DESC LIMIT ?`;
    rows = db.prepare(query).all(limit) as Dict[];
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  const records: Dict[] = [];
  for (const row of rows) {
    const title = safeNativeMemoryText(String(row.title ?? ""), 180);
    const firstMessage = safeNativeMemoryText(String(row.first_user_message ?? ""), 180);
    const threadName = title || firstMessage || "(untitled)";
    const updatedAt = String(
      row.updated_at_ms ?? row.updated_at ?? row.created_at_ms ?? row.created_at ?? "",
    );
    const sessionDate = dateFromStateTimestamp(updatedAt);
    if (!sessionDate) continue;
    records.push({
      id: String(row.id ?? ""),
      thread_name: threadName,
      updated_at: updatedAt,
      date: sessionDate,
      cwd: typeof row.cwd === "string" ? row.cwd : null,
      has_rollout: Boolean(row.rollout_path),
      files_touched: [],
    });
  }
  return records;
}
