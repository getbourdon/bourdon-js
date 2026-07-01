/**
 * Cascade (Windsurf) participant — convention-file reader. Port of
 * `participants/cascade.py`.
 *
 * Cascade's internal state is not exposed on the filesystem in a standardized
 * format (like cloud Copilot). Instead this participant uses a CONVENTION FILE:
 * Cascade maintains a structured memory file at `~/.cascade-bourdon/memory.md`
 * with YAML front-matter carrying `entities` + `sessions`. Cascade owns that
 * projection explicitly (it writes what it knows at session end); the
 * participant normalizes the front-matter into an L5 manifest for federation.
 *
 * Privacy: entity/session summaries pass through the redaction SSOT; the
 * visibility policy (private_tags) filters PRIVATE entities before emission.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as yamlParse } from "yaml";

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
import { REDACTED, SENSITIVE_PATTERNS, redactText } from "@getbourdon/redaction";

import {
  ParticipantDiscoveryError,
  SPEC_VERSION,
  type AgentStore,
  type BourdonParticipant,
  type HealthStatus,
} from "../base.js";

// -- Constants -----------------------------------------------------------------

const AGENT_ID = "cascade";
const AGENT_TYPE = "code-assistant";
const DISPLAY_NAME = "Cascade (Windsurf)";
const ROLE_NARRATIVE =
  "Agentic AI coding assistant embedded in Windsurf IDE. " +
  "Operates with multi-step planning, tool use (file editing, terminal, " +
  "browser preview, code search), persistent memory, and workspace-level " +
  "context awareness. Specializes in pair-programming workflows with " +
  "concurrent read-plan-execute cycles.";

const CONVENTION_DIR_NAME = ".cascade-bourdon";
const MEMORY_FILENAME = "memory.md";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.PUBLIC,
  private_tags: ["personal", "credential", "financial", "secret", "private"],
});

/**
 * The native-memory sensitive-pattern set, extended with Cascade-specific
 * triggers (`secret`, `sk_test_*`). A match anywhere drops the WHOLE string to
 * the redaction sentinel (see {@link scrubCredential}). All non-global so they
 * are safe to reuse across `.test()`.
 */
const CASCADE_SENSITIVE_PATTERNS: readonly RegExp[] = [
  ...SENSITIVE_PATTERNS,
  /\bsecret\b/i,
  /sk[_-]test[_-]/i,
];

/** Minimal logger so a malformed-frontmatter warning is visible without a dep. */
const logger = {
  warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[bourdon.participants] ${msg}`);
  },
};

// -- Path helpers --------------------------------------------------------------

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

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Return the default Cascade-Bourdon convention directory (`~/.cascade-bourdon`). */
export function defaultCascadeDir(): string {
  return join(homeDir(), CONVENTION_DIR_NAME);
}

/** Return the default path to the Cascade memory file. */
export function defaultCascadeMemoryPath(): string {
  return join(defaultCascadeDir(), MEMORY_FILENAME);
}

// -- Front-matter --------------------------------------------------------------

/**
 * Extract YAML front-matter from a `---` fenced block. Returns an empty object
 * when the text has no valid front-matter. On YAML parse failure logs at WARNING
 * (with the source path when provided) and treats it as no-frontmatter.
 *
 * NOTE: this is the Cascade-specific fence parse (`startswith("---")` +
 * `find("---", 3)`), distinct from the claude-code reader's `---\n` variant —
 * preserved faithfully from the oracle.
 */
function parseFrontmatter(text: string, source?: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("---", 3);
  if (end === -1) return {};
  const yamlBlock = text.slice(3, end).trim();
  if (!yamlBlock) return {};
  let data: unknown;
  try {
    data = yamlParse(yamlBlock);
  } catch (exc) {
    const where = source ? ` in ${source}` : "";
    const detail = String(exc).replace(/\n/g, " ").slice(0, 200);
    logger.warn(
      `CascadeParticipant: malformed YAML frontmatter${where}; ` +
        `treating as no-frontmatter (${detail})`,
    );
    return {};
  }
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

// -- Redaction -----------------------------------------------------------------

/**
 * Redact + truncate native-memory text. Same semantics as the codex reader's
 * `_safe_native_memory_text` (the redaction SSOT), extended with Cascade-
 * specific patterns (`secret`, `sk_test_*`): if any match, drop the whole string
 * to the redaction sentinel; otherwise scrub + cap via {@link redactText}.
 */
function scrubCredential(text: string): string {
  if (!text) return text;
  if (CASCADE_SENSITIVE_PATTERNS.some((p) => p.test(text))) {
    return REDACTED;
  }
  return redactText(text);
}

// -- Builders ------------------------------------------------------------------

/** Python `list(x or [])`: copy a list verbatim, char-split a string, else []. */
function asList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") return Array.from(v);
  return [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Build an Entity from a raw front-matter dict entry. Returns null on invalid. */
function buildEntity(raw: unknown): EntityModel | null {
  if (!isRecord(raw)) return null;
  const name = raw["name"];
  if (typeof name !== "string" || !name.trim()) return null;

  let summary: string | undefined;
  const rawSummary = raw["summary"];
  if (typeof rawSummary === "string") summary = scrubCredential(rawSummary);

  return makeEntity({
    name: name.trim(),
    type: typeof raw["type"] === "string" ? (raw["type"] as string) : undefined,
    summary,
    aliases: asList(raw["aliases"]),
    tags: asList(raw["tags"]),
    last_touched: raw["last_touched"] ? String(raw["last_touched"]) : undefined,
    valid_from: raw["valid_from"] ? String(raw["valid_from"]) : undefined,
    valid_to: raw["valid_to"] ? String(raw["valid_to"]) : undefined,
    visibility: undefined,
  });
}

/** Build a Session from a raw front-matter dict entry. Returns null on invalid. */
function buildSession(raw: unknown): SessionModel | null {
  if (!isRecord(raw)) return null;
  const dateVal = raw["date"];
  if (!dateVal) return null;
  // Normalize datetime strings to date-only (YYYY-MM-DD).
  const dateStr = String(dateVal).slice(0, 10);

  return makeSession({
    date: dateStr,
    cwd: raw["cwd"] == null ? undefined : (raw["cwd"] as string),
    key_actions: asList(raw["key_actions"]),
    files_touched: asList(raw["files_touched"]),
    project_focus: asList(raw["project_focus"]),
    visibility: undefined,
  });
}

/**
 * Mirror `datetime.fromisoformat(date)` on a date-only string for the `since`
 * filter. Returns the UTC midnight Date, or null on a ValueError-equivalent
 * (the caller keeps the session when this is null, matching `except ValueError`).
 */
function parseSessionDate(date: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function buildSessions(rawSessions: unknown, since?: Date): SessionModel[] {
  const list = Array.isArray(rawSessions) ? rawSessions : [];
  const sessions: SessionModel[] = [];
  for (const raw of list) {
    const session = buildSession(raw);
    if (session === null) continue;
    if (since !== undefined) {
      const d = parseSessionDate(session.date);
      if (d !== null && d.getTime() < since.getTime()) continue;
    }
    sessions.push(session);
  }
  return sessions;
}

// -- Diagnostics ---------------------------------------------------------------

/** Diagnostic inspection of the Cascade memory file: presence + content stats. */
function inspectCascadeMemory(cascadeDir: string): Record<string, unknown> {
  const memoryPath = join(cascadeDir, MEMORY_FILENAME);
  if (!isFile(memoryPath)) return { present: false, error: "missing" };

  let text: string;
  try {
    text = readFileSync(memoryPath, "utf8");
  } catch (e) {
    return { present: true, readable: false, error: String(e) };
  }

  const data = parseFrontmatter(text, memoryPath);
  if (Object.keys(data).length === 0) {
    return {
      present: true,
      readable: true,
      frontmatter_valid: false,
      entity_count: 0,
      session_count: 0,
    };
  }

  const entities = data["entities"];
  const sessions = data["sessions"];
  return {
    present: true,
    readable: true,
    frontmatter_valid: true,
    entity_count: Array.isArray(entities) ? entities.length : 0,
    session_count: Array.isArray(sessions) ? sessions.length : 0,
  };
}

// -- Init helper ---------------------------------------------------------------

const MEMORY_TEMPLATE = `---
entities:
  - name: Example Project
    type: project
    summary: Replace with real project summaries
    tags: [project]
sessions:
  - date: "{today}"
    cwd: /path/to/workspace
    key_actions:
      - Initialized Cascade Bourdon memory
    files_touched: []
    project_focus: []
---

# Cascade Bourdon Memory

This file is maintained by Cascade (Windsurf) for cross-agent memory federation.
Edit the YAML front-matter to update entities and sessions.
Cascade will update this file at session end when instructed.
`;

/**
 * Create a starter memory.md in the Cascade-Bourdon convention directory.
 *
 * @param cascadeDir Override the convention directory (default `~/.cascade-bourdon`).
 * @param force      Overwrite an existing file; otherwise throws.
 * @returns the path to the created memory file.
 */
export function initMemoryFile(cascadeDir?: string, force = false): string {
  const targetDir = cascadeDir ?? defaultCascadeDir();
  mkdirSync(targetDir, { recursive: true });
  const memoryPath = join(targetDir, MEMORY_FILENAME);

  if (isFile(memoryPath) && !force) {
    throw new Error(
      `Memory file already exists: ${memoryPath}. Use force=True to overwrite.`,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const content = MEMORY_TEMPLATE.replace("{today}", today);
  writeFileSync(memoryPath, content, "utf8");
  return memoryPath;
}

// -- Participant ---------------------------------------------------------------

/**
 * Convention-based Bourdon participant for Cascade (Windsurf). Reads structured
 * memory from `~/.cascade-bourdon/memory.md` and normalizes it into L5.
 */
export class CascadeParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  displayName = DISPLAY_NAME;

  private readonly dir: string;
  private readonly policy: VisibilityPolicyModel;

  static defaultNativePath(home?: string): string {
    if (home !== undefined) return join(home, CONVENTION_DIR_NAME);
    return defaultCascadeDir();
  }

  constructor(cascadeDir?: string, policy?: VisibilityPolicyModel) {
    this.dir = cascadeDir ?? defaultCascadeDir();
    this.policy = policy ?? DEFAULT_POLICY;
  }

  /** Path to the Cascade-Bourdon convention directory. */
  get nativePath(): string {
    return this.dir;
  }

  private memoryPath(): string {
    return join(this.dir, MEMORY_FILENAME);
  }

  private readFrontmatter(): Record<string, unknown> {
    const path = this.memoryPath();
    if (!isFile(path)) return {};
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return {};
    }
    return parseFrontmatter(text, path);
  }

  discover(): AgentStore {
    if (!isDir(this.dir)) {
      throw new ParticipantDiscoveryError(
        `Cascade-Bourdon directory not found: ${this.dir}`,
      );
    }
    const memoryPresent = isFile(this.memoryPath());
    return {
      path: this.dir,
      version: "unknown",
      metadata: {
        memory_file: this.memoryPath(),
        memory_file_present: memoryPresent,
      },
    };
  }

  exportL5(since?: Date): L5ManifestModel {
    const data = this.readFrontmatter();

    // Build entities.
    const rawEntities = data["entities"];
    const entityList = Array.isArray(rawEntities) ? rawEntities : [];
    const entities: EntityModel[] = [];
    for (const raw of entityList) {
      const entity = buildEntity(raw);
      if (entity !== null) entities.push(entity);
    }

    // Build sessions (since-filtered).
    const sessions = buildSessions(data["sessions"], since);

    // Apply visibility policy — filter out PRIVATE entities before emission.
    const visibleEntities = filterForFederation(entities, this.policy);

    return makeManifest({
      spec_version: SPEC_VERSION,
      agent: makeAgentInfo({
        id: AGENT_ID,
        type: AGENT_TYPE,
        role_narrative: ROLE_NARRATIVE,
      }),
      last_updated: new Date().toISOString(),
      known_entities: visibleEntities,
      recent_sessions: sessions,
      capabilities: ["chat", "code-editing", "terminal", "planning", "search"],
    });
  }

  exportSessions(since?: Date, limit?: number): SessionModel[] {
    const data = this.readFrontmatter();
    const sessions = buildSessions(data["sessions"], since);
    sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (limit !== undefined) return sessions.slice(0, limit);
    return sessions;
  }

  healthCheck(): HealthStatus {
    if (!isDir(this.dir)) {
      return {
        status: "blocked",
        reason: "Cascade-Bourdon directory not found",
        details: { expected_path: this.dir },
        proposedFix:
          "Run `bourdon cascade init` to create the convention directory + starter memory.md.",
      };
    }

    const report = inspectCascadeMemory(this.dir);
    if (!report["present"]) {
      return {
        status: "degraded",
        reason: "Memory file not found; run `bourdon cascade init` to create it",
        details: report,
        proposedFix:
          "Run `bourdon cascade init` to write the starter memory.md template.",
      };
    }

    if (!report["readable"]) {
      return {
        status: "degraded",
        reason: `Memory file not readable: ${String(report["error"])}`,
        details: report,
        proposedFix:
          `Check filesystem permissions on ${join(this.dir, "memory.md")} ` +
          "(should be readable by your user).",
      };
    }

    if (!report["frontmatter_valid"]) {
      return {
        status: "degraded",
        reason: "Memory file has no valid YAML front-matter",
        details: report,
        proposedFix:
          `Inspect ${join(this.dir, "memory.md")} -- the opening and closing ` +
          "`---` fences must wrap a valid YAML block. Run " +
          "`bourdon cascade init --force` to reset to the template " +
          "(WARNING: this overwrites existing content).",
      };
    }

    return {
      status: "ok",
      details: report,
    };
  }
}
