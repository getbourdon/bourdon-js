/**
 * GitHub Copilot (local convention) participant — reads the convention-based
 * memory file at `~/.copilot-bourdon/memory.md`. Port of `participants/copilot.py`.
 *
 * Copilot has no accessible local session index (its reasoning is cloud-side and
 * its native memory is not exposed on disk), so — like the Codex pre-distillation
 * fallback — this reader normalizes a user-maintained convention file into a
 * Bourdon L5 manifest. The file is YAML front-matter (structured `entities:` /
 * `sessions:`) followed by an optional freeform markdown body that Copilot Chat
 * reads as plain context but this reader ignores.
 *
 * NOT the cloud GitHub-Copilot network adapter ({@link GitHubCopilotParticipant})
 * and NOT the Copilot CLI SQLite reader.
 *
 * Paths checked (in order):
 *   1. `COPILOT_BOURDON_HOME` env-var override
 *   2. `~/.copilot-bourdon/`  (default convention path)
 *
 * Defensive throughout: a missing convention directory raises
 * {@link ParticipantDiscoveryError} from `discover()`; malformed YAML degrades to
 * an empty manifest rather than raising; `healthCheck` never throws.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
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
import { redactText } from "@getbourdon/redaction";

import {
  ParticipantDiscoveryError,
  SPEC_VERSION,
  type AgentStore,
  type BourdonParticipant,
  type HealthStatus,
} from "../base.js";

const AGENT_ID = "copilot";
const AGENT_TYPE = "code-assistant";
const DISPLAY_NAME = "GitHub Copilot";
const ROLE_NARRATIVE =
  "Inline completion and chat assistant present across every IDE the team uses. " +
  "Works alongside the human at the keystroke level -- the ambient layer that " +
  "recognises what is being typed before a full turn is even formed. Bourdon " +
  "gives Copilot cross-session entity awareness it would otherwise lack entirely.";

// Convention directory and file names. Override dir with COPILOT_BOURDON_HOME.
const CONVENTION_DIR_NAME = ".copilot-bourdon";
const MEMORY_FILENAME = "memory.md";

// Front-matter delimiters (mirrors claude-code's parseFrontmatter conventions).
const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "\n---\n";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "health", "family", "legal"],
  team_tags: ["copilot-memory", "workspace", "copilot"],
});

/** Minimal logger so a degraded read is visible without pulling in a dep
 * (matches the registry's logging idiom). */
const logger = {
  warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[bourdon.participants] ${msg}`);
  },
};

/** Starter template written by `bourdon copilot init`. */
const MEMORY_TEMPLATE = `---
# Copilot Bourdon Memory
# Edit this file to give Copilot cross-session entity awareness.
# The YAML front-matter is parsed by \`bourdon copilot export\`.
# The markdown body below the closing \`---\` is freeform context for Copilot Chat.

entities: []

sessions: []
---

# Copilot notes

Add project notes, preferences, or anything else you want Copilot Chat to
remember here. This section is freeform -- the participant only reads the YAML
front-matter above.
`;

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

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// -- Path helpers -------------------------------------------------------------

/**
 * Return the conventional `~/.copilot-bourdon/` directory path. Respects the
 * `COPILOT_BOURDON_HOME` env-var override (returned verbatim, even if absent;
 * the directory is not created here).
 */
export function defaultCopilotBourdonDir(): string {
  const env = process.env.COPILOT_BOURDON_HOME;
  if (env) return env;
  return join(homeDir(), CONVENTION_DIR_NAME);
}

/** Return the path to the convention memory file. */
export function defaultCopilotMemoryPath(copilotDir?: string | null): string {
  return join(copilotDir || defaultCopilotBourdonDir(), MEMORY_FILENAME);
}

// -- Coercion helpers (mirror Python str() / isinstance filtering) ------------

/** Mirror Python `str(value)` for the value types YAML yields here. The `yaml`
 * lib parses timestamps into JS `Date`; Python's `yaml.safe_load` yields
 * `date`/`datetime` whose `str()` is ISO-ish, so a Date is rendered as its ISO
 * date (date-only callers slice to 10 anyway). */
function coerceStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Mirror Python `str(raw.get(key) or "") or None`. */
function strOrUndef(v: unknown): string | undefined {
  const s = coerceStr((v as unknown) || "");
  return s || undefined;
}

/** Mirror `[str(x) for x in raw if isinstance(x, str) and x.strip()]`. */
function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// -- YAML frontmatter ---------------------------------------------------------

/**
 * Extract and parse the YAML front-matter block from memory file text. Returns
 * an empty object when the file has no front-matter or when the YAML cannot be
 * parsed (logged at WARNING in the oracle; never raises here either).
 */
function parseFrontmatter(text: string, source?: string): Record<string, unknown> {
  if (!text.startsWith(FRONTMATTER_OPEN)) return {};
  const end = text.indexOf(FRONTMATTER_CLOSE, FRONTMATTER_OPEN.length);
  if (end === -1) return {};
  const fmText = text.slice(FRONTMATTER_OPEN.length, end);
  let parsed: unknown;
  try {
    parsed = yamlParse(fmText);
  } catch (err) {
    const where = source ? ` in ${source}` : "";
    const detail = String(err).replace(/\n/g, " ").slice(0, 200);
    logger.warn(
      `CopilotParticipant: malformed YAML frontmatter${where}; ` +
        `treating as no-frontmatter (${detail})`,
    );
    return {};
  }
  return isRecord(parsed) ? parsed : {};
}

/**
 * Read and parse a copilot-bourdon memory file. Returns an empty object on any
 * I/O or parse error — the participant degrades to an empty manifest.
 */
function readMemoryFile(path: string): Record<string, unknown> {
  if (!isFile(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    logger.warn(`CopilotParticipant: cannot read ${path}: ${String(err)}`);
    return {};
  }
  return parseFrontmatter(text, path);
}

// -- Entity / Session converters ----------------------------------------------

/** Convert a raw YAML entity record to a Bourdon Entity. Skips malformed
 * entries (oracle logs at DEBUG). Never raises. */
function buildEntity(raw: unknown): EntityModel | null {
  if (!isRecord(raw)) return null;
  const name = raw["name"];
  if (typeof name !== "string" || name.trim() === "") return null;

  const summaryRaw = raw["summary"] || "";
  const summary = summaryRaw ? redactText(coerceStr(summaryRaw)) : undefined;

  return makeEntity({
    name: name.trim(),
    type: strOrUndef(raw["type"]),
    aliases: strList(raw["aliases"]),
    summary,
    last_touched: strOrUndef(raw["last_touched"]),
    tags: strList(raw["tags"]),
    valid_from: strOrUndef(raw["valid_from"]),
    valid_to: strOrUndef(raw["valid_to"]),
  });
}

/** Convert a raw YAML session record to a Bourdon Session. Skips malformed
 * entries (oracle logs at DEBUG). Never raises. */
function buildSession(raw: unknown): SessionModel | null {
  if (!isRecord(raw)) return null;
  const dateVal = raw["date"];
  if (!dateVal) return null;
  const dateStr = coerceStr(dateVal).slice(0, 10); // keep YYYY-MM-DD prefix only

  return makeSession({
    date: dateStr,
    cwd: strOrUndef(raw["cwd"]),
    project_focus: strList(raw["project_focus"]),
    key_actions: strList(raw["key_actions"]),
    files_touched: strList(raw["files_touched"]),
  });
}

// -- Diagnostics --------------------------------------------------------------

/** Diagnostic summary of the copilot-bourdon memory file (`bourdon copilot
 * doctor`). Never raises. */
export function inspectCopilotMemory(copilotDir?: string | null): Record<string, unknown> {
  const memPath = defaultCopilotMemoryPath(copilotDir);
  const report: Record<string, unknown> = {
    path: memPath,
    present: isFile(memPath),
    readable: false,
    frontmatter_valid: false,
    entity_count: 0,
    session_count: 0,
    error: null,
  };
  if (!isFile(memPath)) {
    report["error"] = "missing";
    return report;
  }
  let text: string;
  try {
    text = readFileSync(memPath, "utf8");
    report["readable"] = true;
  } catch (err) {
    report["error"] = String(err);
    return report;
  }

  const data = parseFrontmatter(text, memPath);
  if (Object.keys(data).length > 0) report["frontmatter_valid"] = true;
  report["entity_count"] = asArray(data["entities"]).length;
  report["session_count"] = asArray(data["sessions"]).length;
  return report;
}

// -- Participant --------------------------------------------------------------

/**
 * External participant for GitHub Copilot via `~/.copilot-bourdon/memory.md`.
 * Implements {@link BourdonParticipant} structurally.
 */
export class CopilotParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  displayName = DISPLAY_NAME;
  nativePath: string;

  /** Conventional `~/.copilot-bourdon` dir used by the setup wizard's detection. */
  static defaultNativePath(home?: string): string {
    if (home !== undefined) return join(home, CONVENTION_DIR_NAME);
    return defaultCopilotBourdonDir();
  }

  private readonly copilotDir: string | null;

  constructor(copilotDir?: string | null) {
    this.copilotDir = copilotDir ?? null;
    this.nativePath = this.copilotDir || defaultCopilotBourdonDir();
  }

  discover(): AgentStore {
    const path = this.copilotDir || defaultCopilotBourdonDir();
    if (!isDir(path)) {
      throw new ParticipantDiscoveryError(
        `Copilot convention directory not found at '${path}'. ` +
          "Run `bourdon copilot init` to create it with a starter template, " +
          "or create ~/.copilot-bourdon/memory.md manually.",
      );
    }
    const memPath = join(path, MEMORY_FILENAME);
    return {
      path,
      version: "convention-v1",
      metadata: {
        memory_file: memPath,
        memory_file_present: isFile(memPath),
      },
    };
  }

  exportSessions(since?: Date, limit = 100): SessionModel[] {
    const data = this.read();
    const sinceIso = since ? since.toISOString().slice(0, 10) : null;
    const sessions: SessionModel[] = [];
    for (const raw of asArray(data["sessions"])) {
      const session = buildSession(raw);
      if (session === null) continue;
      if (sinceIso && session.date && session.date < sinceIso) continue;
      sessions.push(session);
      if (sessions.length >= limit) break;
    }
    return sessions;
  }

  exportL5(since?: Date): L5ManifestModel {
    const data = this.read();

    const entities: EntityModel[] = [];
    for (const raw of asArray(data["entities"])) {
      const entity = buildEntity(raw);
      if (entity !== null) entities.push(entity);
    }
    const visibleEntities = filterForFederation(entities, DEFAULT_POLICY);

    const sinceIso = since ? since.toISOString().slice(0, 10) : null;
    const sessions: SessionModel[] = [];
    for (const raw of asArray(data["sessions"])) {
      const session = buildSession(raw);
      if (session === null) continue;
      if (sinceIso && session.date && session.date < sinceIso) continue;
      sessions.push(session);
    }

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
      capabilities: ["inline-completion", "chat", "pr-review", "convention-memory"],
      recent_sessions: sessions,
      known_entities: visibleEntities,
      visibility_policy: DEFAULT_POLICY,
    });
  }

  healthCheck(): HealthStatus {
    const path = this.copilotDir || defaultCopilotBourdonDir();
    if (!isDir(path)) {
      return {
        status: "blocked",
        reason:
          `Convention directory ${path} not found. ` +
          "Run `bourdon copilot init` to create it.",
        details: { expected_path: path },
        proposedFix: "Run `bourdon copilot init` to create the convention directory.",
      };
    }
    const memPath = join(path, MEMORY_FILENAME);
    if (!isFile(memPath)) {
      return {
        status: "degraded",
        reason:
          `Memory file ${memPath} not found. ` +
          "Run `bourdon copilot init` to write a starter template.",
        details: { expected_memory_file: memPath },
        proposedFix: "Run `bourdon copilot init` to write the starter memory.md template.",
      };
    }
    let data: Record<string, unknown>;
    try {
      data = this.read();
    } catch (err) {
      logger.warn(`CopilotParticipant health_check failed: ${String(err)}`);
      return {
        status: "degraded",
        reason: "Memory file present but could not be parsed.",
        details: { error: String(err) },
        proposedFix:
          `Inspect ${memPath} for malformed YAML front-matter. ` +
          "The opening and closing `---` fences must wrap a valid YAML " +
          "block. See docs/agent-integration-status.md for the schema.",
      };
    }
    return {
      status: "ok",
      details: {
        memory_file: memPath,
        entity_count: asArray(data["entities"]).length,
        session_count: asArray(data["sessions"]).length,
      },
    };
  }

  // -- Internal ---------------------------------------------------------------

  private read(): Record<string, unknown> {
    return readMemoryFile(defaultCopilotMemoryPath(this.copilotDir));
  }
}

// -- Init helper --------------------------------------------------------------

/**
 * Create `~/.copilot-bourdon/memory.md` with a starter template. Returns the
 * written path. Throws when the file already exists unless `force` is true.
 */
export function initMemoryFile(copilotDir?: string | null, force = false): string {
  const targetDir = copilotDir || defaultCopilotBourdonDir();
  mkdirSync(targetDir, { recursive: true });
  const memPath = join(targetDir, MEMORY_FILENAME);
  if (isFile(memPath) && !force) {
    throw new Error(`${memPath} already exists. Pass --force to overwrite.`);
  }
  writeFileSync(memPath, MEMORY_TEMPLATE, "utf8");
  return memPath;
}
