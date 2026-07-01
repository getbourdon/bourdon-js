/**
 * GitHub Copilot CLI participant — normalize the `copilot` terminal agent's
 * SQLite session store into L5. Port of `participants/copilot_cli.py`.
 *
 * Copilot CLI stores session history in a SQLite database at
 * `~/.copilot/session-store.db` (override `$COPILOT_CLI_HOME`). This is distinct
 * from:
 *   - the VS Code Copilot Chat extension (`github-copilot` network reader)
 *   - the `~/.copilot-bourdon/memory.md` convention-file participant (`copilot`)
 *   - GitHub-embedded Copilot (no local state)
 *
 * The schema (schema_version 4) carries `sessions` / `turns` / `checkpoints`
 * plus `session_files` / `session_refs` / `dynamic_context_items`. The reader
 * opens the DB read-only (`mode=ro` via {@link tryOpenReadonly}) so a live
 * writer's lock can never block the export, probes each table defensively (a
 * missing table degrades to "no rows" rather than raising), redacts every native
 * string, applies the visibility filter BEFORE emission, and is deterministic.
 * `healthCheck` never throws.
 */

import { statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import {
  Visibility,
  filterForFederation,
  makeAgentInfo,
  makeEntity,
  makeManifest,
  makeSession,
  makeVisibilityPolicy,
  type EntityModel,
  type L5ManifestModel,
  type SessionModel,
  type VisibilityPolicyModel,
} from "@getbourdon/l5";
import { redactText } from "@getbourdon/redaction";

import {
  ParticipantDiscoveryError,
  SPEC_VERSION,
  type AgentStore,
  type BourdonParticipant,
  type HealthStatus,
} from "../base.js";
import { tryOpenReadonly, type SqliteDatabase } from "../sqlite-base.js";

const AGENT_ID = "copilot-cli";
const AGENT_TYPE = "code-assistant";
const DISPLAY_NAME = "GitHub Copilot CLI";
const ROLE_NARRATIVE =
  "Terminal-native Copilot agent with full filesystem + tool access. " +
  "Runs multi-turn sessions with checkpoints, file edits, and git " +
  "operations. The CLI surface has the deepest tool integration of " +
  "all Copilot surfaces — shell, grep, edit, git — and persists " +
  "rich session history locally in SQLite.";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "health", "family", "legal"],
  team_tags: ["copilot-cli", "copilot", "terminal", "workspace"],
});

const DB_FILENAME = "session-store.db";
const COPILOT_DIR_NAME = ".copilot";
const MAX_SUMMARY_CHARS = 260;
const MAX_KEY_ACTIONS = 6;
const MAX_KEY_ACTION_CHARS = 280;

// -- Path resolution ----------------------------------------------------------

/**
 * Conventional `~/.copilot/` directory. Respects the `COPILOT_CLI_HOME`
 * environment-variable override (mirrors `default_copilot_cli_dir`).
 */
export function defaultCopilotCliDir(): string {
  const env = process.env.COPILOT_CLI_HOME;
  if (env) return env;
  return join(homedir(), COPILOT_DIR_NAME);
}

/** Path to `session-store.db` under the given (or conventional) copilot dir. */
function defaultCopilotCliDbPath(copilotDir?: string | null): string {
  return join(copilotDir ?? defaultCopilotCliDir(), DB_FILENAME);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// -- Text helpers -------------------------------------------------------------

/** Redact secrets + clamp to the native-memory limit (`_safe_native_memory_text`). */
function safeNativeMemoryText(value: string, limit = 180): string {
  return redactText(value, limit);
}

/**
 * Collapse whitespace and clamp with a single-char ellipsis (mirrors the
 * oracle's `_bounded`). NOTE: distinct from {@link redactText}'s `...` clamp —
 * this one uses `…` (U+2026) and does no redaction.
 */
function bounded(value: string, limit: number): string {
  const normalized = value.split(/\s+/).filter(Boolean).join(" ");
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, limit - 1).replace(/\s+$/, "") + "…";
}

// -- SQLite (read-only) -------------------------------------------------------

/** Run a query and return rows as plain objects. Never raises (a missing table
 * or any SQLite error degrades to `[]`, matching the oracle's `_query_db`). */
function queryDb(
  db: SqliteDatabase,
  sql: string,
  params: unknown[] = [],
): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function extractSessions(db: SqliteDatabase, since?: string | null): Array<Record<string, unknown>> {
  let sql = "SELECT id, cwd, repository, branch, summary, created_at, updated_at FROM sessions";
  const params: unknown[] = [];
  if (since) {
    sql += " WHERE created_at >= ?";
    params.push(since);
  }
  sql += " ORDER BY created_at DESC LIMIT 200";
  return queryDb(db, sql, params);
}

function extractSessionFiles(db: SqliteDatabase, sessionId: string): string[] {
  const rows = queryDb(
    db,
    "SELECT file_path FROM session_files WHERE session_id = ? LIMIT 20",
    [sessionId],
  );
  const out: string[] = [];
  for (const r of rows) {
    const fp = r["file_path"];
    if (fp) out.push(String(fp));
  }
  return out;
}

function extractSessionRefs(
  db: SqliteDatabase,
  sessionId: string,
): Array<{ ref_type: string; ref_value: string }> {
  const rows = queryDb(
    db,
    "SELECT ref_type, ref_value FROM session_refs WHERE session_id = ?",
    [sessionId],
  );
  return rows.map((r) => ({
    ref_type: String(r["ref_type"] ?? ""),
    ref_value: String(r["ref_value"] ?? ""),
  }));
}

function extractCheckpoints(db: SqliteDatabase, sessionId: string): Array<Record<string, unknown>> {
  return queryDb(
    db,
    "SELECT checkpoint_number, title, overview FROM checkpoints " +
      "WHERE session_id = ? ORDER BY checkpoint_number",
    [sessionId],
  );
}

function extractDynamicContext(db: SqliteDatabase): Array<Record<string, unknown>> {
  return queryDb(
    db,
    "SELECT repository, branch, src, name, description, content, read_count, count " +
      "FROM dynamic_context_items ORDER BY count DESC LIMIT 50",
  );
}

function extractTurnCount(db: SqliteDatabase, sessionId: string): number {
  const rows = queryDb(db, "SELECT COUNT(*) as cnt FROM turns WHERE session_id = ?", [sessionId]);
  const first = rows[0];
  return first ? Number(first["cnt"] ?? 0) || 0 : 0;
}

// -- Conversion to Bourdon types ----------------------------------------------

function sessionToBourdon(
  raw: Record<string, unknown>,
  files: string[],
  refs: Array<{ ref_type: string; ref_value: string }>,
  checkpoints: Array<Record<string, unknown>>,
  turnCount: number,
): SessionModel {
  const created = raw["created_at"] ? String(raw["created_at"]) : "";
  const dateStr = created ? created.slice(0, 10) : "";

  const keyActions: string[] = [];
  if (raw["summary"]) {
    keyActions.push(bounded(safeNativeMemoryText(String(raw["summary"])), MAX_KEY_ACTION_CHARS));
  }
  for (const cp of checkpoints.slice(0, 3)) {
    if (cp["title"]) {
      keyActions.push(
        bounded(`checkpoint: ${safeNativeMemoryText(String(cp["title"]))}`, MAX_KEY_ACTION_CHARS),
      );
    }
  }
  if (turnCount) {
    keyActions.push(`turns: ${turnCount}`);
  }
  for (const ref of refs.slice(0, 3)) {
    const refLabel = `${ref.ref_type}: ${ref.ref_value}`;
    keyActions.push(bounded(refLabel, MAX_KEY_ACTION_CHARS));
  }

  const projectFocus: string[] = [];
  if (raw["repository"]) projectFocus.push(String(raw["repository"]));

  return makeSession({
    date: dateStr,
    cwd: raw["cwd"] ? String(raw["cwd"]) : undefined,
    project_focus: projectFocus,
    key_actions: keyActions.slice(0, MAX_KEY_ACTIONS),
    files_touched: files.slice(0, 20),
    visibility: Visibility.TEAM,
  });
}

function entitiesFromSessionsAndContext(
  sessions: Array<Record<string, unknown>>,
  dynamicContext: Array<Record<string, unknown>>,
): EntityModel[] {
  const entities = new Map<string, EntityModel>();

  // Repositories as project entities.
  for (const raw of sessions) {
    const repo = raw["repository"] ? String(raw["repository"]) : "";
    if (repo && !entities.has(repo)) {
      const created = raw["created_at"] ? String(raw["created_at"]) : "";
      const lastTouched = created.slice(0, 10) || null;
      entities.set(
        repo,
        makeEntity({
          name: repo,
          type: "project",
          summary: "Repository worked on via Copilot CLI.",
          last_touched: lastTouched ?? undefined,
          tags: ["copilot-cli", "project"],
          visibility: Visibility.TEAM,
        }),
      );
    }
  }

  // Dynamic context items as knowledge entities.
  for (const ctx of dynamicContext) {
    const name = ctx["name"] ? String(ctx["name"]) : "";
    if (!name || entities.has(name)) continue;
    const desc = ctx["description"] ? String(ctx["description"]) : "";
    const content = ctx["content"] ? String(ctx["content"]) : "";
    let summaryText = desc || content;
    if (summaryText) {
      summaryText = bounded(safeNativeMemoryText(summaryText), MAX_SUMMARY_CHARS);
    }
    entities.set(
      name,
      makeEntity({
        name,
        type: "dynamic-context",
        summary: summaryText || undefined,
        last_touched: undefined,
        tags: ["copilot-cli", "dynamic-context", ctx["src"] ? String(ctx["src"]) : "unknown"],
        visibility: Visibility.TEAM,
      }),
    );
  }

  return [...entities.values()];
}

/** UTC ISO datetime with `+00:00` offset (matching Python `isoformat`). */
function toUtcIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00").replace(/Z$/, "+00:00");
}

// -- Participant --------------------------------------------------------------

/**
 * External participant for GitHub Copilot CLI (`~/.copilot/session-store.db`).
 * Reads the SQLite database read-only (never locks the live db).
 */
export class CopilotCliParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  displayName = DISPLAY_NAME;
  nativePath: string;

  private readonly copilotDir: string | null;

  /** Conventional `~/.copilot` dir used by the setup wizard's detection. */
  static defaultNativePath(home?: string): string {
    if (home) return join(home, COPILOT_DIR_NAME);
    return defaultCopilotCliDir();
  }

  constructor(copilotDir?: string) {
    this.copilotDir = copilotDir ?? null;
    this.nativePath = this.copilotDir ?? defaultCopilotCliDir();
  }

  // -- Protocol surface -------------------------------------------------------

  discover(): AgentStore {
    const dbPath = defaultCopilotCliDbPath(this.copilotDir);
    if (!isFile(dbPath)) {
      throw new ParticipantDiscoveryError(
        `Copilot CLI session-store.db not found at ${dbPath}. ` +
          "The Copilot CLI agent must be run at least once to create this database.",
      );
    }
    let dbSize = 0;
    try {
      dbSize = statSync(dbPath).size;
    } catch {
      dbSize = 0;
    }
    return {
      path: dirname(dbPath),
      version: "schema-v4",
      metadata: { db_path: dbPath, db_size_bytes: dbSize },
    };
  }

  exportSessions(since?: Date, limit = 100): SessionModel[] {
    const dbPath = defaultCopilotCliDbPath(this.copilotDir);
    const db = tryOpenReadonly(dbPath);
    if (!db) return [];
    try {
      const sinceIso = since ? toUtcIso(since) : null;
      const rawSessions = extractSessions(db, sinceIso);
      const sessions: SessionModel[] = [];
      for (const raw of rawSessions.slice(0, limit)) {
        const sid = String(raw["id"]);
        const files = extractSessionFiles(db, sid);
        const refs = extractSessionRefs(db, sid);
        const checkpoints = extractCheckpoints(db, sid);
        const turnCount = extractTurnCount(db, sid);
        sessions.push(sessionToBourdon(raw, files, refs, checkpoints, turnCount));
      }
      return sessions;
    } finally {
      db.close();
    }
  }

  exportL5(since?: Date): L5ManifestModel {
    const dbPath = defaultCopilotCliDbPath(this.copilotDir);
    const db = tryOpenReadonly(dbPath);
    if (!db) return this.emptyManifest();
    try {
      const sinceIso = since ? toUtcIso(since) : null;
      const rawSessions = extractSessions(db, sinceIso);
      const dynamicContext = extractDynamicContext(db);

      const sessions: SessionModel[] = [];
      for (const raw of rawSessions.slice(0, 100)) {
        const sid = String(raw["id"]);
        const files = extractSessionFiles(db, sid);
        const refs = extractSessionRefs(db, sid);
        const checkpoints = extractCheckpoints(db, sid);
        const turnCount = extractTurnCount(db, sid);
        sessions.push(sessionToBourdon(raw, files, refs, checkpoints, turnCount));
      }

      const entities = entitiesFromSessionsAndContext(rawSessions, dynamicContext);
      const visibleEntities = filterForFederation(entities, DEFAULT_POLICY);

      return makeManifest({
        spec_version: SPEC_VERSION,
        agent: makeAgentInfo({
          id: AGENT_ID,
          type: AGENT_TYPE,
          instance: hostname() || "unknown",
          spec_version_compat: `>=${SPEC_VERSION}`,
          role_narrative: ROLE_NARRATIVE,
        }),
        last_updated: new Date().toISOString(),
        capabilities: [
          "terminal-agent",
          "file-edit",
          "shell-execution",
          "git-operations",
          "multi-turn-sessions",
          "checkpoints",
          "dynamic-context",
        ],
        recent_sessions: sessions,
        known_entities: visibleEntities,
        visibility_policy: DEFAULT_POLICY,
      });
    } finally {
      db.close();
    }
  }

  healthCheck(): HealthStatus {
    try {
      const copilotDir = this.copilotDir ?? defaultCopilotCliDir();
      if (!isDir(copilotDir)) {
        return {
          status: "blocked",
          reason: `Copilot CLI directory not found at ${copilotDir}.`,
          details: { expected_path: copilotDir },
          proposedFix:
            "Run the Copilot CLI agent (`copilot` or `gh copilot`) at least once " +
            "to create the session store.",
        };
      }
      const dbPath = defaultCopilotCliDbPath(copilotDir);
      if (!isFile(dbPath)) {
        return {
          status: "blocked",
          reason: `session-store.db not found at ${dbPath}.`,
          details: { expected_db: dbPath },
          proposedFix:
            "Run the Copilot CLI agent at least once. The session-store.db is " +
            "created on first use.",
        };
      }
      const db = tryOpenReadonly(dbPath);
      if (!db) {
        return {
          status: "degraded",
          reason: "Cannot copy session-store.db for reading.",
          details: { db_path: dbPath },
          proposedFix: "Check file permissions on the session-store.db.",
        };
      }
      try {
        const rawSessions = extractSessions(db);
        const dynamicContext = extractDynamicContext(db);
        const totalTurns = queryDb(db, "SELECT COUNT(*) as cnt FROM turns");
        const first = totalTurns[0];
        let dbSize = 0;
        try {
          dbSize = statSync(dbPath).size;
        } catch {
          dbSize = 0;
        }
        return {
          status: "ok",
          details: {
            db_path: dbPath,
            db_size_bytes: dbSize,
            session_count: rawSessions.length,
            total_turns: first ? Number(first["cnt"] ?? 0) || 0 : 0,
            dynamic_context_items: dynamicContext.length,
          },
        };
      } finally {
        db.close();
      }
    } catch (err) {
      // healthCheck must NEVER raise (contract).
      return {
        status: "degraded",
        reason: `unexpected error: ${String(err)}`,
        details: {},
      };
    }
  }

  // -- Internal ---------------------------------------------------------------

  private emptyManifest(): L5ManifestModel {
    return makeManifest({
      spec_version: SPEC_VERSION,
      agent: makeAgentInfo({
        id: AGENT_ID,
        type: AGENT_TYPE,
        instance: hostname() || "unknown",
        spec_version_compat: `>=${SPEC_VERSION}`,
        role_narrative: ROLE_NARRATIVE,
      }),
      last_updated: new Date().toISOString(),
      capabilities: [],
      recent_sessions: [],
      known_entities: [],
      visibility_policy: DEFAULT_POLICY,
    });
  }
}
