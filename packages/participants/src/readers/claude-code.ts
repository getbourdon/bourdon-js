/**
 * Claude Code participant — reads claude-brain + auto-memory + MCP knowledge
 * graph. Port of `participants/claude_code.py`.
 *
 * Three optional sources (the participant degrades gracefully):
 *   1. claude-brain/                  — git-synced markdown records
 *   2. ~/.claude/projects/<ws>/memory/ — per-machine auto-memory frontmatter
 *   3. ~/claude-memory/memory.jsonl   — MCP knowledge-graph JSONL
 *
 * Privacy: entities typed `person` (+ family/contact variants) and observations
 * containing credential-like strings default to PRIVATE and are filtered before
 * federation. Entities are deduped by case-insensitive name and sorted
 * alphabetically.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

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
import { containsSecret } from "@getbourdon/redaction";

import {
  ParticipantDiscoveryError,
  SPEC_VERSION,
  type AgentStore,
  type BourdonParticipant,
  type HealthStatus,
} from "../base.js";

const AGENT_ID = "claude-code";
const AGENT_TYPE = "code-assistant";
const ROLE_NARRATIVE =
  "Agentic manager and code-assistant. Coordinates the RADLAB agent fleet, " +
  "reviews PRs, and consults on architectural decisions. Capable of authoring " +
  "code but typically reviews + delegates to specialised code-assistants like " +
  "Codex for prime-code execution.";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.PUBLIC,
  private_tags: ["personal", "financial", "credential", "health", "family", "legal"],
  team_tags: ["internal-roadmap"],
});

/** Entity-type slugs that default to PRIVATE unless explicitly promoted. */
const PRIVATE_BY_DEFAULT_TYPES = new Set([
  "person",
  "user",
  "individual",
  "contact",
  "family-member",
  "family_member",
]);

const MAX_SUMMARY_CHARS = 500;
const MAX_OBSERVATIONS_IN_SUMMARY = 2;

// -- Path resolution ----------------------------------------------------------

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

function resolveClaudeBrainPath(): string | null {
  const envOverride = process.env.CLAUDE_BRAIN;
  if (envOverride && isDir(envOverride)) return envOverride;
  const homeCandidate = join(homeDir(), "claude-brain");
  if (isDir(homeCandidate)) return homeCandidate;
  const cwdCandidate = join(process.cwd(), "claude-brain");
  if (isDir(cwdCandidate)) return cwdCandidate;
  return null;
}

function homeDir(): string {
  // os.homedir() can throw under some sandboxes; stay defensive so import +
  // construction never crash even when HOME points at an unreadable path.
  try {
    return homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || ".";
  }
}

function resolveAutoMemoryPath(): string | null {
  try {
    const base = join(homeDir(), ".claude", "projects");
    if (!isDir(base)) return null;
    for (const child of readdirSync(base)) {
      const memMarker = join(base, child, "memory", "MEMORY.md");
      if (isFile(memMarker)) return join(base, child, "memory");
    }
  } catch {
    return null;
  }
  return null;
}

function resolveKnowledgeGraphPath(): string | null {
  const candidate = join(homeDir(), "claude-memory", "memory.jsonl");
  return isFile(candidate) ? candidate : null;
}

// -- Privacy scrubbing --------------------------------------------------------

function isPrivateType(entityType: string | null | undefined): boolean {
  if (!entityType) return false;
  const normalized = entityType.split("/").pop()?.trim().toLowerCase() ?? "";
  return PRIVATE_BY_DEFAULT_TYPES.has(normalized);
}

// -- YAML frontmatter ---------------------------------------------------------

const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "\n---\n";

function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!text.startsWith(FRONTMATTER_OPEN)) return { frontmatter: {}, body: text };
  const end = text.indexOf(FRONTMATTER_CLOSE, FRONTMATTER_OPEN.length);
  if (end === -1) return { frontmatter: {}, body: text };
  const fmText = text.slice(FRONTMATTER_OPEN.length, end);
  const body = text.slice(end + FRONTMATTER_CLOSE.length);
  let parsed: unknown;
  try {
    parsed = yamlParse(fmText);
  } catch {
    return { frontmatter: {}, body: text };
  }
  const fm =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter: fm, body };
}

// -- Parser: claude-brain PROJECTS + LOG --------------------------------------

const H1_RE = /^#[ \t]+(.+?)[ \t]*$/m;
const STATUS_SECTION_RE = /^##[ \t]+(?:Current[ \t]+)?Status[^\n]*$/im;
const STATUS_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const TITLE_SPLIT_RE = /\s*[-—–:]+\s+/;

function extractH1Title(body: string): string | null {
  const match = H1_RE.exec(body);
  if (!match) return null;
  const title = (match[1] ?? "").trim();
  const head = title.split(TITLE_SPLIT_RE)[0] ?? title;
  return head.trim();
}

function extractFirstParagraph(body: string, maxChars = MAX_SUMMARY_CHARS): string {
  const paragraph: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) {
      if (paragraph.length) break;
      continue;
    }
    if (stripped.startsWith("#")) continue;
    paragraph.push(stripped);
    if (paragraph.reduce((acc, s) => acc + s.length + 1, 0) > maxChars) break;
  }
  return paragraph.join(" ").trim().slice(0, maxChars).trim();
}

function extractStatusTag(body: string): string[] {
  const match = STATUS_SECTION_RE.exec(body);
  if (!match) return [];
  const region = body.slice(match.index, match.index + 400).toLowerCase();
  const tags: string[] = [];
  for (const keyword of ["archived", "canceled", "cancelled", "active", "shipped", "blocked"]) {
    if (region.includes(keyword)) tags.push(keyword.replace("cancelled", "canceled"));
  }
  return [...new Set(tags)];
}

const END_OF_LIFE_TAGS = new Set(["archived", "canceled"]);

function extractStatusDate(body: string): string | null {
  const match = STATUS_SECTION_RE.exec(body);
  if (!match) return null;
  const region = body.slice(match.index, match.index + 400);
  const dateMatch = STATUS_DATE_RE.exec(region);
  return dateMatch ? (dateMatch[1] ?? null) : null;
}

function parseProjectOverview(overviewPath: string): EntityModel | null {
  let text: string;
  try {
    text = readFileSync(overviewPath, "utf8");
  } catch {
    return null;
  }
  const { body } = parseFrontmatter(text);
  const title = extractH1Title(body) || basename(join(overviewPath, ".."));
  const summary = extractFirstParagraph(body);
  const tags = extractStatusTag(body);

  let validTo: string | null = null;
  if (tags.some((t) => END_OF_LIFE_TAGS.has(t))) {
    validTo = extractStatusDate(body);
    if (validTo === null) {
      try {
        const mtime = statSync(overviewPath).mtime;
        validTo = mtime.toISOString().slice(0, 10);
      } catch {
        validTo = null;
      }
    }
  }

  return makeEntity({
    name: title,
    type: "project",
    summary: summary || undefined,
    tags,
    valid_to: validTo ?? undefined,
  });
}

function parseProjectsDir(brainPath: string): EntityModel[] {
  const projectsDir = join(brainPath, "PROJECTS");
  if (!isDir(projectsDir)) return [];
  const entities: EntityModel[] = [];
  for (const name of readdirSync(projectsDir).sort()) {
    const projectDir = join(projectsDir, name);
    if (!isDir(projectDir)) continue;
    const overview = join(projectDir, "OVERVIEW.md");
    if (!isFile(overview)) continue;
    const entity = parseProjectOverview(overview);
    if (entity) entities.push(entity);
  }
  return entities;
}

const LOG_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-(\w+?))?(?:-.*)?\.md$/;

function parseLogFile(logPath: string): SessionModel | null {
  const m = LOG_FILENAME_RE.exec(basename(logPath));
  if (!m) return null;
  const sessionDate = m[1] ?? "";
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  const { body } = parseFrontmatter(text);
  const headline = extractFirstParagraph(body, 250);
  return makeSession({
    date: sessionDate,
    key_actions: headline ? [headline] : [],
    files_touched: [`LOG/${basename(logPath)}`],
  });
}

function parseLogsDir(brainPath: string, since?: Date, limit = 100): SessionModel[] {
  const logDir = join(brainPath, "LOG");
  if (!isDir(logDir)) return [];
  const candidates: Array<[string, string]> = [];
  for (const fname of readdirSync(logDir)) {
    if (!fname.endsWith(".md")) continue;
    const m = LOG_FILENAME_RE.exec(fname);
    if (!m) continue;
    const d = m[1] ?? "";
    if (since) {
      if (d < since.toISOString().slice(0, 10)) continue;
    }
    candidates.push([d, join(logDir, fname)]);
  }
  candidates.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)); // newest first
  const sessions: SessionModel[] = [];
  for (const [, logFile] of candidates.slice(0, limit)) {
    const session = parseLogFile(logFile);
    if (session) sessions.push(session);
  }
  return sessions;
}

// -- Parser: auto-memory ------------------------------------------------------

function parseAutoMemoryEntity(mdPath: string): EntityModel | null {
  let text: string;
  try {
    text = readFileSync(mdPath, "utf8");
  } catch {
    return null;
  }
  const { frontmatter, body } = parseFrontmatter(text);
  const name =
    (frontmatter["name"] as string | undefined) ||
    extractH1Title(body) ||
    basename(mdPath).replace(/\.md$/, "");
  const entityType = frontmatter["type"] as string | undefined;
  const summaryRaw =
    (frontmatter["description"] as string | undefined) || extractFirstParagraph(body);
  const rawTags = frontmatter["tags"];
  const tags = Array.isArray(rawTags) ? rawTags.map((t) => String(t)) : [];

  const visibility = isPrivateType(entityType) ? Visibility.PRIVATE : undefined;

  return makeEntity({
    name: String(name),
    type: entityType ? String(entityType) : undefined,
    summary: summaryRaw ? String(summaryRaw).slice(0, MAX_SUMMARY_CHARS).trim() : undefined,
    tags,
    visibility,
  });
}

function parseAutoMemory(memoryPath: string): EntityModel[] {
  if (!isDir(memoryPath)) return [];
  const entities: EntityModel[] = [];
  for (const fname of readdirSync(memoryPath).sort()) {
    if (!fname.endsWith(".md") || fname === "MEMORY.md") continue;
    const entity = parseAutoMemoryEntity(join(memoryPath, fname));
    if (entity) entities.push(entity);
  }
  return entities;
}

// -- Parser: knowledge graph JSONL --------------------------------------------

function graphEntityToBourdonEntity(record: Record<string, unknown>): EntityModel | null {
  const name = record["name"];
  if (!name || typeof name !== "string") return null;
  const entityTypeSlug = (record["entityType"] as string | undefined) || "";
  const normalizedType = entityTypeSlug ? (entityTypeSlug.split("/").pop() ?? null) : null;
  const observations = Array.isArray(record["observations"])
    ? (record["observations"] as unknown[])
    : [];

  const safeObs: string[] = [];
  for (const obs of observations.slice(0, MAX_OBSERVATIONS_IN_SUMMARY)) {
    if (typeof obs !== "string") continue;
    safeObs.push(containsSecret(obs) ? "[redacted -- contains credential-like content]" : obs);
  }
  const joined = safeObs.join(" | ").slice(0, MAX_SUMMARY_CHARS).trim();
  const summary = joined || undefined;

  const hasCredObs = observations.some((o) => typeof o === "string" && containsSecret(o));
  const visibility = isPrivateType(entityTypeSlug) || hasCredObs ? Visibility.PRIVATE : undefined;

  const tags =
    normalizedType && normalizedType !== name.toLowerCase() ? [normalizedType] : [];

  return makeEntity({
    name,
    type: normalizedType ?? undefined,
    summary,
    tags,
    visibility,
  });
}

function parseKnowledgeGraph(graphPath: string): EntityModel[] {
  if (!isFile(graphPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(graphPath, "utf8");
  } catch {
    return [];
  }
  const entities: EntityModel[] = [];
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // skip malformed JSONL (logged at WARNING in the oracle)
    }
    if (typeof record !== "object" || record === null) continue;
    const rec = record as Record<string, unknown>;
    if (rec["type"] !== "entity") continue;
    const entity = graphEntityToBourdonEntity(rec);
    if (entity) entities.push(entity);
  }
  return entities;
}

// -- Dedupe + merge -----------------------------------------------------------

const VIS_ORDER: Record<string, number> = {
  [Visibility.PRIVATE]: 0,
  [Visibility.TEAM]: 1,
  [Visibility.PUBLIC]: 2,
  none: 3,
};

function visRank(v: Visibility | null | undefined): number {
  return v == null ? VIS_ORDER["none"]! : VIS_ORDER[v]!;
}

function mergeEntities(into: EntityModel, other: EntityModel): EntityModel {
  if (!into.type && other.type) into.type = other.type;
  if (other.summary && other.summary.trim() && other.summary.length > (into.summary?.length ?? 0)) {
    into.summary = other.summary;
  }
  into.tags = [...new Set([...(into.tags ?? []), ...(other.tags ?? [])])];
  if (visRank(other.visibility) < visRank(into.visibility)) {
    into.visibility = other.visibility;
  }
  return into;
}

/**
 * Merge multiple entity lists into one, deduping by case-insensitive name.
 * NOTE the faithful oracle quirk: the fresh copy DROPS valid_from / valid_to, so
 * an archived project keeps its `archived` tag but emits no `valid_to`. Do not
 * "fix" this — parity breaks otherwise.
 */
function dedupeEntities(sourceLists: EntityModel[][]): EntityModel[] {
  const byKey = new Map<string, EntityModel>();
  for (const source of sourceLists) {
    for (const entity of source) {
      const key = entity.name.trim().toLowerCase();
      if (!key) continue;
      const existing = byKey.get(key);
      if (existing) {
        mergeEntities(existing, entity);
      } else {
        byKey.set(
          key,
          makeEntity({
            name: entity.name,
            type: entity.type,
            aliases: [...(entity.aliases ?? [])],
            summary: entity.summary,
            last_touched: entity.last_touched,
            tags: [...(entity.tags ?? [])],
            visibility: entity.visibility,
            // valid_from / valid_to intentionally dropped (oracle behavior).
          }),
        );
      }
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

// -- Participant --------------------------------------------------------------

/** External participant for Anthropic's Claude Code CLI. */
export class ClaudeCodeParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  nativePath: string;

  /** Public so a hermetic test can seed the discovered sources directly (path
   * RESOLUTION is not the parity contract — only the export output shape is). */
  brainPath: string | null;
  autoMemoryPath: string | null;
  knowledgeGraphPath: string | null;

  static defaultNativePath(home?: string): string {
    return join(home ?? homeDir(), ".claude");
  }

  constructor() {
    this.nativePath = join(homeDir(), "claude-brain"); // primary anchor
    this.brainPath = resolveClaudeBrainPath();
    this.autoMemoryPath = resolveAutoMemoryPath();
    this.knowledgeGraphPath = resolveKnowledgeGraphPath();
  }

  discover(): AgentStore {
    const sources = {
      claude_brain: this.brainPath,
      auto_memory: this.autoMemoryPath,
      knowledge_graph: this.knowledgeGraphPath,
    };
    if (!Object.values(sources).some((v) => v)) {
      throw new ParticipantDiscoveryError(
        "No Claude Code memory sources found. Expected one of: ~/claude-brain/, " +
          "~/.claude/projects/*/memory/, ~/claude-memory/memory.jsonl.",
      );
    }
    return {
      path: this.nativePath,
      version: "claude-code-memory-v1",
      metadata: { sources },
    };
  }

  exportL5(since?: Date): L5ManifestModel {
    const store = this.discover(); // re-raises on missing
    const sources = store.metadata["sources"] as Record<string, string | null>;
    const capabilities = Object.entries(sources)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort();

    const autoMemoryEntities = this.autoMemoryPath ? parseAutoMemory(this.autoMemoryPath) : [];
    const graphEntities = this.knowledgeGraphPath
      ? parseKnowledgeGraph(this.knowledgeGraphPath)
      : [];
    const projectEntities = this.brainPath ? parseProjectsDir(this.brainPath) : [];

    // Priority: auto-memory > graph > brain projects (first wins on collision).
    const allEntities = dedupeEntities([autoMemoryEntities, graphEntities, projectEntities]);

    // Visibility filter — private entities never leave this function.
    const visibleEntities = filterForFederation(allEntities, DEFAULT_POLICY);

    const sessions = this.brainPath ? parseLogsDir(this.brainPath, since) : [];

    return makeManifest({
      spec_version: SPEC_VERSION,
      agent: makeAgentInfo({
        id: this.agentId,
        type: this.agentType,
        instance: hostname() || "unknown",
        spec_version_compat: `>=${SPEC_VERSION}`,
        role_narrative: ROLE_NARRATIVE,
      }),
      last_updated: new Date().toISOString(),
      capabilities,
      recent_sessions: sessions,
      known_entities: visibleEntities,
      visibility_policy: DEFAULT_POLICY,
    });
  }

  exportSessions(since?: Date, limit = 100): SessionModel[] {
    if (!this.brainPath) return [];
    return parseLogsDir(this.brainPath, since, limit);
  }

  healthCheck(): HealthStatus {
    try {
      const present = [this.brainPath, this.autoMemoryPath, this.knowledgeGraphPath].filter(
        (p) => p !== null,
      ).length;
      const details = {
        claude_brain: this.brainPath ?? "missing",
        auto_memory: this.autoMemoryPath ?? "missing",
        knowledge_graph: this.knowledgeGraphPath ?? "missing",
      };
      if (present === 3) return { status: "ok", details };
      if (present === 0) {
        return {
          status: "blocked",
          reason: "No Claude Code memory sources found on this machine",
          details,
          proposedFix:
            "Run `bourdon setup` to wire the SessionEnd hook and bootstrap " +
            "~/agent-library/, then open Claude Code once to populate ~/.claude/projects/.",
        };
      }
      return {
        status: "degraded",
        reason: `${present}/3 Claude Code memory sources found`,
        details,
        proposedFix:
          "Run `bourdon setup` to (re-)wire missing sources, or set the CLAUDE_BRAIN " +
          "env var to point at your claude-brain checkout.",
      };
    } catch (err) {
      return {
        status: "degraded",
        reason: `unexpected error: ${String(err)}`,
        details: {},
      };
    }
  }
}
