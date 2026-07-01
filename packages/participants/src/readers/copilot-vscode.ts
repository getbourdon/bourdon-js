/**
 * GitHub Copilot · VS Code participant — reads the GUI Copilot Chat extension's
 * per-workspace transcripts + repo-scoped memory. Port of
 * `participants/copilot_vscode.py`.
 *
 * VS Code's Copilot Chat extension stores per-workspace data at
 * `<workspaceStorage>/<hash>/GitHub.copilot-chat/`:
 *   - `transcripts/<session-uuid>.jsonl` — event stream per chat session
 *   - `memory-tool/memories/**\/*.md`    — per-repo memory (markdown bullets)
 *
 * This is a FILE/CONVENTION reader (not SQLite, not network): it walks the
 * workspaceStorage tree read-only, parses JSONL transcripts + markdown memory
 * files, aggregates across every workspace hash, redacts every native string,
 * applies the visibility filter BEFORE emission, and is deterministic.
 * `healthCheck` never throws.
 *
 * Distinct from:
 *   - `copilot`        (convention-file at `~/.copilot-bourdon/memory.md`)
 *   - `copilot-cli`    (terminal agent, `~/.copilot/session-store.db`, SQLite)
 *   - `github-copilot` (network reader — GitHub-embedded Copilot)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join, relative } from "node:path";

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

const AGENT_ID = "copilot-vscode";
const AGENT_TYPE = "code-assistant";
const DISPLAY_NAME = "GitHub Copilot · VS Code";
const ROLE_NARRATIVE =
  "VS Code integrated Copilot Chat — the GUI surface for inline completion, " +
  "chat, plan mode, ask mode, and explore mode. Persists per-workspace " +
  "transcripts and repo-scoped memory locally. The most widely-used Copilot " +
  "surface by session count.";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "health", "family", "legal"],
  team_tags: ["copilot-vscode", "copilot", "vscode", "workspace"],
});

const COPILOT_CHAT_EXT = "GitHub.copilot-chat";
const TRANSCRIPTS_DIR = "transcripts";
const MEMORY_TOOL_DIR = "memory-tool";
const MAX_KEY_ACTIONS = 6;
const MAX_KEY_ACTION_CHARS = 280;
const MAX_SUMMARY_CHARS = 260;
const MAX_TRANSCRIPT_EVENTS = 500; // cap per file to avoid loading multi-MB transcripts fully

// -- fs helpers ---------------------------------------------------------------

function homeDir(): string {
  // os.homedir() can throw under some sandboxes; stay defensive so import +
  // construction never crash even when HOME points at an unreadable path.
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

/** Redact secrets + clamp to the native-memory limit (`_safe_native_memory_text`). */
function safeNativeMemoryText(value: string, limit = 180): string {
  return redactText(value, limit);
}

/**
 * Collapse whitespace and clamp with a single-char ellipsis (mirrors the
 * oracle's `_bounded`). Distinct from {@link redactText}'s `...` clamp — this
 * one uses `…` (U+2026) and does no redaction.
 */
function bounded(value: string, limit: number): string {
  const normalized = value.split(/\s+/).filter(Boolean).join(" ");
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, limit - 1).replace(/\s+$/, "") + "…";
}

/** Python `str.splitlines()` — split on \r\n, \r, or \n. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

// -- Path resolution ----------------------------------------------------------

/**
 * Return the VS Code workspaceStorage path for this platform, or null when it
 * cannot be resolved (Windows without `%APPDATA%`). Respects the
 * `COPILOT_VSCODE_STORAGE` environment-variable override. Mirrors
 * `default_vscode_workspace_storage_dir`.
 */
export function defaultVscodeWorkspaceStorageDir(): string | null {
  const env = process.env.COPILOT_VSCODE_STORAGE;
  if (env) return env;

  // Map Node's os.platform() onto Python's platform.system().
  const system = platform();
  if (system === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) return join(appdata, "Code", "User", "workspaceStorage");
    return null;
  }
  if (system === "darwin") {
    return join(
      homeDir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "workspaceStorage",
    );
  }
  // Linux / WSL — check the Windows path under /mnt/c if WSL, else native.
  const wslPath = "/mnt/c/Users";
  if (isDir(wslPath)) {
    try {
      for (const candidate of readdirSync(wslPath)) {
        try {
          const ws = join(
            wslPath,
            candidate,
            "AppData",
            "Roaming",
            "Code",
            "User",
            "workspaceStorage",
          );
          if (isDir(ws)) return ws;
        } catch {
          continue;
        }
      }
    } catch {
      // fall through to native Linux
    }
  }
  const config = process.env.XDG_CONFIG_HOME || join(homeDir(), ".config");
  return join(config, "Code", "User", "workspaceStorage");
}

/** Find all workspace hashes that contain Copilot Chat data. */
function findCopilotChatDirs(workspaceStorage: string): string[] {
  if (!isDir(workspaceStorage)) return [];
  const dirs: string[] = [];
  try {
    for (const wsHash of readdirSync(workspaceStorage)) {
      const chatDir = join(workspaceStorage, wsHash, COPILOT_CHAT_EXT);
      if (isDir(chatDir)) dirs.push(chatDir);
    }
  } catch (exc) {
    logger.warn(`CopilotVscodeParticipant: cannot scan workspace storage: ${String(exc)}`);
  }
  return dirs;
}

/** Minimal logger so a scan warning is visible without a dep. */
const logger = {
  warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[bourdon.participants] ${msg}`);
  },
};

// -- Transcript parsing -------------------------------------------------------

interface TranscriptInfo {
  transcript_path: string;
  session_id: string;
  start_time: string | null;
  producer: unknown;
  copilot_version: unknown;
  vscode_version: unknown;
  user_messages: string[];
  turn_count: number;
}

/**
 * Parse a JSONL transcript file into a session summary. Returns null on any
 * read/empty error. Never raises.
 */
function parseTranscript(path: string): TranscriptInfo | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const lines = text.trim() ? splitLines(text.trim()) : [];
  if (lines.length === 0) return null;

  const info: TranscriptInfo = {
    transcript_path: path,
    session_id: stem(path),
    start_time: null,
    producer: null,
    copilot_version: null,
    vscode_version: null,
    user_messages: [],
    turn_count: 0,
  };

  let turnCount = 0;
  const userMsgs: string[] = [];

  for (const line of lines.slice(0, MAX_TRANSCRIPT_EVENTS)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const ev = event as Record<string, unknown>;
    const eventType = ev["type"];
    const dataRaw = ev["data"];
    const data =
      typeof dataRaw === "object" && dataRaw !== null
        ? (dataRaw as Record<string, unknown>)
        : {};

    if (eventType === "session.start") {
      info.start_time = data["startTime"] == null ? null : String(data["startTime"]);
      info.producer = data["producer"] ?? null;
      info.copilot_version = data["copilotVersion"] ?? null;
      info.vscode_version = data["vscodeVersion"] ?? null;
    } else if (eventType === "user.message") {
      const content = data["content"] ? String(data["content"]) : "";
      if (content) {
        // Truncate long messages but keep enough for entity extraction.
        userMsgs.push(content.slice(0, 200));
      }
    } else if (eventType === "assistant.turn_end") {
      turnCount += 1;
    }
  }

  info.user_messages = userMsgs.slice(0, 20);
  info.turn_count = turnCount;
  return info;
}

/** Basename minus final extension (Python `Path.stem`). */
function stem(p: string): string {
  const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

// -- Memory-tool parsing ------------------------------------------------------

interface MemoryFile {
  name: string;
  content: string;
  path: string;
  bullet_count: number;
}

/** Recursively collect `*.md` files under `dir`, sorted for determinism. */
function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (isDir(full)) {
      out.push(...walkMarkdown(full));
    } else if (name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Parse memory-tool markdown files from a Copilot Chat workspace. Each file is a
 * bulleted list of learned facts. Returns a list of {name, content, path, ...}.
 */
function parseMemoryFiles(chatDir: string): MemoryFile[] {
  const memoryDir = join(chatDir, MEMORY_TOOL_DIR, "memories");
  if (!isDir(memoryDir)) return [];

  const memories: MemoryFile[] = [];
  for (const mdFile of walkMarkdown(memoryDir)) {
    let text: string;
    try {
      text = readFileSync(mdFile, "utf8");
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    // Name from relative path (e.g. "repo/mobile-scaffold"), suffix stripped,
    // backslashes normalized to forward slashes.
    const rel = relative(memoryDir, mdFile);
    const name = rel.replace(/\.[^./\\]*$/, "").replace(/\\/g, "/");
    const bulletCount = text.split("\n- ").length - 1 + (text.startsWith("- ") ? 1 : 0);
    memories.push({ name, content: text, path: mdFile, bullet_count: bulletCount });
  }
  return memories;
}

// -- Conversion to Bourdon types ----------------------------------------------

function sessionFromTranscript(info: TranscriptInfo): SessionModel {
  const start = info.start_time ?? "";
  const dateStr = start ? start.slice(0, 10) : "";

  const keyActions: string[] = [];
  const msgs = info.user_messages ?? [];
  if (msgs.length > 0) {
    keyActions.push(bounded(safeNativeMemoryText(String(msgs[0])), MAX_KEY_ACTION_CHARS));
  }
  if (info.turn_count) keyActions.push(`turns: ${info.turn_count}`);
  if (info.copilot_version) keyActions.push(`copilot: ${String(info.copilot_version)}`);
  if (info.producer) keyActions.push(`mode: ${String(info.producer)}`);

  return makeSession({
    date: dateStr,
    cwd: undefined,
    project_focus: [],
    key_actions: keyActions.slice(0, MAX_KEY_ACTIONS),
    files_touched: [],
    visibility: Visibility.TEAM,
  });
}

function entitiesFromMemories(memories: MemoryFile[]): EntityModel[] {
  const entities: EntityModel[] = [];
  for (const mem of memories) {
    const bullets: string[] = [];
    for (const line of splitLines(mem.content)) {
      const stripped = line.trim();
      if (stripped.startsWith("- ")) {
        bullets.push(stripped.slice(2).trim());
        if (bullets.length === 3) break;
      }
    }
    let summary: string | undefined =
      bullets.length > 0 ? bullets.join("; ") : undefined;
    if (summary) summary = bounded(safeNativeMemoryText(summary), MAX_SUMMARY_CHARS);

    entities.push(
      makeEntity({
        name: mem.name,
        type: "vscode-memory",
        summary,
        last_touched: undefined,
        tags: ["copilot-vscode", "memory-tool", "repo-memory"],
        visibility: Visibility.TEAM,
      }),
    );
  }
  return entities;
}

function entitiesFromTranscripts(transcripts: TranscriptInfo[]): EntityModel[] {
  // Simple frequency-based extraction from first messages (insertion-ordered).
  const topicCounts = new Map<string, number>();
  for (const info of transcripts) {
    const msgs = info.user_messages ?? [];
    if (msgs.length > 0) {
      const first = String(msgs[0]).slice(0, 100);
      const slashMatch = /^\/(\S+)/.exec(first);
      if (slashMatch) {
        const topic = `copilot-command:${slashMatch[1]}`;
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
      }
    }
  }

  // sorted(items, key=lambda x: -x[1])[:10] — stable, so ties keep insertion order.
  const ordered = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const entities: EntityModel[] = [];
  for (const [topic, count] of ordered) {
    entities.push(
      makeEntity({
        name: topic,
        type: "vscode-capability",
        summary: `VS Code Copilot command used ${count} time(s).`,
        tags: ["copilot-vscode", "capability"],
        visibility: Visibility.TEAM,
      }),
    );
  }
  return entities;
}

// -- Participant --------------------------------------------------------------

/**
 * External participant for GitHub Copilot in VS Code. Reads transcripts and
 * memory-tool files from VS Code's workspaceStorage read-only, aggregating
 * across all workspace hashes.
 */
export class CopilotVscodeParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  displayName = DISPLAY_NAME;

  private readonly workspaceStorage: string | null;

  /** The workspaceStorage dir the setup wizard probes for presence. */
  static defaultNativePath(home?: string): string {
    if (home !== undefined) {
      return join(home, ".config", "Code", "User", "workspaceStorage");
    }
    let ws: string | null;
    try {
      ws = defaultVscodeWorkspaceStorageDir();
    } catch {
      ws = null;
    }
    if (ws !== null) return ws;
    return join(homeDir(), ".config", "Code", "User", "workspaceStorage");
  }

  constructor(workspaceStorage?: string) {
    this.workspaceStorage = workspaceStorage ?? null;
  }

  get nativePath(): string {
    return this.workspaceStorage ?? defaultVscodeWorkspaceStorageDir() ?? "";
  }

  private resolveWs(): string | null {
    return this.workspaceStorage ?? defaultVscodeWorkspaceStorageDir();
  }

  // -- Protocol surface -------------------------------------------------------

  discover(): AgentStore {
    const ws = this.resolveWs();
    if (ws === null || !isDir(ws)) {
      throw new ParticipantDiscoveryError(
        `VS Code workspaceStorage not found at ${ws ?? "None"}. ` +
          "Install VS Code with the GitHub Copilot Chat extension.",
      );
    }
    const chatDirs = findCopilotChatDirs(ws);
    if (chatDirs.length === 0) {
      throw new ParticipantDiscoveryError(
        `No GitHub.copilot-chat data found under ${ws}. ` +
          "Open VS Code and use Copilot Chat at least once.",
      );
    }
    return {
      path: ws,
      version: "transcript-v1",
      metadata: {
        workspace_count: chatDirs.length,
        workspace_storage_path: ws,
      },
    };
  }

  exportSessions(since?: Date, limit = 100): SessionModel[] {
    const sinceIso = since ? since.toISOString().slice(0, 10) : null;
    const transcripts = this.allTranscripts();
    const sessions: SessionModel[] = [];
    for (const info of transcripts) {
      const session = sessionFromTranscript(info);
      if (sinceIso && session.date && session.date < sinceIso) continue;
      sessions.push(session);
      if (sessions.length >= limit) break;
    }
    return sessions;
  }

  exportL5(since?: Date): L5ManifestModel {
    const transcripts = this.allTranscripts();
    const memories = this.allMemories();

    const sinceIso = since ? since.toISOString().slice(0, 10) : null;
    const sessions: SessionModel[] = [];
    for (const info of transcripts) {
      const session = sessionFromTranscript(info);
      if (sinceIso && session.date && session.date < sinceIso) continue;
      sessions.push(session);
    }

    const entities = [
      ...entitiesFromMemories(memories),
      ...entitiesFromTranscripts(transcripts),
    ];
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
        "inline-completion",
        "chat",
        "plan-mode",
        "ask-mode",
        "explore-mode",
        "memory-tool",
        "workspace-scoped",
      ],
      recent_sessions: sessions,
      known_entities: visibleEntities,
      visibility_policy: DEFAULT_POLICY,
    });
  }

  healthCheck(): HealthStatus {
    try {
      const ws = this.resolveWs();
      if (ws === null || !isDir(ws)) {
        return {
          status: "blocked",
          reason: `VS Code workspaceStorage not found at ${ws ?? "None"}.`,
          details: { expected_path: ws ?? "None" },
          proposedFix:
            "Install VS Code and the GitHub Copilot Chat extension. " +
            "Set COPILOT_VSCODE_STORAGE if VS Code stores data elsewhere.",
        };
      }
      const chatDirs = findCopilotChatDirs(ws);
      if (chatDirs.length === 0) {
        return {
          status: "degraded",
          reason: "No Copilot Chat data found in any workspace.",
          details: { workspace_storage: ws },
          proposedFix:
            "Open VS Code and start a Copilot Chat conversation, " +
            "then re-run `bourdon copilot-vscode export`.",
        };
      }
      const transcripts = this.allTranscripts();
      const memories = this.allMemories();
      return {
        status: "ok",
        details: {
          workspace_storage: ws,
          workspace_count: chatDirs.length,
          transcript_count: transcripts.length,
          memory_file_count: memories.length,
          total_turns: transcripts.reduce((acc, t) => acc + (t.turn_count || 0), 0),
        },
      };
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

  /** Collect and parse all transcripts across all workspaces. */
  private allTranscripts(): TranscriptInfo[] {
    const ws = this.resolveWs();
    if (ws === null) return [];
    const chatDirs = findCopilotChatDirs(ws);
    const transcripts: TranscriptInfo[] = [];
    for (const chatDir of chatDirs) {
      const transcriptDir = join(chatDir, TRANSCRIPTS_DIR);
      if (!isDir(transcriptDir)) continue;
      let files: string[];
      try {
        files = readdirSync(transcriptDir).sort();
      } catch {
        continue;
      }
      for (const fname of files) {
        if (!fname.endsWith(".jsonl")) continue;
        const info = parseTranscript(join(transcriptDir, fname));
        if (info !== null) transcripts.push(info);
      }
    }
    // Sort by start_time descending (missing → "").
    transcripts.sort((a, b) => {
      const av = a.start_time ?? "";
      const bv = b.start_time ?? "";
      return av < bv ? 1 : av > bv ? -1 : 0;
    });
    return transcripts;
  }

  /** Collect all memory-tool files across all workspaces. */
  private allMemories(): MemoryFile[] {
    const ws = this.resolveWs();
    if (ws === null) return [];
    const chatDirs = findCopilotChatDirs(ws);
    const memories: MemoryFile[] = [];
    for (const chatDir of chatDirs) {
      memories.push(...parseMemoryFiles(chatDir));
    }
    return memories;
  }
}
