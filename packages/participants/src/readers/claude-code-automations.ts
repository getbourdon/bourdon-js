/**
 * Claude Code automations participant — publishes background-run memory as L5
 * evidence. Port of `participants/claude_code_automations.py`.
 *
 * Convention-file reader over the `~/.claude/automations/<id>/` tree:
 *   automation.toml — id, name, status, schedule (rrule), kind, cwds
 *   memory.md       — dated bullet entries, one block per run
 *
 * Each `automation.toml` becomes a known Entity (`type: automation`); each dated
 * section of `memory.md` becomes a recent Session. Mirrors the Codex automation
 * publisher — it covers the federation gap that the interactive-only
 * `claude-code` participant leaves behind (automations whose work never touches
 * claude-brain / auto-memory / the MCP knowledge graph).
 *
 * Privacy: every native string routes through the redaction SSOT
 * (`redactText`, == the oracle's `_safe_native_memory_text`); the visibility
 * policy filters PRIVATE entities before emission. `healthCheck` never throws.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

import { parse as parseToml } from "smol-toml";

import {
  ParticipantDiscoveryError,
  SPEC_VERSION,
  type AgentStore,
  type BourdonParticipant,
  type HealthStatus,
} from "../base.js";

// -- Constants -----------------------------------------------------------------

const AGENT_ID = "claude-code-automations";
const AGENT_TYPE = "other";
const ROLE_NARRATIVE =
  "Publishes read-only Claude Code automation run memory into Bourdon so " +
  "scheduled /loop continuations, CronCreate jobs, GitHub Action runs of " +
  "claude-code-action, and /schedule remote-routine summaries become " +
  "visible alongside interactive Claude Code sessions.";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "health", "family", "legal"],
  team_tags: ["claude-code-automation", "automation", "workspace"],
});

const AUTOMATIONS_DIR_NAME = "automations";
const AUTOMATION_TOML = "automation.toml";
const MEMORY_MD = "memory.md";
const MAX_MEMORY_CHARS = 160_000;
const MAX_KEY_ACTIONS_PER_RUN = 6;
const MAX_KEY_ACTION_CHARS = 280;

/** `^(\d{4}-\d{2}-\d{2})(?:\b|$)(.*)$` — anchored, non-global (safe to reuse). */
const RUN_HEADER_RE = /^(\d{4}-\d{2}-\d{2})(?:\b|$)(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
/** Chars stripped from a run-header suffix (space, hyphen, colon, em-dash). */
const HEADER_SUFFIX_STRIP = " -:—";

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

/** Signal-class name → case-insensitive, NON-GLOBAL matcher. */
const SIGNAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["human-dashboard-action", /\b(human|ryan|dashboard|manual)\b/i],
  ["release-gate", /\b(release|store|app review|play console|testflight)\b/i],
  ["billing-drift", /\b(billing|stripe|revenuecat|iap|subscription)\b/i],
  ["memory-coverage-gap", /\b(memory|l5|manifest|federated|bourdon)\b/i],
  ["launch-decision", /\b(launch|go-live|pricing|prod|production)\b/i],
  ["ci-signal", /\b(github action|workflow run|ci failure|gh action)\b/i],
];

/** Minimal logger so a degraded read is visible without pulling in a dep. */
const logger = {
  warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[bourdon.participants] ${msg}`);
  },
};

// -- Types ---------------------------------------------------------------------

interface AutomationConfig {
  automationId: string;
  name: string;
  status: string;
  rrule: string;
  kind: string;
  cwds: string[];
  /** Path to the automation.toml file. */
  path: string;
  /** Path to memory.md, or null when it is not a regular file. */
  memoryPath: string | null;
}

interface AutomationRun {
  automation: AutomationConfig;
  date: string;
  title: string;
  keyActions: string[];
  projects: string[];
  signals: string[];
}

/** Summary of a {@link mergeAutomationTree} call. */
export interface MergeResult {
  automationsSeen: number;
  automationsCreated: number;
  bulletsAdded: number;
  sectionsCreated: number;
  skipped: string[];
}

// -- fs helpers ----------------------------------------------------------------

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

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// -- Python-semantic string helpers -------------------------------------------

/** Python truthiness for the value kinds YAML/TOML yield here. */
function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** Mirror Python `str(value)` for the scalar types encountered here. */
function pyStr(v: unknown): string {
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  return String(v);
}

/** Mirror `str(a or b)` — pick `a` if truthy else `b`, then `str()`. */
function strOr(a: unknown, b: unknown): string {
  return pyStr(truthy(a) ? a : b);
}

/** Python `str.rstrip()` — drop trailing whitespace. */
function rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

/** Python `str.strip(chars)` — strip any of `chars` from both ends. */
function stripChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) start++;
  while (end > start && chars.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

/** Approximate Python `str.splitlines()` (no trailing empty for a final EOL). */
function splitLines(s: string): string[] {
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// -- Path resolution -----------------------------------------------------------

/**
 * Default Claude Code automations directory. Precedence:
 *   1. explicit `claudeHome` argument (tests)
 *   2. `CLAUDE_HOME` env var
 *   3. `~/.claude/` (RADLAB default)
 */
export function defaultClaudeCodeAutomationsDir(claudeHome?: string): string {
  if (claudeHome !== undefined) return join(claudeHome, AUTOMATIONS_DIR_NAME);
  const env = process.env.CLAUDE_HOME;
  if (env) return join(env, AUTOMATIONS_DIR_NAME);
  return join(homeDir(), ".claude", AUTOMATIONS_DIR_NAME);
}

// -- TOML config parsing -------------------------------------------------------

function readAutomationToml(path: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(path, "utf8"));
  } catch (exc) {
    logger.warn(
      `ClaudeCodeAutomationsParticipant: cannot parse ${path}: ${String(exc)}`,
    );
    return {};
  }
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function buildConfig(tomlPath: string): AutomationConfig | null {
  const raw = readAutomationToml(tomlPath);
  const parent = dirname(tomlPath);
  const parentName = basenameOf(parent);

  const automationId = strOr(raw["id"], parentName).trim();
  if (!automationId) return null;

  const name = strOr(raw["name"], automationId).trim();
  const status = strOr(raw["status"], "UNKNOWN").trim().toUpperCase();
  const rrule = strOr(raw["rrule"], "").trim();
  const kind = strOr(raw["kind"], "").trim();

  const cwdsRaw: unknown = truthy(raw["cwds"]) ? raw["cwds"] : [];
  const cwds: string[] = [];
  // Faithful to `for cwd in cwds_raw if isinstance(cwd, str) and cwd.strip()`:
  // arrays iterate elements, a string iterates characters. Other (non-iterable)
  // types yield no cwds here (the oracle would raise; see port notes).
  if (Array.isArray(cwdsRaw)) {
    for (const cwd of cwdsRaw) {
      if (typeof cwd === "string" && cwd.trim()) cwds.push(cwd);
    }
  } else if (typeof cwdsRaw === "string") {
    for (const ch of cwdsRaw) {
      if (ch.trim()) cwds.push(ch);
    }
  }

  const memoryPath = join(parent, MEMORY_MD);
  return {
    automationId,
    name,
    status,
    rrule,
    kind,
    cwds,
    path: tomlPath,
    memoryPath: isFile(memoryPath) ? memoryPath : null,
  };
}

/** `os.path.basename` that also handles a trailing separator like Path.name. */
function basenameOf(p: string): string {
  const cleaned = p.replace(/[/\\]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx === -1 ? cleaned : cleaned.slice(idx + 1);
}

function iterConfigs(automationsDir: string): AutomationConfig[] {
  const configs: AutomationConfig[] = [];
  if (!isDir(automationsDir)) return configs;
  // Mirror `sorted(dir.glob("*/automation.toml"))`: one directory level deep,
  // sorted by full path (== sorted by subdir name given the shared prefix).
  const tomlPaths: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(automationsDir);
  } catch {
    return configs;
  }
  for (const entry of entries) {
    const sub = join(automationsDir, entry);
    if (!isDir(sub)) continue;
    const tomlPath = join(sub, AUTOMATION_TOML);
    if (isFile(tomlPath)) tomlPaths.push(tomlPath);
  }
  tomlPaths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const tomlPath of tomlPaths) {
    const config = buildConfig(tomlPath);
    if (config !== null) configs.push(config);
  }
  return configs;
}

// -- memory.md → runs ----------------------------------------------------------

function readMemoryText(path: string | null): string {
  if (path === null) return "";
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (exc) {
    logger.warn(
      `ClaudeCodeAutomationsParticipant: cannot read ${path}: ${String(exc)}`,
    );
    return "";
  }
  return text.slice(-MAX_MEMORY_CHARS);
}

function extractMemoryRuns(config: AutomationConfig): AutomationRun[] {
  const text = readMemoryText(config.memoryPath);
  if (!text) return [];

  const chunks: Array<[string, string[]]> = [];
  let currentDate = "";
  let currentLines: string[] = [];
  for (const rawLine of splitLines(text)) {
    const line = rstrip(rawLine);
    const match = RUN_HEADER_RE.exec(line.trim());
    if (match) {
      if (currentDate) chunks.push([currentDate, currentLines]);
      currentDate = match[1]!;
      const suffix = stripChars(match[2] ?? "", HEADER_SUFFIX_STRIP);
      currentLines = suffix ? [suffix] : [];
      continue;
    }
    if (currentDate) currentLines.push(line);
  }
  if (currentDate) chunks.push([currentDate, currentLines]);

  const runs: AutomationRun[] = [];
  for (const [runDate, lines] of chunks) {
    const actions = actionsFromLines(lines);
    if (actions.length === 0) continue;
    const body = actions.join(" ");
    const title = titleFromActions(config, actions);
    runs.push({
      automation: config,
      date: runDate,
      title,
      keyActions: actions,
      projects: inferProjects(body),
      signals: inferSignals(body),
    });
  }
  return runs;
}

function actionsFromLines(lines: string[]): string[] {
  const actions: string[] = [];
  for (const line of lines) {
    let cleaned = line.trim();
    if (!cleaned) continue;
    cleaned = removePrefix(cleaned, "- ").trim();
    const lowered = cleaned.toLowerCase();
    if (!cleaned || lowered.startsWith("runtime")) continue;
    if (lowered === "first run" || lowered === "follow-up") continue;
    if (lowered.startsWith("run:")) cleaned = cleaned.slice(4).trim();
    const safe = bounded(safeNativeMemoryText(cleaned), MAX_KEY_ACTION_CHARS);
    if (safe && !actions.includes(safe)) actions.push(safe);
    if (actions.length >= MAX_KEY_ACTIONS_PER_RUN) break;
  }
  return actions;
}

/** Python `str.removeprefix`. */
function removePrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

/** The oracle's `_safe_native_memory_text(v)` == `redactText(v, 180)`. */
function safeNativeMemoryText(value: string): string {
  return redactText(value, 180);
}

function titleFromActions(config: AutomationConfig, actions: string[]): string {
  if (actions.length === 0) return config.name;
  const first = actions[0]!;
  const prefix = `${config.name}: `;
  if (first.startsWith(prefix)) return bounded(first, 120);
  return bounded(prefix + first, 120);
}

function inferProjects(text: string): string[] {
  const projects: string[] = [];
  const lowered = text.toLowerCase();
  const seen = new Set<string>();
  for (const project of PROJECT_HINTS) {
    const key = project.toLowerCase();
    if (lowered.includes(key) && !seen.has(key)) {
      projects.push(project);
      seen.add(key);
    }
  }
  return projects;
}

function inferSignals(text: string): string[] {
  const signals: string[] = [];
  for (const [name, pattern] of SIGNAL_PATTERNS) {
    if (pattern.test(text)) signals.push(name);
  }
  return signals;
}

/** `" ".join(value.split())`, then cap at `limit` with a `...` tail (limit-1). */
function bounded(value: string, limit: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return rstrip(normalized.slice(0, limit - 1)) + "...";
}

// -- run → session / entities --------------------------------------------------

function sessionFromRun(run: AutomationRun): SessionModel {
  const config = run.automation;
  const keyActions = [
    `automation_id: ${config.automationId}`,
    `run: ${run.title}`,
    ...run.keyActions,
  ];
  const filesTouched = [config.path];
  if (config.memoryPath !== null) filesTouched.push(config.memoryPath);
  return makeSession({
    date: run.date,
    cwd: config.cwds.length > 0 ? config.cwds[0] : dirname(config.path),
    project_focus: [...run.projects],
    key_actions: keyActions.slice(0, MAX_KEY_ACTIONS_PER_RUN + 2),
    files_touched: filesTouched,
    visibility: Visibility.TEAM,
  });
}

function entitiesFromConfigsAndRuns(
  configs: AutomationConfig[],
  runs: AutomationRun[],
): EntityModel[] {
  // Insertion-ordered map (Python dict) — configs first, then run projects +
  // signals via setdefault (first-wins).
  const byName = new Map<string, EntityModel>();

  for (const config of configs) {
    byName.set(
      config.automationId,
      makeEntity({
        name: config.automationId,
        type: "automation",
        summary: bounded(
          `Claude Code automation '${config.name}' (${config.status}). ` +
            `Schedule: ${config.rrule || "unspecified"}.`,
          260,
        ),
        last_touched: undefined,
        tags: ["claude-code-automation", "automation", config.status.toLowerCase()],
        visibility: Visibility.TEAM,
      }),
    );
  }

  for (const run of runs) {
    for (const project of run.projects) {
      if (!byName.has(project)) {
        byName.set(
          project,
          makeEntity({
            name: project,
            type: "project",
            summary: "Project mentioned by Claude Code automation run memory.",
            last_touched: run.date,
            tags: ["claude-code-automation", "automation-evidence"],
            visibility: Visibility.TEAM,
          }),
        );
      }
    }
    for (const signal of run.signals) {
      if (!byName.has(signal)) {
        byName.set(
          signal,
          makeEntity({
            name: signal,
            type: "automation-signal",
            summary: "Signal class inferred from Claude Code automation run memory.",
            last_touched: run.date,
            tags: ["claude-code-automation", "automation-signal"],
            visibility: Visibility.TEAM,
          }),
        );
      }
    }
  }
  return [...byName.values()];
}

// -- memory.md section merge (ingestion utility) -------------------------------

/**
 * Split memory.md text into `[date_header, bullets]` sections. Tolerates
 * `2026-06-03`, `2026-06-03 -- subtitle`, and same-line `2026-06-03 run: ...`.
 * Content before the first date header is discarded.
 */
function parseMemorySections(text: string): Array<[string, string[]]> {
  const sections: Array<[string, string[]]> = [];
  let currentDate = "";
  let currentBullets: string[] = [];
  for (const rawLine of splitLines(text)) {
    const line = rstrip(rawLine);
    const match = RUN_HEADER_RE.exec(line.trim());
    if (match) {
      if (currentDate) sections.push([currentDate, currentBullets]);
      currentDate = match[1]!;
      const suffix = stripChars(match[2] ?? "", HEADER_SUFFIX_STRIP);
      currentBullets = [];
      if (suffix) currentBullets.push(suffix);
      continue;
    }
    if (!currentDate) continue;
    const bulletMatch = BULLET_RE.exec(line.trim());
    if (bulletMatch) currentBullets.push((bulletMatch[1] ?? "").trim());
  }
  if (currentDate) sections.push([currentDate, currentBullets]);
  return sections;
}

/** Render `[date, bullets]` sections back to memory.md form. */
function serializeSections(sections: Array<[string, string[]]>): string {
  const blocks: string[] = [];
  for (const [dateStr, bullets] of sections) {
    const lines = [dateStr, ...bullets.map((b) => `- ${b}`)];
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n") + "\n";
}

const AUTOMATION_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Merge an `automations/<id>/` tree from `sourceDir` into `destDir`. Copies new
 * automations wholesale (stubbing automation.toml when absent) and merges
 * memory.md bullets per-date (exact-string dedupe). Idempotent. Designed for
 * ingesting GitHub Action workflow artifacts.
 */
export function mergeAutomationTree(
  sourceDir: string,
  destDir: string,
  defaultKind = "github-action",
): MergeResult {
  if (!isDir(sourceDir)) {
    throw new Error(`merge source not found: ${sourceDir}`);
  }
  mkdirSync(destDir, { recursive: true });

  let seen = 0;
  let created = 0;
  let bulletsAdded = 0;
  let sectionsCreated = 0;
  const skipped: string[] = [];

  const srcEntries = readdirSync(sourceDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const entry of srcEntries) {
    const srcIdDir = join(sourceDir, entry);
    if (!isDir(srcIdDir)) continue;
    seen += 1;
    const automationId = entry;
    if (!AUTOMATION_ID_RE.test(automationId)) {
      skipped.push(automationId);
      continue;
    }

    const destIdDir = join(destDir, automationId);
    const srcToml = join(srcIdDir, AUTOMATION_TOML);
    const srcMemory = join(srcIdDir, MEMORY_MD);

    if (!exists(destIdDir)) {
      mkdirSync(destIdDir, { recursive: true });
      created += 1;
      if (isFile(srcToml)) {
        writeFileSync(join(destIdDir, AUTOMATION_TOML), readFileSync(srcToml, "utf8"), "utf8");
      } else {
        writeFileSync(
          join(destIdDir, AUTOMATION_TOML),
          `version = 1\n` +
            `id = "${automationId}"\n` +
            `name = "${automationId}"\n` +
            `status = "ACTIVE"\n` +
            `kind = "${defaultKind}"\n` +
            `rrule = ""\n` +
            `cwds = []\n`,
          "utf8",
        );
      }
    }

    if (!isFile(srcMemory)) continue;

    const srcSections = parseMemorySections(readFileSync(srcMemory, "utf8"));
    const destMemory = join(destIdDir, MEMORY_MD);
    const destSections: Array<[string, string[]]> = isFile(destMemory)
      ? parseMemorySections(readFileSync(destMemory, "utf8"))
      : [];
    // `dict(dest_sections)` — last-wins on duplicate dates; the list refs are
    // shared with destSections so appends via `existing` are reflected.
    const destByDate = new Map<string, string[]>();
    for (const [dateStr, bullets] of destSections) destByDate.set(dateStr, bullets);

    for (const [dateStr, bullets] of srcSections) {
      if (!destByDate.has(dateStr)) {
        const fresh: string[] = [];
        destByDate.set(dateStr, fresh);
        destSections.push([dateStr, fresh]);
        sectionsCreated += 1;
      }
      const existing = destByDate.get(dateStr)!;
      for (const bullet of bullets) {
        if (!existing.includes(bullet)) {
          existing.push(bullet);
          bulletsAdded += 1;
        }
      }
    }

    destSections.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    writeFileSync(destMemory, serializeSections(destSections), "utf8");
  }

  return {
    automationsSeen: seen,
    automationsCreated: created,
    bulletsAdded,
    sectionsCreated,
    skipped,
  };
}

// -- Participant ---------------------------------------------------------------

/** External participant for Claude Code automation memory artifacts. */
export class ClaudeCodeAutomationsParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  nativePath: string;

  private readonly automationsDir: string;
  private readonly policy: VisibilityPolicyModel;

  /**
   * Conventional Claude Code automations dir (`~/.claude/automations`). Provided
   * for protocol uniformity — the setup wizard wires the parent `claude-code`
   * participant and skips `-automations` sub-surfaces.
   */
  static defaultNativePath(home?: string): string {
    return defaultClaudeCodeAutomationsDir(home);
  }

  constructor(automationsDir?: string, claudeHome?: string) {
    this.automationsDir = automationsDir ?? defaultClaudeCodeAutomationsDir(claudeHome);
    this.nativePath = this.automationsDir;
    this.policy = DEFAULT_POLICY;
  }

  discover(): AgentStore {
    if (!isDir(this.automationsDir)) {
      throw new ParticipantDiscoveryError(
        `Claude Code automations directory not found at ${this.automationsDir}.`,
      );
    }
    const configs = iterConfigs(this.automationsDir);
    return {
      path: this.automationsDir,
      version: "unknown",
      metadata: {
        automations: configs.length,
        with_memory: configs.filter((c) => c.memoryPath !== null).length,
      },
    };
  }

  exportSessions(since?: Date, limit = 100): SessionModel[] {
    const sessions = this.runs(undefined, since).map(sessionFromRun);
    sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return sessions.slice(0, limit);
  }

  exportL5(since?: Date): L5ManifestModel {
    if (!isDir(this.automationsDir)) {
      throw new ParticipantDiscoveryError(
        `Claude Code automations directory not found at ${this.automationsDir}.`,
      );
    }
    const configs = iterConfigs(this.automationsDir);
    const runs = this.runs(configs, since);
    const sessions = runs.map(sessionFromRun);
    sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const entities = entitiesFromConfigsAndRuns(configs, runs);
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
      capabilities: ["claude-code-automation-memory", "run-summary-publication"],
      recent_sessions: sessions,
      known_entities: visibleEntities,
      visibility_policy: this.policy,
    });
  }

  healthCheck(): HealthStatus {
    if (!isDir(this.automationsDir)) {
      return {
        status: "blocked",
        reason: `Claude Code automations directory not found at ${this.automationsDir}.`,
        details: { automations_dir: this.automationsDir },
        proposedFix:
          "Create the automations directory and an automation.toml: " +
          "mkdir -p ~/.claude/automations/<id> && " +
          "$HOME/.claude/hooks/automation-memory-append.sh <id> '...'",
      };
    }
    const configs = iterConfigs(this.automationsDir);
    const runs = this.runs(configs);
    const hasConfigs = configs.length > 0;
    const status: HealthStatus["status"] = hasConfigs ? "ok" : "degraded";
    const details = {
      automations_dir: this.automationsDir,
      automation_count: configs.length,
      memory_files: configs.filter((c) => c.memoryPath !== null).length,
      runs_extracted: runs.length,
      active_automations: configs.filter((c) => c.status === "ACTIVE").length,
    };
    if (hasConfigs) {
      return { status, details };
    }
    return {
      status,
      reason: "No automation.toml files found.",
      details,
      proposedFix: "Add Claude Code automation.toml files.",
    };
  }

  private runs(configs?: AutomationConfig[], since?: Date): AutomationRun[] {
    const runCutoff = since ? since.toISOString().slice(0, 10) : null;
    const runs: AutomationRun[] = [];
    for (const config of configs ?? iterConfigs(this.automationsDir)) {
      for (const run of extractMemoryRuns(config)) {
        if (runCutoff && run.date < runCutoff) continue;
        runs.push(run);
      }
    }
    runs.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const ai = a.automation.automationId;
      const bi = b.automation.automationId;
      if (ai !== bi) return ai < bi ? 1 : -1;
      return 0;
    });
    return runs;
  }
}
