/**
 * Cursor participant — reads Cursor's (the AI-first IDE) SQLite-backed
 * workspace/composer state and normalizes it into L5. Port of
 * `participants/cursor.py` + the extraction helper `participants/_cursor_sqlite.py`.
 *
 * Cursor stores workspace state in `state.vscdb` SQLite DBs at platform-specific
 * paths (`~/.config/Cursor/`, `~/Library/Application Support/Cursor/`,
 * `%APPDATA%/Cursor/`). This reader discovers those stores, reads the `ItemTable`
 * key/value rows read-only, parses the composer/chat records into sessions +
 * project/topic entities, and merges curated `.cursor/memory/short-index.json`
 * entities alongside them.
 *
 * SQLite access: the Python oracle copies each DB (+ its `-wal`/`-shm`
 * companions) to a tmp file and opens it read-write so SQLite folds the WAL into
 * a consistent snapshot. The TS mirror instead leans on {@link tryOpenReadonly}
 * (`mode=ro`), which respects SQLite locking and reads the `-wal` sidecar of a
 * live writer — the same consistent view without the copy. Read-only,
 * deterministic, visibility-enforced-before-emission, redaction on every native
 * string; `healthCheck` never throws.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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
import { tableExists, tryOpenReadonly } from "../sqlite-base.js";

const AGENT_ID = "cursor";
const AGENT_TYPE = "code-assistant";
const ROLE_NARRATIVE =
  "AI-first IDE. Bourdon reads the SQLite-backed composer/workspace " +
  "state to surface recent sessions and project entities to other agents.";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "credential", "secret"],
  team_tags: ["cursor", "workspace", "sqlite"],
});

const TOPIC_MIN_MENTIONS = 3;

// -- Defensive fs helpers -----------------------------------------------------

function homeDir(): string {
  try {
    return homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || ".";
  }
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

/** Redact credential-like content and cap length (redaction SSOT). */
function scrubText(value: string, limit = 256): string {
  return redactText(value, limit);
}

// -- Extraction data shapes ---------------------------------------------------

interface CursorSessionMemory {
  date: string;
  cwd: string;
  keyActions: string[];
  filesTouched: string[];
}

interface CursorEntityMemory {
  name: string;
  entityType: string;
  aliases: string[];
  summary: string;
  tags: string[];
  lastUpdated: string;
}

interface CursorSQLiteMemories {
  sessions: CursorSessionMemory[];
  entities: CursorEntityMemory[];
  databasesScanned: string[];
  malformedRecords: number;
}

// -- Path resolution ----------------------------------------------------------

/**
 * Platform-specific Cursor data dir (the SQLite workspace state lives here),
 * `$CURSOR_DIR` override first. Returns null on an unrecognized platform (or
 * Windows without `%APPDATA%`). Mirrors `default_cursor_dir`.
 */
export function defaultCursorDir(): string | null {
  const env = process.env.CURSOR_DIR;
  if (env) return env;
  switch (process.platform) {
    case "darwin":
      return join(homeDir(), "Library", "Application Support", "Cursor");
    case "linux":
      return join(homeDir(), ".config", "Cursor");
    case "win32": {
      const appdata = process.env.APPDATA;
      return appdata ? join(appdata, "Cursor") : null;
    }
    default:
      return null;
  }
}

/** Candidate `state.vscdb` paths under a Cursor data dir that actually exist. */
function iterStateDbs(root: string): string[] {
  const candidates: string[] = [
    join(root, "state.vscdb"),
    join(root, "User", "globalStorage", "state.vscdb"),
  ];
  const workspaceStorage = join(root, "User", "workspaceStorage");
  if (isDir(workspaceStorage)) {
    let children: string[] = [];
    try {
      children = readdirSync(workspaceStorage).sort();
    } catch {
      children = [];
    }
    for (const child of children) {
      candidates.push(join(workspaceStorage, child, "state.vscdb"));
    }
  }
  return candidates.filter((p) => isFile(p));
}

// -- SQLite ItemTable read (read-only) ----------------------------------------

/**
 * Read the `(key, value)` rows of the `ItemTable`, JSON-decoding each value.
 * Returns the decoded records plus a count of values that failed to parse.
 * Never raises — a locked/corrupt/unreadable DB degrades to "no rows".
 */
function readItemTable(dbPath: string): { records: Array<[string, unknown]>; malformed: number } {
  const records: Array<[string, unknown]> = [];
  let malformed = 0;

  const conn = tryOpenReadonly(dbPath);
  if (!conn) return { records, malformed };

  let rows: Array<{ key: unknown; value: unknown }>;
  try {
    if (!tableExists(conn, "ItemTable")) return { records, malformed };
    rows = conn.prepare("SELECT key, value FROM ItemTable").all() as Array<{
      key: unknown;
      value: unknown;
    }>;
  } catch {
    // Locked (Windows holds a write lock on a live DB), corrupt, or otherwise
    // unreadable — skip this DB, never crash the whole export. The caller still
    // records it as scanned.
    return { records, malformed };
  } finally {
    conn.close();
  }

  for (const row of rows) {
    const raw = row.value;
    let text: string | null = null;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof Uint8Array) text = Buffer.from(raw).toString("utf8");
    if (text === null) {
      malformed += 1;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      malformed += 1;
      continue;
    }
    records.push([String(row.key), value]);
  }
  return { records, malformed };
}

// -- Record parsing -----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function firstMessageText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (!isRecord(message)) continue;
    // Python uses `content or text` — fall back whenever content is falsy
    // (incl. ""), not just null/undefined. `||` matches; `??` would drop a
    // {content:"", text:"..."} record and silently lose the session.
    const content = message["content"] || message["text"];
    if (typeof content === "string" && content.trim()) return content.trim();
  }
  return "";
}

function looksLikeComposerRecord(key: string, value: unknown): boolean {
  const loweredKey = key.toLowerCase();
  if (loweredKey.includes("composer") || loweredKey.includes("aichat") || loweredKey.includes("chat")) {
    return true;
  }
  if (isRecord(value)) {
    const joinedKeys = Object.keys(value).join(" ").toLowerCase();
    return joinedKeys.includes("message") && (joinedKeys.includes("workspace") || joinedKeys.includes("file"));
  }
  return false;
}

/**
 * Parse a calendar date as written from an ISO-ish string (no tz conversion,
 * mirroring `datetime.fromisoformat(...).date()`) or an epoch number.
 */
function parseDate(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.replaceAll("Z", "+00:00");
    const m = /^(\d{4}-\d{2}-\d{2})([T ].*)?$/.exec(normalized);
    if (!m) return "";
    const datePart = m[1] ?? "";
    // Reject calendar-impossible days (e.g. 2024-02-30): Python's
    // `datetime.fromisoformat` raises on these, but `new Date` silently rolls
    // the month over. Round-trip the date and require it to survive unchanged.
    const dayProbe = new Date(`${datePart}T00:00:00Z`);
    if (Number.isNaN(dayProbe.getTime()) || dayProbe.toISOString().slice(0, 10) !== datePart) {
      return "";
    }
    // Validate the full value parses as a real datetime; take the date as written.
    const probe = new Date(m[2] ? normalized.replace(" ", "T") : `${datePart}T00:00:00`);
    if (Number.isNaN(probe.getTime())) return "";
    return datePart;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value > 10_000_000_000 ? value / 1000 : value;
    const dt = new Date(timestamp * 1000);
    if (Number.isNaN(dt.getTime())) return "";
    return dt.toISOString().slice(0, 10);
  }
  return "";
}

function dateFromRecord(value: Record<string, unknown>): string {
  for (const key of ["createdAt", "timestamp", "updatedAt", "lastUpdatedAt", "time"]) {
    const parsed = parseDate(value[key]);
    if (parsed) return parsed;
  }
  return new Date().toISOString().slice(0, 10);
}

function stringsFromList(values: unknown[]): string[] {
  const strings: string[] = [];
  for (const item of values) {
    if (typeof item === "string" && item.trim()) {
      strings.push(item.trim());
    } else if (isRecord(item)) {
      const path = firstString(item, ["path", "file", "uri", "relativePath"]);
      if (path) strings.push(path);
    }
  }
  return strings;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function extractFiles(value: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const key of ["files", "filePaths", "filesTouched", "references"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) files.push(...stringsFromList(candidate));
  }
  const messages = value["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (isRecord(message)) files.push(...extractFiles(message));
    }
  }
  return dedupe(files);
}

function recordToSession(key: string, value: unknown): CursorSessionMemory | null {
  if (!looksLikeComposerRecord(key, value)) return null;
  if (!isRecord(value)) return null;

  let cwd = firstString(value, ["workspacePath", "workspace", "cwd", "folder", "rootPath"]);
  if (!cwd && isRecord(value["workspace"])) {
    cwd = firstString(value["workspace"], ["path", "folder", "cwd"]);
  }
  if (!cwd) cwd = "";

  let action = firstString(value, ["title", "text", "prompt", "summary", "name"]);
  if (!action) action = firstMessageText(value["messages"]);
  if (!action) return null;

  return {
    date: dateFromRecord(value),
    cwd,
    keyActions: [scrubText(action)],
    filesTouched: extractFiles(value),
  };
}

function projectName(cwd: string): string {
  if (!cwd) return "";
  const name = basename(cwd).trim();
  return name && name !== "." && name !== "/" ? name : "";
}

// -- Topic-entity inference ---------------------------------------------------

const STRIP_CHARS = new Set([
  ".", ",", ";", ":", "!", "?", '"', "'", "`", "(", ")", "[", "]", "{", "}", "#", "-", "/",
]);

function stripChars(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && STRIP_CHARS.has(token[start]!)) start += 1;
  while (end > start && STRIP_CHARS.has(token[end - 1]!)) end -= 1;
  return token.slice(start, end);
}

const TOPIC_STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "have", "will",
  "are", "was", "been", "not", "but", "all", "can", "has", "its",
  "add", "use", "set", "get", "new", "fix", "run", "now", "also",
  "into", "make", "just", "like", "need", "want", "work", "code",
  "file", "test", "data", "type", "should", "would", "could",
]);

/** Extract recurring topic entities from session key_actions (in place). */
function addTopicEntities(
  sessions: CursorSessionMemory[],
  entities: Map<string, CursorEntityMemory>,
): void {
  const wordCounts = new Map<string, number>();
  const wordLatest = new Map<string, string>();

  for (const session of sessions) {
    for (const action of session.keyActions) {
      const words = new Set<string>();
      for (const token of action.toLowerCase().split(/\s+/)) {
        const cleaned = stripChars(token);
        if (cleaned.length >= 4 && !TOPIC_STOPWORDS.has(cleaned) && /^\p{L}+$/u.test(cleaned)) {
          words.add(cleaned);
        }
      }
      for (const word of words) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
        if (session.date) {
          const prev = wordLatest.get(word);
          if (prev === undefined || session.date > prev) wordLatest.set(word, session.date);
        }
      }
    }
  }

  for (const [word, count] of wordCounts) {
    if (count >= TOPIC_MIN_MENTIONS && !entities.has(word)) {
      entities.set(word, {
        name: word,
        entityType: "topic",
        aliases: [],
        summary: `Recurring topic across ${count} Cursor sessions.`,
        tags: ["cursor", "topic", "inferred"],
        lastUpdated: wordLatest.get(word) ?? "",
      });
    }
  }
}

// -- Top-level extraction -----------------------------------------------------

function extractCursorMemories(cursorDir: string | null = null): CursorSQLiteMemories {
  const root = cursorDir ?? defaultCursorDir();
  if (root === null || !isDir(root)) {
    return { sessions: [], entities: [], databasesScanned: [], malformedRecords: 0 };
  }

  const sessions: CursorSessionMemory[] = [];
  const entitiesByName = new Map<string, CursorEntityMemory>();
  const databasesScanned: string[] = [];
  let malformedRecords = 0;
  const projectLatest = new Map<string, string>();

  for (const dbPath of iterStateDbs(root)) {
    databasesScanned.push(dbPath);
    const { records, malformed } = readItemTable(dbPath);
    malformedRecords += malformed;
    for (const [key, value] of records) {
      const parsedSession = recordToSession(key, value);
      if (parsedSession === null) continue;
      sessions.push(parsedSession);

      const name = projectName(parsedSession.cwd);
      if (!name) continue;

      const prev = projectLatest.get(name) ?? "";
      if (!projectLatest.has(name) || (parsedSession.date && parsedSession.date > prev)) {
        projectLatest.set(name, parsedSession.date);
      }
      const existing = entitiesByName.get(name);
      const aliasSet = new Set<string>(parsedSession.cwd ? [parsedSession.cwd] : []);
      if (existing) {
        for (const a of existing.aliases) aliasSet.add(a);
      }
      entitiesByName.set(name, {
        name: scrubText(name, 120),
        entityType: "project",
        aliases: [...aliasSet].sort(),
        summary: scrubText(`Cursor workspace inferred from ${parsedSession.cwd}.`),
        tags: ["cursor", "workspace", "sqlite"],
        lastUpdated: projectLatest.get(name) ?? "",
      });
    }
  }

  addTopicEntities(sessions, entitiesByName);
  sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return {
    sessions,
    entities: [...entitiesByName.values()],
    databasesScanned,
    malformedRecords,
  };
}

// -- Short-index integration --------------------------------------------------

/** Read a short-index.json and return its normalized entry dicts. */
function readShortIndex(path: string): Array<Record<string, unknown>> {
  if (!isFile(path)) return [];
  let payload: unknown;
  try {
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, ""); // utf-8-sig: strip BOM
    payload = JSON.parse(raw);
  } catch {
    // Python logs a warning here; swallow + skip so a bad file never crashes export.
    return [];
  }
  if (!isRecord(payload)) return [];
  const entries = payload["entries"];
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (e): e is Record<string, unknown> => isRecord(e) && Boolean(e["topic_key"]),
  );
}

/** Merge workspace + global short-index files into Entity objects. */
function shortIndexToEntities(
  workspaceRoot: string | null,
  _cursorDir: string | null,
): EntityModel[] {
  const paths: string[] = [];
  if (workspaceRoot) {
    paths.push(join(workspaceRoot, ".cursor", "memory", "short-index.json"));
  }
  const cursorHome = process.env.CURSOR_DIR ? process.env.CURSOR_DIR : null;
  const homeBase = cursorHome ?? join(homeDir(), ".cursor");
  paths.push(join(homeBase, "memory", "short-index.json"));

  const merged = new Map<string, Record<string, unknown>>();
  for (const path of paths) {
    for (const entry of readShortIndex(path)) {
      const key = String(entry["topic_key"]).trim().toLowerCase();
      merged.set(key, entry);
    }
  }

  const entities: EntityModel[] = [];
  for (const entry of merged.values()) {
    const nameRaw =
      entry["topic_name"] !== undefined ? entry["topic_name"] : (entry["topic_key"] ?? "");
    const name = String(nameRaw).trim();
    if (!name) continue;

    const aliasesRaw =
      "triggers" in entry ? entry["triggers"] : "aliases" in entry ? entry["aliases"] : [];
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.map((a) => String(a).trim()).filter((s) => s.length > 0)
      : [];

    const summary = String(entry["summary"] ?? "").trim();

    const tagsRaw = entry["tags"] ?? [];
    const tags = Array.isArray(tagsRaw)
      ? tagsRaw.map((t) => String(t).trim()).filter((s) => s.length > 0)
      : [];
    tags.push("short-index");

    const access = String(entry["access_level"] ?? "team").trim().toLowerCase();
    const visibility =
      access === "private"
        ? Visibility.PRIVATE
        : access === "public"
          ? Visibility.PUBLIC
          : Visibility.TEAM;

    const lastTouched = String(entry["last_updated"] ?? "");

    entities.push(
      makeEntity({
        name,
        type: "topic",
        aliases,
        summary: summary || undefined,
        tags,
        last_touched: lastTouched || undefined,
        visibility,
      }),
    );
  }
  return entities;
}

// -- Conversion helpers -------------------------------------------------------

function toSession(raw: CursorSessionMemory): SessionModel {
  return makeSession({
    date: raw.date || "",
    cwd: raw.cwd || undefined,
    project_focus: [],
    key_actions: [...raw.keyActions],
    files_touched: [...raw.filesTouched],
  });
}

function toEntity(raw: CursorEntityMemory): EntityModel {
  return makeEntity({
    name: raw.name,
    type: raw.entityType || undefined,
    aliases: [...raw.aliases],
    summary: raw.summary || undefined,
    tags: [...raw.tags],
    last_touched: raw.lastUpdated || undefined,
  });
}

/** Current UTC time, seconds precision + `+00:00` (Python `isoformat(timespec="seconds")`). */
function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

// -- Participant --------------------------------------------------------------

/** External participant for Cursor's SQLite workspace state. */
export class CursorParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;

  private readonly cursorDir: string | null;
  private readonly workspaceRoot: string | null;
  private readonly policy: VisibilityPolicyModel = DEFAULT_POLICY;

  /**
   * Conventional Cursor config dir (`~/.cursor`) used by the setup wizard. The
   * wizard probes `~/.cursor` for presence; the SQLite workspace state that
   * `exportL5` actually reads lives at {@link defaultCursorDir}. Detection and
   * extraction intentionally use different anchors.
   */
  static defaultNativePath(home?: string): string {
    return join(home ?? homeDir(), ".cursor");
  }

  constructor(cursorDir?: string | null, workspaceRoot?: string | null) {
    this.cursorDir = cursorDir ?? null;
    this.workspaceRoot = workspaceRoot ?? null;
  }

  get nativePath(): string {
    const path = this.cursorDir ?? defaultCursorDir();
    return path ?? "";
  }

  discover(): AgentStore {
    const path = this.cursorDir ?? defaultCursorDir();
    if (path === null || !isDir(path)) {
      throw new ParticipantDiscoveryError(
        `Cursor data directory not found at ${path === null ? "None" : `'${path}'`}. ` +
          "Pass an explicit cursor_dir to CursorParticipant() if Cursor stores its " +
          "state somewhere non-standard.",
      );
    }
    const dbs = iterStateDbs(path);
    const dbDetails = dbs.map((db) => {
      let size: number;
      try {
        size = statSync(db).size;
      } catch {
        size = -1;
      }
      return { path: db, size_bytes: size };
    });

    return {
      path,
      version: "unknown",
      metadata: {
        platform_default: defaultCursorDir() ?? "None",
        databases_found: dbs.length,
        databases: dbDetails,
      },
    };
  }

  exportSessions(since?: Date, limit = 100): SessionModel[] {
    const memories = this.extract();
    const out: SessionModel[] = [];
    const sinceIso = since ? since.toISOString().slice(0, 10) : null;
    for (const raw of memories.sessions) {
      if (sinceIso && raw.date && raw.date < sinceIso) continue;
      out.push(toSession(raw));
      if (out.length >= limit) break;
    }
    return out;
  }

  exportL5(since?: Date): L5ManifestModel {
    const memories = this.extract();
    let sessions = memories.sessions.map(toSession);
    if (since) {
      const sinceIso = since.toISOString().slice(0, 10);
      sessions = sessions.filter((s) => !s.date || s.date >= sinceIso);
    }

    const entities = memories.entities.map(toEntity);
    const shortIndexEntities = shortIndexToEntities(this.workspaceRoot, this.cursorDir);
    const seenNames = new Set(entities.map((e) => e.name.toLowerCase()));
    for (const si of shortIndexEntities) {
      const key = si.name.toLowerCase();
      if (!seenNames.has(key)) {
        entities.push(si);
        seenNames.add(key);
      }
    }
    const visibleEntities = filterForFederation(entities, this.policy);

    return makeManifest({
      spec_version: SPEC_VERSION,
      agent: makeAgentInfo({
        id: AGENT_ID,
        type: AGENT_TYPE,
        role_narrative: ROLE_NARRATIVE,
        spec_version_compat: SPEC_VERSION,
      }),
      last_updated: nowIsoSeconds(),
      capabilities: ["composer-history", "workspace-state"],
      recent_sessions: sessions,
      known_entities: visibleEntities,
      visibility_policy: this.policy,
    });
  }

  healthCheck(): HealthStatus {
    const path = this.cursorDir ?? defaultCursorDir();
    if (path === null) {
      return {
        status: "blocked",
        reason: "Cursor data directory not resolvable on this platform.",
        details: {},
        proposedFix:
          "Install Cursor (https://cursor.sh) and open it once. " +
          "Set CURSOR_DIR if Cursor stores state outside the default location.",
      };
    }
    if (!isDir(path)) {
      return {
        status: "blocked",
        reason: `Cursor data directory not present at ${path}.`,
        details: { expected_path: path },
        proposedFix:
          "Install Cursor and open it once to create the data directory, " +
          "or set CURSOR_DIR to the actual location.",
      };
    }
    let memories: CursorSQLiteMemories;
    try {
      memories = this.extract();
    } catch (err) {
      // health check must not raise.
      return {
        status: "degraded",
        reason: "Cursor data directory present but extraction failed.",
        details: { error: String(err) },
        proposedFix:
          "Close Cursor (its SQLite stores may be locked) then re-run " +
          "`bourdon cursor export`. If extraction still fails, file an " +
          "issue with the error above.",
      };
    }
    if (memories.databasesScanned.length === 0) {
      return {
        status: "degraded",
        reason: "No Cursor SQLite stores found under the data directory.",
        details: { path },
        proposedFix:
          "Open Cursor and use it for at least one chat session, then " +
          "re-run `bourdon cursor export`.",
      };
    }
    return {
      status: "ok",
      details: {
        databases_scanned: memories.databasesScanned.length,
        sessions_extracted: memories.sessions.length,
        entities_extracted: memories.entities.length,
        malformed_records: memories.malformedRecords,
      },
    };
  }

  private extract(): CursorSQLiteMemories {
    return extractCursorMemories(this.cursorDir);
  }
}
