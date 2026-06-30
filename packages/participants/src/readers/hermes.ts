/**
 * Hermes participant — normalize Hermes Agent (Nous Research) memory + sessions
 * into L5. Port of `participants/hermes.py`.
 *
 * Reads two surfaces under `~/.hermes/` (override `$HERMES_HOME`):
 *   * `state.db` — a SQLite store (`sessions` + `messages` tables). Recent
 *     non-archived sessions + project entities (from cwd basename) come from it.
 *   * `memories/{memory.md,user.md}` — durable cross-session facts (one
 *     Markdown bullet/line per memory). The highest-signal entities.
 *
 * Read-only (`mode=ro`), deterministic, visibility-enforced-before-emission,
 * and redaction on every native string. `healthCheck` never throws; `discover`
 * raises only {@link ParticipantDiscoveryError}.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  CONTRACT_VERSION,
  ParticipantDiscoveryError,
  SPEC_VERSION,
  type AgentStore,
  type BourdonParticipant,
  type HealthStatus,
} from "../base.js";
import {
  epochToIsoDate,
  friendlyLabel,
  projectKeyFromCwd,
  tableColumns,
  tableExists,
  tryOpenReadonly,
  type SqliteDatabase,
} from "../sqlite-base.js";

const AGENT_ID = "hermes";
const AGENT_TYPE = "code-assistant";
const DISPLAY_NAME = "Hermes Agent";
const ROLE_NARRATIVE =
  "General-purpose tool-calling assistant (Nous Research). Operates across CLI, " +
  "TUI, and messaging gateways (Slack/Telegram/Discord/WhatsApp); runs terminal, " +
  "file, web, and delegation toolsets. Carries durable cross-session memory and a " +
  "curated skill library. Federates session + memory context, not vendor account.";

const DEFAULT_SESSION_LIMIT = 100;

/** Hermes memory stores live as Markdown under `~/.hermes/memories/`. */
const MEMORY_FILENAMES = ["memory.md", "user.md"] as const;

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "secret", "health", "family", "legal"],
  team_tags: ["hermes-memory", "hermes-session", "hermes-project"],
});

/** cwd basenames that carry no project identity. */
const GENERIC_PROJECT_NAMES = new Set([
  "",
  "root",
  "home",
  "tmp",
  "temp",
  "desktop",
  "documents",
  "downloads",
  "src",
]);

// -- Path resolution ----------------------------------------------------------

/**
 * Conventional Hermes home used by the setup wizard's detection.
 * Precedence: explicit `home` > `$HERMES_HOME` > `~/.hermes`.
 */
export function defaultNativePath(home?: string): string {
  if (home) return join(home, ".hermes");
  const env = process.env.HERMES_HOME;
  if (env) return env;
  return join(homedir(), ".hermes");
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// -- Text helpers -------------------------------------------------------------

interface SessionRecord {
  id: string;
  source: string;
  model: unknown;
  title: string | null;
  cwd: string | null;
  date: string;
  messageCount: number;
  toolCallCount: number;
}

/** Redact secrets, collapse whitespace, and clamp length. */
function bounded(value: string, limit = 240): string {
  const cleaned = redactText((value || "").replace(/\s+/g, " ").trim(), limit);
  return cleaned.trim();
}

function projectKey(cwd: string | null | undefined): string | null {
  return projectKeyFromCwd(cwd, GENERIC_PROJECT_NAMES);
}

// -- SQLite (read-only) -------------------------------------------------------

/** Pull recent, non-archived sessions newest-first. Never raises. */
function collectSessionRows(stateDb: string, limit = DEFAULT_SESSION_LIMIT): SessionRecord[] {
  if (!isFile(stateDb)) return [];
  const conn = tryOpenReadonly(stateDb);
  if (!conn) return [];
  const out: SessionRecord[] = [];
  try {
    if (!tableExists(conn, "sessions")) return [];
    // `archived` may be absent in older schemas — guard the column.
    const cols = tableColumns(conn, "sessions");
    const archivedClause = cols.has("archived") ? "WHERE COALESCE(archived, 0) = 0" : "";
    const rows = conn
      .prepare(
        `SELECT id, source, model, title, cwd, started_at, ended_at,
                message_count, tool_call_count
         FROM sessions
         ${archivedClause}
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const day = epochToIsoDate(r["started_at"]);
      if (!day) continue;
      out.push({
        id: String(r["id"]),
        source: String(r["source"] ?? "").toLowerCase(),
        model: r["model"],
        title: (r["title"] as string | null) ?? null,
        cwd: (r["cwd"] as string | null) ?? null,
        date: day,
        messageCount: Number(r["message_count"] ?? 0) || 0,
        toolCallCount: Number(r["tool_call_count"] ?? 0) || 0,
      });
    }
  } catch {
    /* degrade to whatever rows we gathered */
  } finally {
    conn.close();
  }
  return out;
}

/** Distinct tool names used in a session, for key_actions evidence. */
function toolNamesForSession(conn: SqliteDatabase, sessionId: string): string[] {
  if (!tableExists(conn, "messages")) return [];
  try {
    const rows = conn
      .prepare(
        `SELECT DISTINCT tool_name FROM messages
         WHERE session_id = ? AND tool_name IS NOT NULL AND tool_name != ''`,
      )
      .all(sessionId) as Array<{ tool_name: string }>;
    const names = new Set<string>();
    for (const r of rows) {
      if (r.tool_name) names.add(r.tool_name);
    }
    return [...names].sort();
  } catch {
    return [];
  }
}

// -- Memory parsing -----------------------------------------------------------

const BULLET_RE = /^\s*[-*]\s+(.*)$/;

/** Return memory entries (one per bullet / non-empty line). Never raises. */
function parseMemoryFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = BULLET_RE.exec(line);
    const candidate = m ? (m[1] ?? "") : line.trim();
    if (candidate && !candidate.startsWith("#")) entries.push(candidate);
  }
  return entries;
}

/** Map memory store name → list of entry strings. */
function collectMemoryEntries(home: string): Array<[string, string[]]> {
  const memDir = join(home, "memories");
  const result: Array<[string, string[]]> = [];
  if (!isDir(memDir)) return result;
  for (const fname of MEMORY_FILENAMES) {
    const path = join(memDir, fname);
    if (isFile(path)) {
      const entries = parseMemoryFile(path);
      if (entries.length) {
        const stem = fname.replace(/\.md$/, "");
        result.push([stem, entries]);
      }
    }
  }
  return result;
}

// -- Entity / session builders ------------------------------------------------

function buildSession(record: SessionRecord, toolNames: string[]): SessionModel {
  const key = projectKey(record.cwd);
  const focus: string[] = [];
  if (key) focus.push(key);
  const keyActions: string[] = [];
  if (record.title) keyActions.push(bounded(record.title, 160));
  if (toolNames.length) {
    keyActions.push("Tools: " + toolNames.slice(0, 8).join(", "));
  } else if (record.toolCallCount) {
    keyActions.push(`${record.toolCallCount} tool call(s)`);
  }
  return makeSession({
    date: record.date,
    cwd: record.cwd || undefined,
    project_focus: focus,
    key_actions: keyActions,
    visibility: Visibility.TEAM,
  });
}

/** Turn a single memory line into a team-visibility entity. */
function memoryEntity(store: string, entry: string): EntityModel {
  const tag = store === "user" ? "hermes-user-memory" : "hermes-memory";
  return makeEntity({
    name: bounded(entry, 80),
    type: store === "user" ? "preference" : "fact",
    summary: bounded(entry, 240),
    tags: [tag],
    visibility: Visibility.TEAM,
  });
}

function projectEntities(records: SessionRecord[]): EntityModel[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const key = projectKey(r.cwd);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entities: EntityModel[] = [];
  for (const [key, count] of counts) {
    let last: string | undefined;
    for (const r of records) {
      if (projectKey(r.cwd) === key) {
        if (last === undefined || r.date > last) last = r.date;
      }
    }
    entities.push(
      makeEntity({
        name: friendlyLabel(key),
        type: "project",
        summary: `Workspace observed across ${count} Hermes session(s).`,
        aliases: [key],
        last_touched: last,
        tags: ["hermes-project"],
        visibility: Visibility.TEAM,
      }),
    );
  }
  return entities;
}

// -- Participant --------------------------------------------------------------

/** External participant for local Hermes Agent memory + sessions. */
export class HermesParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  displayName = DISPLAY_NAME;
  nativePath: string;

  private readonly home: string | null;

  static defaultNativePath(home?: string): string {
    return defaultNativePath(home);
  }

  /** `hermesHome` is the `.hermes` directory itself (matching the Python ctor). */
  constructor(hermesHome?: string) {
    if (hermesHome) {
      this.home = hermesHome;
    } else {
      const path = defaultNativePath();
      this.home = isDir(path) ? path : null;
    }
    this.nativePath = this.home ?? join(homedir(), ".hermes");
  }

  private sources(): Record<string, string | null> {
    const home = this.home;
    const stateDb = home ? join(home, "state.db") : null;
    const memDir = home ? join(home, "memories") : null;
    const skillsDir = home ? join(home, "skills") : null;
    return {
      hermes_home: home,
      state_db: stateDb && isFile(stateDb) ? stateDb : null,
      memories_dir: memDir && isDir(memDir) ? memDir : null,
      skills_dir: skillsDir && isDir(skillsDir) ? skillsDir : null,
    };
  }

  discover(): AgentStore {
    const sources = this.sources();
    if (!Object.values(sources).some((v) => v)) {
      throw new ParticipantDiscoveryError(
        "No Hermes memory sources found. Expected ~/.hermes/ (set $HERMES_HOME to override).",
      );
    }
    if (!sources["state_db"] && !sources["memories_dir"]) {
      throw new ParticipantDiscoveryError(
        `Hermes home '${this.nativePath}' exists but has no state.db or memories/ — ` +
          "nothing to federate yet.",
      );
    }
    return {
      path: this.nativePath,
      version: "hermes-home-v1",
      metadata: { sources },
    };
  }

  exportSessions(since?: Date, limit = DEFAULT_SESSION_LIMIT): SessionModel[] {
    if (this.home === null) return [];
    const stateDb = join(this.home, "state.db");
    const cutoff = since ? since.toISOString().slice(0, 10) : null;
    const records = collectSessionRows(stateDb, limit);
    if (!records.length) return [];
    const conn = tryOpenReadonly(stateDb);
    const out: SessionModel[] = [];
    try {
      for (const rec of records) {
        if (cutoff && rec.date < cutoff) continue;
        const tools = conn ? toolNamesForSession(conn, rec.id) : [];
        out.push(buildSession(rec, tools));
      }
    } finally {
      if (conn) conn.close();
    }
    return out;
  }

  exportL5(since?: Date): L5ManifestModel {
    const store = this.discover();
    const sources = (store.metadata["sources"] ?? {}) as Record<string, string | null>;
    const capabilities = Object.entries(sources)
      .filter(([k, v]) => v && k !== "hermes_home")
      .map(([k]) => k)
      .sort();

    const home = this.home;
    const records = home ? collectSessionRows(join(home, "state.db"), DEFAULT_SESSION_LIMIT) : [];

    // Entities: project workspaces + memory-derived facts/preferences.
    const entities: EntityModel[] = projectEntities(records);
    const seen = new Set<string>();
    for (const e of entities) {
      seen.add(`${e.type || "topic"} ${e.name.toLowerCase()}`);
    }
    if (home) {
      for (const [storeName, entries] of collectMemoryEntries(home)) {
        for (const entry of entries) {
          const ent = memoryEntity(storeName, entry);
          const key = `${ent.type || "topic"} ${ent.name.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          entities.push(ent);
        }
      }
    }

    // Visibility enforced here, before emission (contract requirement).
    const visible = filterForFederation(entities, DEFAULT_POLICY);

    const sessions = this.exportSessions(
      since ?? new Date(0),
      DEFAULT_SESSION_LIMIT,
    );

    return makeManifest({
      spec_version: SPEC_VERSION,
      agent: makeAgentInfo({
        id: this.agentId,
        type: this.agentType,
        role_narrative: ROLE_NARRATIVE,
        spec_version_compat: CONTRACT_VERSION,
      }),
      last_updated: new Date().toISOString(),
      capabilities,
      recent_sessions: sessions,
      known_entities: visible,
      visibility_policy: DEFAULT_POLICY,
    });
  }

  healthCheck(): HealthStatus {
    const details: Record<string, unknown> = {
      hermes_home: this.nativePath,
      state_db: "missing",
      memories_dir: "missing",
      skills_dir: "missing",
    };
    try {
      if (this.home === null) {
        return {
          status: "blocked",
          reason: "~/.hermes/ not found — Hermes Agent not installed here",
          details,
          proposedFix:
            "Install Hermes Agent and run a session once, then `bourdon export-all`.",
        };
      }
      const sources = this.sources();
      for (const key of ["state_db", "memories_dir", "skills_dir"] as const) {
        if (sources[key]) details[key] = sources[key];
      }
      if (sources["state_db"]) {
        const records = collectSessionRows(join(this.home, "state.db"), 1);
        if (records.length) return { status: "ok", details };
        return {
          status: "degraded",
          reason: "state.db present but no readable sessions yet",
          details,
          proposedFix: "Run at least one Hermes session, then `bourdon export-all`.",
        };
      }
      if (sources["memories_dir"]) {
        return {
          status: "degraded",
          reason: "memories/ present but state.db missing — session history unavailable",
          details,
        };
      }
      return {
        status: "blocked",
        reason: "Hermes home has neither state.db nor memories/",
        details,
        proposedFix: "Run a Hermes session to populate ~/.hermes/state.db.",
      };
    } catch (err) {
      // healthCheck must NEVER raise (contract).
      return {
        status: "degraded",
        reason: `unexpected error: ${String(err)}`,
        details,
      };
    }
  }
}
