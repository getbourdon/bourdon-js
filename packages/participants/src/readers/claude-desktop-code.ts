/**
 * Claude Desktop · Code participant — the Claude desktop app's GUI "Claude Code"
 * surface. Port of `participants/claude_desktop_code.py` (+ the shared
 * `participants/_claude_desktop.py` helpers it needs).
 *
 * The desktop GUI's Claude Code keeps **metadata-only** state on disk — there is
 * no transcript. State files live at:
 *
 *     <desktop>/claude-code-sessions/<accountUUID>/<orgUUID>/local_<id>.json
 *
 * This participant emits **recognition metadata only** and routes every emitted
 * string through the shared redactor + a length cap (defense in depth): title,
 * cwd→project, model, effort, `enabledMcpTools` *count*, timestamps. It never
 * emits `planPath` contents or any free-form text beyond the redacted title.
 *
 * Distinct from the interactive-CLI {@link ClaudeCodeParticipant} and the richer
 * Co-Work surface. Convention: file/JSON reader (no SQLite, no network).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, parse as parsePath } from "node:path";

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

// -- Constants ----------------------------------------------------------------

const AGENT_ID = "claude-desktop-code";
const AGENT_TYPE = "code-assistant";
const DISPLAY_NAME = "Claude Desktop · Code";
const SURFACE_ENTITY_NAME = "Claude Desktop Code";
const ROLE_NARRATIVE =
  "Claude desktop app, GUI Claude Code. Bourdon reads the metadata-only " +
  "per-conversation local state to surface recognition metadata -- title, " +
  "project, model, effort, capability counts -- never conversation content " +
  "-- so desktop Claude Code work is visible to other agents.";

// Environment override (tests + non-standard installs). Takes precedence over
// the platform default but not over an explicit `home` argument.
const DESKTOP_DIR_ENV = "BOURDON_CLAUDE_DESKTOP_DIR";

// Sub-store directory name under the desktop dir.
const CODE_STORE = "claude-code-sessions";

// State filename prefix shared by both desktop stores (`local_<uuid>.json`).
const STATE_PREFIX = "local_";
const STATE_FILE_RE = /^local_.*\.json$/;

// Caps -- keep emitted metadata small and bounded.
const MAX_KEY_ACTION_CHARS = 280;
const MAX_PROJECTS = 6;
const MAX_KEY_ACTIONS = 6;

// Project-name hints, mirroring `_claude_desktop.PROJECT_HINTS`.
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

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "health", "family", "legal"],
  team_tags: ["claude-desktop", "claude-desktop-code", "agent-surface", "workspace"],
});

// -- fs helpers ---------------------------------------------------------------

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// -- Desktop-dir resolution (`_claude_desktop.default_claude_desktop_dir`) -----

function homeBase(home?: string): string {
  // Mirror Python's `home or Path.home()`. os.homedir() can throw under some
  // sandboxes; stay defensive so import + construction never crash.
  if (home !== undefined) return home;
  try {
    return homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || ".";
  }
}

/**
 * Resolve the Claude desktop application-support directory. Returns `null` only
 * on an unrecognized platform with no env override (callers treat that as
 * "blocked" rather than crashing).
 *
 * Precedence: `BOURDON_CLAUDE_DESKTOP_DIR` env → platform default anchored on
 * `home` (defaults to homedir).
 */
export function defaultClaudeDesktopDir(home?: string): string | null {
  const env = process.env[DESKTOP_DIR_ENV];
  if (env) return env;

  const base = homeBase(home);
  if (process.platform === "darwin") {
    return join(base, "Library", "Application Support", "Claude");
  }
  if (process.platform === "win32") {
    // When an explicit home is provided (tests), keep everything under it so the
    // fake tree is self-contained; otherwise honor %APPDATA%.
    if (home === undefined) {
      const appdata = process.env.APPDATA;
      if (appdata) return join(appdata, "Claude");
    }
    return join(base, "AppData", "Roaming", "Claude");
  }
  if (process.platform === "linux") {
    return join(base, ".config", "Claude");
  }
  return null;
}

// -- State-file globbing (`_claude_desktop.iter_state_files`) ------------------

/**
 * Return every `local_*.json` under `<store_dir>/<acct>/<org>/`, sorted by path.
 * Never raises when the store dir is absent (returns `[]`) so health checks can
 * distinguish "store missing" from "store empty".
 */
function iterStateFiles(storeDir: string): string[] {
  if (!isDir(storeDir)) return [];
  const out: string[] = [];
  let accts: string[];
  try {
    accts = readdirSync(storeDir);
  } catch {
    return out;
  }
  for (const acct of accts) {
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
      let names: string[];
      try {
        names = readdirSync(orgDir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith(STATE_PREFIX) && STATE_FILE_RE.test(name)) {
          out.push(join(orgDir, name));
        }
      }
    }
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/**
 * Read + parse one `local_*.json` state file. Returns the parsed object, or
 * `null` on any read/parse failure or if the top-level JSON is not an object.
 * Never raises — malformed files are counted and skipped by callers.
 */
function loadStateJson(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

// -- Scalar helpers -----------------------------------------------------------

/**
 * Convert an epoch timestamp to a UTC `YYYY-MM-DD` string. Accepts ms (`> 1e12`)
 * or seconds; ints, floats, and numeric strings are tolerated. Returns `""` on
 * anything unparseable (bools are rejected explicitly, as in Python).
 */
function epochToDate(value: unknown): string {
  if (typeof value === "boolean") return ""; // bool is an int subclass in Py — reject
  let num: number | null = null;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    num = Number.isNaN(parsed) ? null : parsed;
  }
  if (num === null || !Number.isFinite(num)) return "";
  const seconds = num > 1e12 ? num / 1000 : num;
  try {
    const d = new Date(seconds * 1000);
    const iso = d.toISOString();
    return iso.slice(0, 10);
  } catch {
    return "";
  }
}

/** Pick a session date from `createdAt` then `lastActivityAt`. */
function sessionDate(state: Record<string, unknown>): string {
  for (const key of ["createdAt", "lastActivityAt"] as const) {
    const parsed = epochToDate(state[key]);
    if (parsed) return parsed;
  }
  return "";
}

/**
 * Redact credential-like text + strip links, then cap to `limit` chars. Runs
 * through the redaction SSOT first so a planted secret becomes the sentinel
 * *before* truncation can split it. Mirrors `_safe_native_memory_text(v, limit)`.
 */
function bounded(value: string, limit: number = MAX_KEY_ACTION_CHARS): string {
  return redactText(value, limit);
}

/** Coerce a scalar to a bounded, redacted display string ("" if empty). */
function safeLabel(value: unknown, limit: number = MAX_KEY_ACTION_CHARS): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text) return "";
  return bounded(text, limit);
}

/**
 * Count `true` values in an `enabledMcpTools` mapping. Keys are
 * `"<serverUUID>:<tool>"` and are NOT emitted — only the count of enabled
 * entries is surfaced, so no tool names or server identifiers leak.
 */
function countEnabledMcpTools(enabled: unknown): number {
  if (typeof enabled !== "object" || enabled === null || Array.isArray(enabled)) return 0;
  let count = 0;
  for (const v of Object.values(enabled as Record<string, unknown>)) {
    if (v === true) count += 1;
  }
  return count;
}

function baseName(pathValue: unknown): string {
  if (typeof pathValue !== "string" || !pathValue.trim()) return "";
  const name = basename(pathValue.trim()).trim();
  return name && name !== "." && name !== "/" && name !== "\\" ? name : "";
}

/**
 * Infer project names from cwd + user-selected folders (basenames only), plus a
 * PROJECT_HINTS substring match. No file contents / no full paths — only
 * directory basenames and recognized labels. Order-preserving + de-duplicated.
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

  for (const rawPath of pathStrings) {
    const base = baseName(rawPath);
    if (base) add(base);
  }

  const haystack = pathStrings.join(" ").toLowerCase();
  for (const hint of PROJECT_HINTS) {
    if (haystack.includes(hint.toLowerCase())) add(hint);
  }

  return projects.slice(0, MAX_PROJECTS);
}

// -- Normalized conversation --------------------------------------------------

interface CodeConversation {
  convId: string;
  date: string;
  cwd: string;
  title: string;
  model: string;
  effort: string;
  permissionMode: string;
  isArchived: boolean;
  mcpToolCount: number;
  projects: string[];
}

function conversationFromState(
  statePath: string,
  state: Record<string, unknown>,
): CodeConversation {
  const sessionId = state["sessionId"];
  const stem = parsePath(statePath).name;
  return {
    convId: String(sessionId || stem),
    date: sessionDate(state),
    cwd: safeLabel(state["cwd"], 300),
    title: safeLabel(state["title"], 160) || "(untitled conversation)",
    model: safeLabel(state["model"], 80),
    effort: safeLabel(state["effort"], 40),
    permissionMode: safeLabel(state["permissionMode"], 40),
    isArchived: Boolean(state["isArchived"]),
    mcpToolCount: countEnabledMcpTools(state["enabledMcpTools"]),
    projects: inferProjects(state),
  };
}

function keyActions(conv: CodeConversation): string[] {
  const actions: string[] = [bounded(conv.title, 160)];
  if (conv.model) actions.push(bounded(`model: ${conv.model}`, 120));
  if (conv.effort) actions.push(bounded(`effort: ${conv.effort}`, 60));
  if (conv.permissionMode) actions.push(bounded(`permission: ${conv.permissionMode}`, 80));
  if (conv.mcpToolCount) actions.push(`mcp-tools: ${conv.mcpToolCount}`);
  return actions.slice(0, MAX_KEY_ACTIONS);
}

function sessionFromConversation(conv: CodeConversation): SessionModel {
  return makeSession({
    date: conv.date,
    cwd: conv.cwd || undefined,
    project_focus: [...conv.projects],
    key_actions: keyActions(conv),
    files_touched: [], // never list user files -- privacy
    visibility: Visibility.TEAM,
  });
}

function capabilities(convs: CodeConversation[]): string[] {
  let maxMcp = 0;
  for (const conv of convs) if (conv.mcpToolCount > maxMcp) maxMcp = conv.mcpToolCount;
  return [AGENT_ID, `mcp-tools:${maxMcp}`];
}

function entitiesFromConversations(convs: CodeConversation[]): EntityModel[] {
  let lastSeen: string | undefined;
  for (const conv of convs) {
    if (lastSeen === undefined || conv.date > lastSeen) lastSeen = conv.date;
  }

  const entities = new Map<string, EntityModel>();
  entities.set(
    SURFACE_ENTITY_NAME,
    makeEntity({
      name: SURFACE_ENTITY_NAME,
      type: "agent-surface",
      summary: bounded(
        "Claude desktop app GUI Claude Code surface (metadata-only federation).",
        260,
      ),
      last_touched: lastSeen,
      tags: ["claude-desktop", "claude-desktop-code", "agent-surface"],
      visibility: Visibility.TEAM,
    }),
  );
  for (const conv of convs) {
    for (const project of conv.projects) {
      if (!entities.has(project)) {
        entities.set(
          project,
          makeEntity({
            name: project,
            type: "project",
            summary: "Project inferred from a Claude Desktop Code conversation cwd.",
            last_touched: conv.date || undefined,
            tags: ["claude-desktop", "claude-desktop-code", "project"],
            visibility: Visibility.TEAM,
          }),
        );
      }
    }
  }
  return [...entities.values()];
}

// -- Participant --------------------------------------------------------------

/**
 * External participant for the Claude desktop app's GUI Claude Code surface.
 * File/JSON reader — metadata-only, no transcript, no SQLite, no network.
 */
export class ClaudeDesktopCodeParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  displayName = DISPLAY_NAME;

  private readonly storeDir: string;
  private readonly policy: VisibilityPolicyModel;

  /**
   * The Claude Code sub-store dir the setup wizard probes for presence. Resolves
   * to `<desktop>/claude-code-sessions`. Falls back to a non-existent sentinel
   * under `home` on an unrecognized platform so the wizard reports "not found".
   */
  static defaultNativePath(home?: string): string {
    const desktop = defaultClaudeDesktopDir(home);
    if (desktop === null) return join(homeBase(home), "Claude", CODE_STORE);
    return join(desktop, CODE_STORE);
  }

  constructor(storeDir?: string, home?: string) {
    this.storeDir = storeDir ?? ClaudeDesktopCodeParticipant.defaultNativePath(home);
    this.policy = DEFAULT_POLICY;
  }

  get nativePath(): string {
    return this.storeDir;
  }

  discover(): AgentStore {
    if (!isDir(this.storeDir)) {
      throw new ParticipantDiscoveryError(
        `Claude Desktop Code store not found at ${this.storeDir}.`,
      );
    }
    const stateFiles = iterStateFiles(this.storeDir);
    return {
      path: this.storeDir,
      version: "unknown",
      metadata: { conversations: stateFiles.length },
    };
  }

  exportSessions(since?: Date, limit = 100): SessionModel[] {
    const convs = this.conversations(since);
    const sessions = convs.map(sessionFromConversation);
    sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return sessions.slice(0, limit);
  }

  exportL5(since?: Date): L5ManifestModel {
    if (!isDir(this.storeDir)) {
      throw new ParticipantDiscoveryError(
        `Claude Desktop Code store not found at ${this.storeDir}.`,
      );
    }
    const convs = this.conversations(since);
    const sessions = convs.map(sessionFromConversation);
    sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const entities = entitiesFromConversations(convs);
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
      last_updated: new Date().toISOString(),
      capabilities: capabilities(convs),
      recent_sessions: sessions,
      known_entities: visibleEntities,
      visibility_policy: this.policy,
    });
  }

  healthCheck(): HealthStatus {
    if (!isDir(this.storeDir)) {
      return {
        status: "blocked",
        reason: `Claude Desktop Code store not found at ${this.storeDir}.`,
        details: { store_dir: this.storeDir },
        proposedFix:
          "Install the Claude desktop app and open a Claude Code conversation " +
          "once. Set BOURDON_CLAUDE_DESKTOP_DIR if the app stores state in a " +
          "non-standard location.",
      };
    }
    let stateFiles: string[];
    let convs: CodeConversation[];
    let malformed: number;
    try {
      stateFiles = iterStateFiles(this.storeDir);
      const collected = this.collectConversations();
      convs = collected.convs;
      malformed = collected.malformed;
    } catch (exc) {
      return {
        status: "degraded",
        reason: "Code store present but extraction failed.",
        details: { error: String(exc) },
        proposedFix:
          "Close the Claude desktop app (its state files may be locked) and " +
          "re-run `bourdon claude-desktop-code export`.",
      };
    }
    if (stateFiles.length === 0) {
      return {
        status: "degraded",
        reason: "No Claude Code conversations found under the store directory.",
        details: { store_dir: this.storeDir },
        proposedFix:
          "Open a Claude Code conversation in the Claude desktop app, then " +
          "re-run `bourdon claude-desktop-code export`.",
      };
    }
    return {
      status: "ok",
      details: {
        store_dir: this.storeDir,
        conversation_count: stateFiles.length,
        conversations_extracted: convs.length,
        malformed_records: malformed,
      },
    };
  }

  // -- Internal ---------------------------------------------------------------

  private collectConversations(): { convs: CodeConversation[]; malformed: number } {
    const convs: CodeConversation[] = [];
    let malformed = 0;
    for (const statePath of iterStateFiles(this.storeDir)) {
      const state = loadStateJson(statePath);
      if (state === null) {
        malformed += 1;
        continue;
      }
      convs.push(conversationFromState(statePath, state));
    }
    return { convs, malformed };
  }

  private conversations(since?: Date): CodeConversation[] {
    let { convs } = this.collectConversations();
    if (since !== undefined) {
      const cutoff = since.toISOString().slice(0, 10);
      convs = convs.filter((conv) => !conv.date || conv.date >= cutoff);
    }
    // Reverse tuple sort: (date, convId) descending.
    convs.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.convId !== b.convId) return a.convId < b.convId ? 1 : -1;
      return 0;
    });
    return convs;
  }
}
