/**
 * GitHub Copilot · Automations participant — convention-file reader. Port of
 * `participants/copilot_automations.py`.
 *
 * GitHub Copilot can be triggered by GitHub Actions workflows, scheduled tasks,
 * and event-driven automations (issue triage, PR review, etc.). These run on a
 * separate memory surface from both the CLI agent and the VS Code extension.
 * Copilot automations have no standardized local state dump, so — mirroring the
 * codex-automations reader — this participant uses a CONVENTION directory:
 *
 *   ~/.copilot-bourdon/automations/<automation-id>/
 *       automation.toml   — id, name, status, trigger, kind, repos
 *       memory.md         — dated bullet entries, one block per run
 *
 * Each `automation.toml` describes a recurring automation; each dated section of
 * `memory.md` captures what happened in that run. Users or CI scripts maintain
 * these files.
 *
 * Path resolution (matches the oracle):
 *   1. `COPILOT_AUTOMATIONS_HOME` env-var override (verbatim, → /automations skipped:
 *      the override IS the automations dir).
 *   2. `~/.copilot-bourdon/automations/` (default convention path).
 *
 * Defensive throughout: a missing automations directory raises
 * {@link ParticipantDiscoveryError} from `discover()`; a malformed
 * `automation.toml` or unreadable `memory.md` is logged and skipped rather than
 * raising; `healthCheck` never throws.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import { parse as parseToml } from "smol-toml";

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

const AGENT_ID = "copilot-automations";
const AGENT_TYPE = "other";
const DISPLAY_NAME = "GitHub Copilot · Automations";
const ROLE_NARRATIVE =
  "Publishes read-only Copilot automation run memory into Bourdon so " +
  "GitHub Actions-triggered Copilot tasks, scheduled PR reviews, issue " +
  "triage, and other event-driven Copilot work are visible alongside " +
  "interactive agent sessions.";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "health", "family", "legal"],
  team_tags: ["copilot-automation", "automation", "github-actions", "workspace"],
});

const CONVENTION_DIR_NAME = ".copilot-bourdon";
const AUTOMATIONS_DIR = "automations";
const AUTOMATION_TOML = "automation.toml";
const MEMORY_MD = "memory.md";
const MAX_MEMORY_CHARS = 160_000;
const MAX_KEY_ACTIONS_PER_RUN = 6;
const MAX_KEY_ACTION_CHARS = 280;
/** `^(\d{4}-\d{2}-\d{2})(?:\b|$)(.*)$` — the dated run header. */
const RUN_HEADER_RE = /^(\d{4}-\d{2}-\d{2})(?:\b|$)(.*)$/;

/** Starter template for `bourdon copilot-automations init`. */
const AUTOMATION_TOML_TEMPLATE = `# Copilot Automation definition
# Edit this file to describe a recurring Copilot automation.

id = "{automation_id}"
name = "{name}"
status = "ACTIVE"
trigger = "workflow_dispatch"  # or: schedule, issue_comment, pull_request, etc.
kind = "pr-review"           # or: issue-triage, code-generation, test-review, etc.
repos = []                   # list of repositories this automation targets
`;

const MEMORY_MD_TEMPLATE = `# {name} — Run Memory

Record automation run outcomes here. Each dated section is parsed by Bourdon.

# Format:
# YYYY-MM-DD <optional title>
# - bullet point of what happened
# - another action or outcome

`;

/** Minimal logger so a degraded parse is visible without pulling in a dep
 * (matches the sibling readers' logging idiom). */
const logger = {
  warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[bourdon.participants] ${msg}`);
  },
};

// -- Records -------------------------------------------------------------------

interface AutomationConfig {
  automationId: string;
  name: string;
  status: string;
  trigger: string;
  kind: string;
  repos: string[];
  path: string;
  memoryPath: string | null;
}

interface AutomationRun {
  automation: AutomationConfig;
  date: string;
  title: string;
  keyActions: string[];
  repos: string[];
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python truthiness for the scalar/array types TOML yields. */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "string") return v.length > 0;
  if (typeof v === "number") return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Mirror Python `str(value)` for the value types encountered here. */
function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null || v === undefined) return "None";
  return String(v);
}

// -- Path helpers --------------------------------------------------------------

/**
 * Return the conventional `~/.copilot-bourdon/automations/` directory. Respects
 * the `COPILOT_AUTOMATIONS_HOME` env-var override (returned verbatim — the
 * override IS the automations dir, no `/automations` suffix is appended).
 */
export function defaultCopilotAutomationsDir(copilotBourdonDir?: string | null): string {
  const env = process.env.COPILOT_AUTOMATIONS_HOME;
  if (env) return env;
  const base = copilotBourdonDir || join(homeDir(), CONVENTION_DIR_NAME);
  return join(base, AUTOMATIONS_DIR);
}

// -- Config / memory parsing ---------------------------------------------------

function readAutomationToml(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (exc) {
    logger.warn(`CopilotAutomationsParticipant: cannot parse ${path}: ${String(exc)}`);
    return {};
  }
  try {
    const parsed = parseToml(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (exc) {
    logger.warn(`CopilotAutomationsParticipant: cannot parse ${path}: ${String(exc)}`);
    return {};
  }
}

function buildConfig(tomlPath: string): AutomationConfig | null {
  const raw = readAutomationToml(tomlPath);
  const parentDir = dirname(tomlPath);
  const parentName = parentDir.split(/[\\/]/).filter(Boolean).pop() ?? "";

  const automationId = pyStr(pyTruthy(raw["id"]) ? raw["id"] : parentName).trim();
  if (!automationId) return null;

  const name = pyStr(pyTruthy(raw["name"]) ? raw["name"] : automationId).trim();
  const status = pyStr(pyTruthy(raw["status"]) ? raw["status"] : "UNKNOWN")
    .trim()
    .toUpperCase();
  const trigger = pyStr(pyTruthy(raw["trigger"]) ? raw["trigger"] : "").trim();
  const kind = pyStr(pyTruthy(raw["kind"]) ? raw["kind"] : "").trim();

  const reposRaw = pyTruthy(raw["repos"]) ? raw["repos"] : [];
  const reposIter: unknown[] = Array.isArray(reposRaw)
    ? reposRaw
    : typeof reposRaw === "string"
      ? Array.from(reposRaw)
      : [];
  const repos = reposIter.filter(
    (r): r is string => typeof r === "string" && r.trim() !== "",
  );

  const memoryPath = join(parentDir, MEMORY_MD);
  return {
    automationId,
    name,
    status,
    trigger,
    kind,
    repos,
    path: tomlPath,
    memoryPath: isFile(memoryPath) ? memoryPath : null,
  };
}

function iterConfigs(automationsDir: string): AutomationConfig[] {
  const configs: AutomationConfig[] = [];
  if (!isDir(automationsDir)) return configs;

  let entries: string[];
  try {
    entries = readdirSync(automationsDir);
  } catch {
    return configs;
  }

  // Mirror `sorted(Path.glob("*/automation.toml"))`: one directory level deep,
  // sorted by path. NOTE pathlib glob MATCHES dot-prefixed dirs (unlike shell
  // glob / glob.glob) — do NOT skip them, or dot-named automations under-report.
  const tomlPaths: string[] = [];
  for (const entry of entries) {
    const candidate = join(automationsDir, entry, AUTOMATION_TOML);
    if (isFile(candidate)) tomlPaths.push(candidate);
  }
  tomlPaths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const tomlPath of tomlPaths) {
    const config = buildConfig(tomlPath);
    if (config !== null) configs.push(config);
  }
  return configs;
}

/** Python `str.splitlines()` for the common line boundaries. Empty input → []. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/);
}

/** Python `str.rstrip()` — strip trailing whitespace. */
function rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Python `str.strip(chars)` — strip the given char set from both ends. */
function stripChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) start++;
  while (end > start && chars.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

function extractMemoryRuns(config: AutomationConfig): AutomationRun[] {
  if (config.memoryPath === null) return [];
  let text: string;
  try {
    text = readFileSync(config.memoryPath, "utf8");
  } catch (exc) {
    logger.warn(
      `CopilotAutomationsParticipant: cannot read ${config.memoryPath}: ${String(exc)}`,
    );
    return [];
  }

  text = text.slice(-MAX_MEMORY_CHARS);
  const chunks: Array<[string, string[]]> = [];
  let currentDate = "";
  let currentLines: string[] = [];

  for (const rawLine of splitLines(text)) {
    const line = rstrip(rawLine);
    const match = RUN_HEADER_RE.exec(line.trim());
    if (match) {
      if (currentDate) chunks.push([currentDate, currentLines]);
      currentDate = match[1]!;
      const suffix = stripChars((match[2] ?? "").trim(), " -:—");
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
    const title = titleFromActions(config, actions);
    runs.push({
      automation: config,
      date: runDate,
      title,
      keyActions: actions,
      repos: config.repos,
    });
  }
  return runs;
}

function actionsFromLines(lines: string[]): string[] {
  const actions: string[] = [];
  for (const line of lines) {
    let cleaned = line.trim();
    if (!cleaned) continue;
    cleaned = (cleaned.startsWith("- ") ? cleaned.slice(2) : cleaned).trim();
    if (!cleaned || cleaned.toLowerCase().startsWith("runtime")) continue;
    const safe = bounded(safeNativeMemoryText(cleaned), MAX_KEY_ACTION_CHARS);
    if (safe && !actions.includes(safe)) actions.push(safe);
    if (actions.length >= MAX_KEY_ACTIONS_PER_RUN) break;
  }
  return actions;
}

function titleFromActions(config: AutomationConfig, actions: string[]): string {
  if (actions.length === 0) return config.name;
  const first = actions[0]!;
  const prefix = `${config.name}: `;
  if (first.startsWith(prefix)) return bounded(first, 120);
  return bounded(prefix + first, 120);
}

/** `" ".join(value.split())` + ellipsis truncation. */
function bounded(value: string, limit: number): string {
  const normalized = value.split(/\s+/u).filter((x) => x.length > 0).join(" ");
  if (normalized.length <= limit) return normalized;
  return rstrip(normalized.slice(0, limit - 1)) + "…";
}

/** Python `_safe_native_memory_text(v)` == `redactText(v, 180)`. */
function safeNativeMemoryText(value: string): string {
  return redactText(value, 180);
}

// -- Conversion to Bourdon types ----------------------------------------------

function sessionFromRun(run: AutomationRun): SessionModel {
  const config = run.automation;
  const keyActions = [
    `automation: ${config.automationId}`,
    config.trigger ? `trigger: ${config.trigger}` : `kind: ${config.kind}`,
    `run: ${run.title}`,
    ...run.keyActions,
  ];
  return makeSession({
    date: run.date,
    cwd: dirname(config.path),
    project_focus: [...run.repos],
    key_actions: keyActions.slice(0, MAX_KEY_ACTIONS_PER_RUN + 3),
    files_touched: [config.path],
    visibility: Visibility.TEAM,
  });
}

function entitiesFromConfigsAndRuns(
  configs: AutomationConfig[],
  runs: AutomationRun[],
): EntityModel[] {
  const entities = new Map<string, EntityModel>();

  for (const config of configs) {
    entities.set(
      config.automationId,
      makeEntity({
        name: config.automationId,
        type: "automation",
        summary: bounded(
          `Copilot automation '${config.name}' (${config.status}). ` +
            `Trigger: ${config.trigger || "unspecified"}. ` +
            `Kind: ${config.kind || "unspecified"}.`,
          260,
        ),
        last_touched: undefined,
        tags: ["copilot-automation", "automation", config.status.toLowerCase()],
        visibility: Visibility.TEAM,
      }),
    );
  }

  // Repos mentioned across all runs (setdefault: first-write-wins).
  for (const run of runs) {
    for (const repo of run.repos) {
      if (!entities.has(repo)) {
        entities.set(
          repo,
          makeEntity({
            name: repo,
            type: "project",
            summary: "Repository targeted by Copilot automation.",
            last_touched: run.date,
            tags: ["copilot-automation", "project"],
            visibility: Visibility.TEAM,
          }),
        );
      }
    }
  }

  return [...entities.values()];
}

// -- Participant ---------------------------------------------------------------

/**
 * Convention-based Bourdon participant for Copilot automation memory artifacts.
 * Users or CI scripts maintain `automation.toml` + `memory.md` files at
 * `~/.copilot-bourdon/automations/<id>/`.
 */
export class CopilotAutomationsParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  displayName = DISPLAY_NAME;

  private readonly automationsDir: string;
  private readonly policy: VisibilityPolicyModel;

  /** Conventional automations dir (`~/.copilot-bourdon/automations`). Does NOT
   * consult `COPILOT_AUTOMATIONS_HOME` (matches Python `default_native_path`). */
  static defaultNativePath(home?: string): string {
    const base = join(home ?? homeDir(), CONVENTION_DIR_NAME);
    return join(base, AUTOMATIONS_DIR);
  }

  constructor(automationsDir?: string | null) {
    this.automationsDir = automationsDir ?? defaultCopilotAutomationsDir();
    this.policy = DEFAULT_POLICY;
  }

  get nativePath(): string {
    return this.automationsDir;
  }

  // -- Protocol surface -------------------------------------------------------

  discover(): AgentStore {
    if (!isDir(this.automationsDir)) {
      throw new ParticipantDiscoveryError(
        `Copilot automations directory not found at ${this.automationsDir}. ` +
          "Run `bourdon copilot-automations init <name>` to create one.",
      );
    }
    const configs = iterConfigs(this.automationsDir);
    return {
      path: this.automationsDir,
      version: "convention-v1",
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
        instance: hostname() || "unknown",
        spec_version_compat: `>=${SPEC_VERSION}`,
        role_narrative: ROLE_NARRATIVE,
      }),
      last_updated: new Date().toISOString(),
      capabilities: ["copilot-automation-memory", "run-summary-publication"],
      recent_sessions: sessions,
      known_entities: visibleEntities,
      visibility_policy: this.policy,
    });
  }

  healthCheck(): HealthStatus {
    if (!isDir(this.automationsDir)) {
      return {
        status: "blocked",
        reason: `Copilot automations directory not found at ${this.automationsDir}.`,
        details: { automations_dir: this.automationsDir },
        proposedFix:
          "Run `bourdon copilot-automations init <name>` to create an automation.",
      };
    }
    const configs = iterConfigs(this.automationsDir);
    const runs = this.runs(configs);
    const hasConfigs = configs.length > 0;
    return {
      status: hasConfigs ? "ok" : "degraded",
      reason: hasConfigs ? undefined : "No automation.toml files found.",
      details: {
        automations_dir: this.automationsDir,
        automation_count: configs.length,
        memory_files: configs.filter((c) => c.memoryPath !== null).length,
        runs_extracted: runs.length,
        active_automations: configs.filter((c) => c.status === "ACTIVE").length,
      },
      proposedFix: hasConfigs
        ? undefined
        : "Run `bourdon copilot-automations init <name>` to create an automation, " +
          "or add automation.toml files manually.",
    };
  }

  // -- Internal ---------------------------------------------------------------

  private runs(configs?: AutomationConfig[], since?: Date): AutomationRun[] {
    const runCutoff = since ? since.toISOString().slice(0, 10) : null;
    const out: AutomationRun[] = [];
    for (const config of configs ?? iterConfigs(this.automationsDir)) {
      for (const run of extractMemoryRuns(config)) {
        if (runCutoff && run.date < runCutoff) continue;
        out.push(run);
      }
    }
    // sorted(key=(date, automation_id), reverse=True)
    out.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const ai = a.automation.automationId;
      const bi = b.automation.automationId;
      if (ai !== bi) return ai < bi ? 1 : -1;
      return 0;
    });
    return out;
  }
}

// -- Init helper ---------------------------------------------------------------

/**
 * Create an automation scaffold at `<automationsDir>/<id>/`. Returns the path
 * of the created automation directory. Throws when `automation.toml` already
 * exists unless `force` is true.
 */
export function initAutomation(
  automationsDir?: string | null,
  automationId = "my-automation",
  name = "My Copilot Automation",
  force = false,
): string {
  const targetDir = join(automationsDir || defaultCopilotAutomationsDir(), automationId);
  const tomlPath = join(targetDir, AUTOMATION_TOML);
  const memoryPath = join(targetDir, MEMORY_MD);

  if (isFile(tomlPath) && !force) {
    throw new Error(`${tomlPath} already exists. Pass --force to overwrite.`);
  }

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(
    tomlPath,
    AUTOMATION_TOML_TEMPLATE.replace("{automation_id}", automationId).replace(
      "{name}",
      name,
    ),
    "utf8",
  );
  if (!isFile(memoryPath) || force) {
    writeFileSync(memoryPath, MEMORY_MD_TEMPLATE.replace("{name}", name), "utf8");
  }
  return targetDir;
}
