/**
 * Claude Desktop · Co-Work participant — the richest of the two Claude-desktop
 * surfaces. Port of `participants/claude_desktop_cowork.py` (+ the shared
 * `participants/_claude_desktop.py` extraction helpers, inlined here).
 *
 * The desktop app stores each Co-Work / local-agent run as a state file plus a
 * sibling audit transcript:
 *
 *     <desktop>/local-agent-mode-sessions/<acct>/<org>/local_<id>.json   (state)
 *     <desktop>/local-agent-mode-sessions/<acct>/<org>/local_<id>/audit.jsonl
 *
 * This participant emits **recognition metadata only**. From the state file it
 * reads surface scalars (title, cwd, model, permission mode, timestamps,
 * `enabledMcpTools` *count*, `userSelectedFolders` *basenames*). From the
 * sibling `audit.jsonl` it reads ONLY the `system`/`init` capability *counts*
 * and the `result` safe scalars (cost, turns, error flag). It NEVER reads
 * conversation content. Every emitted string passes through the redaction SSOT
 * + a length cap, and TEAM entities are visibility-filtered before emission.
 *
 * Storage kind: file/convention (glob + JSON + JSONL), so this reads like the
 * claude-code / cascade file readers — no SQLite, no network.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, parse as parsePath } from "node:path";

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

// -- Constants -----------------------------------------------------------------

const AGENT_ID = "claude-desktop-cowork";
const AGENT_TYPE = "code-assistant";
const DISPLAY_NAME = "Claude Desktop · Co-Work";
const SURFACE_ENTITY_NAME = "Claude Desktop Co-Work";
const ROLE_NARRATIVE =
  "Claude desktop app, Co-Work / local-agent mode. Bourdon reads the " +
  "per-run local state and audit transcript to surface recognition metadata " +
  "-- title, project, model, turn/cost scalars, capability counts -- never " +
  "conversation content -- so Co-Work runs are visible to other agents.";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "health", "family", "legal"],
  team_tags: ["claude-desktop", "claude-desktop-cowork", "agent-surface", "workspace"],
});

// Environment override (tests + non-standard installs). Takes precedence over
// the platform default but not over an explicit `home` argument.
const DESKTOP_DIR_ENV = "BOURDON_CLAUDE_DESKTOP_DIR";

// Sub-store directory name under the desktop dir.
const COWORK_STORE = "local-agent-mode-sessions";

// State filename prefix (`local_<uuid>.json`).
const STATE_PREFIX = "local_";

const MAX_PROJECTS = 6;
const MAX_KEY_ACTIONS = 8;
// audit.jsonl can be large; only the (small) init + result lines are needed, so
// bound how much to scan before giving up.
const MAX_AUDIT_LINES = 50_000;

// Project-name hints, mirroring _claude_desktop.PROJECT_HINTS.
const PROJECT_HINTS: readonly string[] = [
  "ShipStable",
  "ILTT",
  "Prun",
  "PRUN",
  "OMNIvour",
  "Castmore",
  "Bourdon",
  "RADLAB",
  "CHIP",
  "Claude Brain",
  "Cursor",
  "Copilot",
  "Codex",
  "Cascade",
];

/** Minimal logger so a malformed-file warning is visible without a dep. */
const logger = {
  warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[bourdon.participants] ${msg}`);
  },
};

// -- fs helpers ----------------------------------------------------------------

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

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || ".";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Current UTC time at seconds precision + `+00:00` offset — mirrors Python's
 * `datetime.now(timezone.utc).isoformat(timespec="seconds")`. */
function isoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

// -- Desktop dir resolution ----------------------------------------------------

/**
 * Resolve the Claude desktop application-support directory.
 *
 * Precedence:
 *   1. `BOURDON_CLAUDE_DESKTOP_DIR` env var.
 *   2. Platform default, anchored on `home` (defaults to homedir):
 *        * macOS   -- `<home>/Library/Application Support/Claude`
 *        * Windows -- `%APPDATA%/Claude` (falls back to `<home>/AppData/Roaming/Claude`)
 *        * Linux   -- `<home>/.config/Claude`
 *
 * Returns `null` only on an unrecognized platform with no env override.
 */
function defaultClaudeDesktopDir(home?: string): string | null {
  const env = process.env[DESKTOP_DIR_ENV];
  if (env) return env;

  const base = home || homeDir();
  const plat = process.platform;
  if (plat === "darwin") {
    return join(base, "Library", "Application Support", "Claude");
  }
  if (plat.startsWith("win")) {
    // When an explicit home is provided (tests), keep everything under it;
    // otherwise honor %APPDATA%.
    if (home === undefined) {
      const appdata = process.env.APPDATA;
      if (appdata) return join(appdata, "Claude");
    }
    return join(base, "AppData", "Roaming", "Claude");
  }
  if (plat.startsWith("linux")) {
    return join(base, ".config", "Claude");
  }
  return null;
}

/**
 * Return every `local_*.json` under `<store_dir>/<acct>/<org>/`, globbing across
 * all account/org UUID directories. Returns `[]` (never throws) when the store
 * dir is absent so health checks can distinguish "missing" from "empty".
 */
function iterStateFiles(storeDir: string): string[] {
  if (!isDir(storeDir)) return [];
  const out: string[] = [];
  let accounts: string[];
  try {
    accounts = readdirSync(storeDir);
  } catch {
    return [];
  }
  for (const acct of accounts) {
    const acctDir = join(storeDir, acct);
    if (!isDir(acctDir)) continue;
    let orgs: string[];
    try {
      orgs = readdirSync(acctDir);
    } catch {
      continue;
    }
    for (const org of orgs) {
      const orgDir = join(acctDir, org);
      if (!isDir(orgDir)) continue;
      let entries: string[];
      try {
        entries = readdirSync(orgDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.startsWith(STATE_PREFIX) && name.endsWith(".json")) {
          out.push(join(orgDir, name));
        }
      }
    }
  }
  out.sort();
  return out;
}

/**
 * Read + parse one `local_*.json` state file. Returns the parsed object, or
 * `null` on any read/parse failure or if the top-level JSON is not an object.
 * Never throws -- malformed files are counted and skipped by callers.
 */
function loadStateJson(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (exc) {
    logger.warn(`claude-desktop: cannot read ${path}: ${String(exc)}`);
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (exc) {
    logger.warn(`claude-desktop: cannot parse ${path}: ${String(exc)}`);
    return null;
  }
  return isRecord(data) ? data : null;
}

// -- Scalar/date helpers -------------------------------------------------------

/**
 * Convert an epoch timestamp to a UTC `YYYY-MM-DD` string. Accepts ms (`> 1e12`)
 * or seconds; ints, floats, and numeric strings are tolerated. Returns `""` on
 * anything unparseable (bool is rejected explicitly).
 */
function epochToDate(value: unknown): string {
  if (typeof value === "boolean") return "";
  let num: number | null = null;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    num = Number.isNaN(n) ? null : n;
  }
  if (num === null || Number.isNaN(num)) return "";
  const seconds = num > 1e12 ? num / 1000 : num;
  try {
    const d = new Date(seconds * 1000);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

/** Pick a session date from `createdAt` then `lastActivityAt`. */
function sessionDate(state: Record<string, unknown>): string {
  for (const key of ["createdAt", "lastActivityAt"]) {
    const parsed = epochToDate(state[key]);
    if (parsed) return parsed;
  }
  return "";
}

/** Redact credential-like text + strip links, then cap to `limit` chars. */
function bounded(value: string, limit = 280): string {
  return redactText(value, limit);
}

/** Coerce a scalar to a bounded, redacted display string ("" if empty). */
function safeLabel(value: unknown, limit = 280): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text) return "";
  return bounded(text, limit);
}

/**
 * Count `true` values in an `enabledMcpTools` mapping. Keys are
 * `"<serverUUID>:<tool>"` and are NOT emitted -- only the count leaks.
 */
function countEnabledMcpTools(enabled: unknown): number {
  if (!isRecord(enabled)) return 0;
  let n = 0;
  for (const v of Object.values(enabled)) {
    if (v === true) n += 1;
  }
  return n;
}

function basenameOf(pathValue: unknown): string {
  if (typeof pathValue !== "string" || !pathValue.trim()) return "";
  const name = basename(pathValue.trim()).trim();
  return name && name !== "." && name !== "/" && name !== "\\" ? name : "";
}

/**
 * Infer project names from cwd + user-selected folders (basenames only), plus a
 * `PROJECT_HINTS` substring match. Order-preserving + case-insensitively deduped.
 * No file contents and no full paths are emitted.
 */
function inferProjects(state: Record<string, unknown>): string[] {
  const projects: string[] = [];
  const seen = new Set<string>();

  const add = (name: string): void => {
    const cleaned = name.trim();
    if (cleaned && !seen.has(cleaned.toLowerCase())) {
      projects.push(cleaned);
      seen.add(cleaned.toLowerCase());
    }
  };

  const pathStrings: string[] = [];
  const cwd = state["cwd"];
  if (typeof cwd === "string" && cwd.trim()) pathStrings.push(cwd);
  const folders = state["userSelectedFolders"];
  if (Array.isArray(folders)) {
    for (const f of folders) {
      if (typeof f === "string" && f.trim()) pathStrings.push(f);
    }
  }

  for (const raw of pathStrings) {
    const base = basenameOf(raw);
    if (base) add(base);
  }

  const haystack = pathStrings.join(" ").toLowerCase();
  for (const hint of PROJECT_HINTS) {
    if (haystack.includes(hint.toLowerCase())) add(hint);
  }

  return projects.slice(0, MAX_PROJECTS);
}

// -- audit.jsonl safe-scalar extraction ----------------------------------------

/** Sibling transcript dir: `local_<id>.json` -> `local_<id>/`. */
function runDirFor(statePath: string): string {
  return join(dirname(statePath), parsePath(statePath).name);
}

/**
 * Pull safe scalars from one audit record into `out` (in place). Only the
 * `system`/`init` and `result` record types contribute; every other record
 * (user/assistant/etc.) is ignored -- their bodies are never touched.
 */
function absorbAuditRecord(record: Record<string, unknown>, out: Record<string, unknown>): void {
  const recType = record["type"];
  const subtype = record["subtype"];

  if (recType === "system" && subtype === "init") {
    // Counts only -- never the tool/skill/command names themselves.
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["tools", "init_tools"],
      ["mcp_servers", "init_mcp_servers"],
      ["skills", "init_skills"],
      ["plugins", "init_plugins"],
      ["slash_commands", "init_slash_commands"],
    ];
    for (const [srcKey, dstKey] of pairs) {
      const value = record[srcKey];
      if (Array.isArray(value)) out[dstKey] = value.length;
    }
    const version = record["claude_code_version"];
    if (version !== null && version !== undefined) {
      out["claude_code_version"] = safeLabel(version, 40);
    }
    return;
  }

  if (recType === "result") {
    // The `result` *text* field (free-form summary) is deliberately NOT read.
    for (const key of ["total_cost_usd", "num_turns", "is_error", "duration_ms"]) {
      if (key in record) out[key] = record[key];
    }
    const stopReason = record["stop_reason"];
    if (stopReason !== null && stopReason !== undefined) {
      out["stop_reason"] = safeLabel(stopReason, 40);
    }
  }
}

/**
 * Extract ONLY the safe scalars from a Co-Work `audit.jsonl` transcript. Reads
 * line-by-line, tolerantly. A missing, unreadable, or locked file yields an
 * empty object -- never an error. NEVER reads user/assistant message bodies.
 */
function readAuditScalars(runDir: string): Record<string, unknown> {
  const auditPath = join(runDir, "audit.jsonl");
  if (!isFile(auditPath)) return {};

  const out: Record<string, unknown> = {};
  let raw: string;
  try {
    raw = readFileSync(auditPath, "utf8");
  } catch (exc) {
    logger.warn(`claude-desktop: cannot read ${auditPath}: ${String(exc)}`);
    return out;
  }

  let lineNo = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    if (lineNo >= MAX_AUDIT_LINES) break;
    lineNo += 1;
    const line = rawLine.trim();
    if (!line || line[0] !== "{") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    absorbAuditRecord(record, out);
  }
  return out;
}

// -- Run model -----------------------------------------------------------------

/** Normalized, privacy-redacted view of a single Co-Work run. */
interface CoworkRun {
  runId: string;
  date: string;
  cwd: string;
  title: string;
  model: string;
  permissionMode: string;
  isArchived: boolean;
  mcpToolCount: number;
  projects: string[];
  numTurns: number | null;
  totalCostUsd: number | null;
  isError: boolean | null;
  initCounts: Record<string, number>;
}

function runFromState(statePath: string, state: Record<string, unknown>): CoworkRun {
  const audit = readAuditScalars(runDirFor(statePath));

  const title = safeLabel(state["title"], 160) || "(untitled run)";
  const model = safeLabel(state["model"], 80);
  const permissionMode = safeLabel(state["permissionMode"], 40);

  const numTurnsRaw = audit["num_turns"];
  const costRaw = audit["total_cost_usd"];
  const isErrorRaw = audit["is_error"];

  const initCounts: Record<string, number> = {};
  for (const [k, v] of Object.entries(audit)) {
    if (k.startsWith("init_") && typeof v === "number" && Number.isInteger(v)) {
      initCounts[k] = v;
    }
  }

  const stem = parsePath(statePath).name;
  const sid = state["sessionId"];

  return {
    runId: String(sid || stem),
    date: sessionDate(state),
    cwd: safeLabel(state["cwd"], 300),
    title,
    model,
    permissionMode,
    isArchived: Boolean(state["isArchived"]),
    mcpToolCount: countEnabledMcpTools(state["enabledMcpTools"]),
    projects: inferProjects(state),
    numTurns: typeof numTurnsRaw === "number" && Number.isInteger(numTurnsRaw) ? numTurnsRaw : null,
    totalCostUsd: typeof costRaw === "number" ? costRaw : null,
    isError: typeof isErrorRaw === "boolean" ? isErrorRaw : null,
    initCounts,
  };
}

/**
 * Build the bounded, redacted key-action list for a run:
 * `[title, "model: ...", "permission: ...", "<n> turns", "$<cost>", "error",
 * "mcp-tools: <n>"]` -- all metadata, never content.
 */
function keyActions(run: CoworkRun): string[] {
  const actions: string[] = [bounded(run.title, 160)];
  if (run.model) actions.push(bounded(`model: ${run.model}`, 120));
  if (run.permissionMode) actions.push(bounded(`permission: ${run.permissionMode}`, 80));
  if (run.numTurns !== null) actions.push(`${run.numTurns} turns`);
  if (run.totalCostUsd !== null) actions.push(`$${run.totalCostUsd.toFixed(2)}`);
  if (run.isError) actions.push("error");
  if (run.mcpToolCount) actions.push(`mcp-tools: ${run.mcpToolCount}`);
  return actions.slice(0, MAX_KEY_ACTIONS);
}

function sessionFromRun(run: CoworkRun): SessionModel {
  return makeSession({
    date: run.date,
    cwd: run.cwd || undefined, // run.cwd or None -- privacy: never empty string
    project_focus: [...run.projects],
    key_actions: keyActions(run),
    files_touched: [], // never list user files -- privacy
    visibility: Visibility.TEAM,
  });
}

/** Manifest-level capability *counts* only (no names). */
function capabilities(runs: CoworkRun[]): string[] {
  const caps: string[] = [AGENT_ID];
  const maxMcp = runs.length ? Math.max(...runs.map((r) => r.mcpToolCount)) : 0;
  caps.push(`mcp-tools:${maxMcp}`);
  const bestTools = runs.length ? Math.max(...runs.map((r) => r.initCounts["init_tools"] ?? 0)) : 0;
  if (bestTools) caps.push(`tools:${bestTools}`);
  const bestSkills = runs.length
    ? Math.max(...runs.map((r) => r.initCounts["init_skills"] ?? 0))
    : 0;
  if (bestSkills) caps.push(`skills:${bestSkills}`);
  return caps;
}

function entitiesFromRuns(runs: CoworkRun[]): EntityModel[] {
  const lastSeen = runs.length
    ? runs.map((r) => r.date).reduce((a, b) => (a > b ? a : b))
    : null;

  const entities = new Map<string, EntityModel>();
  entities.set(
    SURFACE_ENTITY_NAME,
    makeEntity({
      name: SURFACE_ENTITY_NAME,
      type: "agent-surface",
      summary: bounded(
        "Claude desktop app Co-Work / local-agent mode surface " +
          "(metadata-only federation).",
        260,
      ),
      last_touched: lastSeen,
      tags: ["claude-desktop", "claude-desktop-cowork", "agent-surface"],
      visibility: Visibility.TEAM,
    }),
  );

  for (const run of runs) {
    for (const project of run.projects) {
      if (!entities.has(project)) {
        entities.set(
          project,
          makeEntity({
            name: project,
            type: "project",
            summary: "Project inferred from a Claude Desktop Co-Work run cwd.",
            last_touched: run.date || undefined, // run.date or None
            tags: ["claude-desktop", "claude-desktop-cowork", "project"],
            visibility: Visibility.TEAM,
          }),
        );
      }
    }
  }

  return [...entities.values()];
}

// -- Participant ---------------------------------------------------------------

/** External participant for the Claude desktop app's Co-Work surface. */
export class ClaudeDesktopCoworkParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  displayName = DISPLAY_NAME;

  private readonly storeDir: string;
  private readonly policy: VisibilityPolicyModel;

  /**
   * The Co-Work sub-store dir the setup wizard probes for presence. Resolves to
   * `<desktop>/local-agent-mode-sessions`. When the desktop dir cannot be
   * resolved on this platform, falls back to a non-existent sentinel under
   * `home` so the wizard reports "not found" rather than crashing.
   */
  static defaultNativePath(home?: string): string {
    const desktop = defaultClaudeDesktopDir(home);
    if (desktop === null) return join(home || homeDir(), "Claude", COWORK_STORE);
    return join(desktop, COWORK_STORE);
  }

  constructor(storeDir?: string, home?: string) {
    this.storeDir = storeDir || ClaudeDesktopCoworkParticipant.defaultNativePath(home);
    this.policy = DEFAULT_POLICY;
  }

  get nativePath(): string {
    return this.storeDir;
  }

  // -- Protocol surface --------------------------------------------------------

  discover(): AgentStore {
    if (!isDir(this.storeDir)) {
      throw new ParticipantDiscoveryError(
        `Claude Desktop Co-Work store not found at ${this.storeDir}.`,
      );
    }
    const stateFiles = iterStateFiles(this.storeDir);
    return {
      path: this.storeDir,
      version: "unknown",
      metadata: { runs: stateFiles.length },
    };
  }

  exportSessions(since?: Date, limit = 100): SessionModel[] {
    const runs = this.runs(since);
    const sessions = runs.map(sessionFromRun);
    sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return sessions.slice(0, limit);
  }

  exportL5(since?: Date): L5ManifestModel {
    if (!isDir(this.storeDir)) {
      throw new ParticipantDiscoveryError(
        `Claude Desktop Co-Work store not found at ${this.storeDir}.`,
      );
    }
    const runs = this.runs(since);
    const sessions = runs.map(sessionFromRun);
    sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const entities = entitiesFromRuns(runs);
    const visibleEntities = filterForFederation(entities, this.policy);

    return makeManifest({
      spec_version: SPEC_VERSION,
      agent: makeAgentInfo({
        id: AGENT_ID,
        type: AGENT_TYPE,
        instance: hostname(),
        spec_version_compat: SPEC_VERSION,
        role_narrative: ROLE_NARRATIVE,
      }),
      last_updated: isoSeconds(),
      capabilities: capabilities(runs),
      recent_sessions: sessions,
      known_entities: visibleEntities,
      visibility_policy: this.policy,
    });
  }

  healthCheck(): HealthStatus {
    if (!isDir(this.storeDir)) {
      return {
        status: "blocked",
        reason: `Claude Desktop Co-Work store not found at ${this.storeDir}.`,
        details: { store_dir: this.storeDir },
        proposedFix:
          "Install the Claude desktop app and run a Co-Work / local-agent " +
          "session once. Set BOURDON_CLAUDE_DESKTOP_DIR if the app stores " +
          "state in a non-standard location.",
      };
    }

    let stateFiles: string[];
    let runs: CoworkRun[];
    let malformed: number;
    try {
      stateFiles = iterStateFiles(this.storeDir);
      [runs, malformed] = this.collectRuns();
    } catch (exc) {
      logger.warn(`ClaudeDesktopCoworkParticipant health_check failed: ${String(exc)}`);
      return {
        status: "degraded",
        reason: "Co-Work store present but extraction failed.",
        details: { error: String(exc) },
        proposedFix:
          "Close the Claude desktop app (its state files may be locked) and " +
          "re-run `bourdon claude-desktop-cowork export`.",
      };
    }

    if (stateFiles.length === 0) {
      return {
        status: "degraded",
        reason: "No Co-Work runs found under the store directory.",
        details: { store_dir: this.storeDir },
        proposedFix:
          "Run a Co-Work / local-agent session in the Claude desktop app, " +
          "then re-run `bourdon claude-desktop-cowork export`.",
      };
    }

    return {
      status: "ok",
      details: {
        store_dir: this.storeDir,
        run_count: stateFiles.length,
        runs_extracted: runs.length,
        malformed_records: malformed,
        runs_with_scalars: runs.filter((r) => r.numTurns !== null).length,
      },
    };
  }

  // -- Internal ----------------------------------------------------------------

  private collectRuns(): [CoworkRun[], number] {
    const runs: CoworkRun[] = [];
    let malformed = 0;
    for (const statePath of iterStateFiles(this.storeDir)) {
      const state = loadStateJson(statePath);
      if (state === null) {
        malformed += 1;
        continue;
      }
      runs.push(runFromState(statePath, state));
    }
    return [runs, malformed];
  }

  private runs(since?: Date): CoworkRun[] {
    const [runs] = this.collectRuns();
    let filtered = runs;
    if (since !== undefined) {
      const cutoff = new Date(since.getTime()).toISOString().slice(0, 10);
      filtered = runs.filter((run) => !run.date || run.date >= cutoff);
    }
    filtered.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.runId !== b.runId) return a.runId < b.runId ? 1 : -1;
      return 0;
    });
    return filtered;
  }
}
