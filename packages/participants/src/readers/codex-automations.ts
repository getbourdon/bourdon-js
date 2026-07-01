/**
 * Codex automations participant — publishes read-only Codex background/automation
 * run memory into Bourdon as L5 evidence. Port of
 * `participants/codex_automations.py`.
 *
 * Store convention (NOT SQLite, NOT network): a CONVENTION-FILE directory tree at
 * `~/.codex/automations/<id>/`, each holding an `automation.toml` config and an
 * optional `memory.md` run log. The reader parses the TOML config and extracts
 * dated "runs" from the markdown memory, normalizing them into L5 sessions +
 * entities (the automation itself, plus inferred projects and signal classes).
 *
 * Source-resolution order for the automations dir:
 *   1. explicit `automationsDir` constructor arg
 *   2. `codexHome` constructor arg → `<codexHome>/automations`
 *   3. `CODEX_HOME` env-var → `$CODEX_HOME/automations`
 *   4. `~/.codex/automations`  (default convention path)
 *
 * Privacy: every native string routes through the redaction SSOT
 * (`redactText(v, 180)` == the oracle's `_safe_native_memory_text`); the
 * visibility policy filters PRIVATE entities before emission. Defensive
 * throughout — a missing dir raises {@link ParticipantDiscoveryError} from
 * `discover()`, malformed TOML/markdown degrades to empty rather than raising,
 * and `healthCheck` never throws.
 *
 * NOTE: does NOT depend on the full codex reader — only the redaction helper it
 * imports (`_safe_native_memory_text`, reproduced inline as {@link safeNativeMemoryText}).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { parse as tomlParse } from "smol-toml";

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

const AGENT_ID = "codex-automations";
const AGENT_TYPE = "other";
const ROLE_NARRATIVE =
  "Publishes read-only Codex automation run memory into Bourdon so background " +
  "monitors, digests, and recurring checks are visible alongside interactive " +
  "agent sessions.";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "health", "family", "legal"],
  team_tags: ["codex-automation", "automation", "workspace"],
});

const AUTOMATIONS_DIR_NAME = "automations";
const AUTOMATION_TOML = "automation.toml";
const MEMORY_MD = "memory.md";
const MAX_MEMORY_CHARS = 160_000;
const MAX_KEY_ACTIONS_PER_RUN = 6;
const MAX_KEY_ACTION_CHARS = 280;
const RUN_HEADER_RE = /^(\d{4}-\d{2}-\d{2})(?:\b|$)(.*)$/;
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
];
const SIGNAL_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["human-dashboard-action", /\b(human|ryan|dashboard|manual)\b/i],
  ["release-gate", /\b(release|store|app review|play console|testflight)\b/i],
  ["billing-drift", /\b(billing|stripe|revenuecat|iap|subscription)\b/i],
  ["memory-coverage-gap", /\b(memory|l5|manifest|federated|bourdon)\b/i],
  ["launch-decision", /\b(launch|go-live|pricing|prod|production)\b/i],
];

/** Minimal logger so a degraded parse is visible without pulling in a dep. */
const logger = {
  warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[bourdon.participants] ${msg}`);
  },
};

// -- Data records --------------------------------------------------------------

interface AutomationConfig {
  automationId: string;
  name: string;
  status: string;
  rrule: string;
  kind: string;
  cwds: string[];
  path: string;
  /** memory.md path, or null when absent. */
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

// -- Path resolution -----------------------------------------------------------

/** Return the default Codex automations directory (source-resolution order). */
export function defaultCodexAutomationsDir(codexHome?: string): string {
  if (codexHome !== undefined && codexHome !== null) {
    return join(codexHome, AUTOMATIONS_DIR_NAME);
  }
  const env = process.env.CODEX_HOME;
  if (env) return join(env, AUTOMATIONS_DIR_NAME);
  return join(homeDir(), ".codex", AUTOMATIONS_DIR_NAME);
}

// -- Redaction -----------------------------------------------------------------

/**
 * Thin wrapper over the redaction SSOT (the oracle's `_safe_native_memory_text`,
 * `redact_text(value, limit=180)`).
 */
function safeNativeMemoryText(value: string): string {
  return redactText(value, 180);
}

// -- Coercion helpers (mirror Python str() / truthiness) -----------------------

/** Mirror Python `str(a or b)`: use `a` when truthy, else `b`, then stringify. */
function pyStrOr(a: unknown, b: string): string {
  return String(a ? a : b);
}

// -- TOML config ---------------------------------------------------------------

/** Read + parse an automation.toml. Returns {} on any I/O or parse error. */
function readAutomationToml(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (exc) {
    logger.warn(`CodexAutomationsParticipant: cannot parse ${path}: ${String(exc)}`);
    return {};
  }
  try {
    const parsed = tomlParse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (exc) {
    logger.warn(`CodexAutomationsParticipant: cannot parse ${path}: ${String(exc)}`);
    return {};
  }
}

/** Build an AutomationConfig from a toml path. Returns null on an empty id. */
function buildConfig(tomlPath: string): AutomationConfig | null {
  const raw = readAutomationToml(tomlPath);
  const parentName = basename(dirname(tomlPath));

  const automationId = pyStrOr(raw["id"], parentName).trim();
  if (!automationId) return null;

  const name = pyStrOr(raw["name"], automationId).trim();
  const status = pyStrOr(raw["status"], "UNKNOWN").trim().toUpperCase();
  const rrule = pyStrOr(raw["rrule"], "").trim();
  const kind = pyStrOr(raw["kind"], "").trim();

  const cwdsRaw = raw["cwds"];
  const cwds: string[] = Array.isArray(cwdsRaw)
    ? cwdsRaw.filter((cwd): cwd is string => typeof cwd === "string" && cwd.trim() !== "")
    : [];

  const memoryPath = join(dirname(tomlPath), MEMORY_MD);
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

/**
 * Enumerate the `<id>/automation.toml` files, sorted (mirrors Python's sorted-glob).
 * The varying path segment is the immediate sub-directory, so sorting the
 * resulting toml paths reproduces the oracle's ordering.
 */
function iterConfigs(automationsDir: string): AutomationConfig[] {
  if (!isDir(automationsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(automationsDir);
  } catch {
    return [];
  }
  const tomlPaths: string[] = [];
  for (const entry of entries) {
    const tomlPath = join(automationsDir, entry, AUTOMATION_TOML);
    if (isFile(tomlPath)) tomlPaths.push(tomlPath);
  }
  tomlPaths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const configs: AutomationConfig[] = [];
  for (const tomlPath of tomlPaths) {
    const config = buildConfig(tomlPath);
    if (config !== null) configs.push(config);
  }
  return configs;
}

// -- Memory extraction ---------------------------------------------------------

/** Read the memory file, returning at most the last MAX_MEMORY_CHARS characters. */
function readMemoryText(path: string | null): string {
  if (path === null) return "";
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (exc) {
    logger.warn(`CodexAutomationsParticipant: cannot read ${path}: ${String(exc)}`);
    return "";
  }
  return text.length > MAX_MEMORY_CHARS ? text.slice(-MAX_MEMORY_CHARS) : text;
}

/** Split into lines the way Python's str.splitlines() does (best-effort). */
function splitLines(text: string): string[] {
  return text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
}

/** Python `str.rstrip()` — strip trailing whitespace only. */
function rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

/** Python `" ".join(value.split())` — collapse all whitespace runs. */
function collapseWhitespace(value: string): string {
  return value.split(/\s+/).filter((p) => p.length > 0).join(" ");
}

/** Port of `_bounded`: collapse whitespace then cap with a `...` ellipsis. */
function bounded(value: string, limit: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= limit) return normalized;
  return rstrip(normalized.slice(0, limit - 1)) + "...";
}

function actionsFromLines(lines: string[]): string[] {
  const actions: string[] = [];
  for (const line of lines) {
    let cleaned = line.trim();
    if (!cleaned) continue;
    cleaned = (cleaned.startsWith("- ") ? cleaned.slice(2) : cleaned).trim();
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

function titleFromActions(config: AutomationConfig, actions: string[]): string {
  if (actions.length === 0) return config.name;
  const first = actions[0] as string;
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
      currentDate = match[1] as string;
      const suffix = stripChars((match[2] as string).trim(), " -:—");
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

/** Python `str.strip(chars)` — strip any of `chars` from both ends. */
function stripChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start] as string)) start++;
  while (end > start && chars.includes(s[end - 1] as string)) end--;
  return s.slice(start, end);
}

// -- L5 assembly ---------------------------------------------------------------

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
    cwd: config.cwds.length > 0 ? (config.cwds[0] as string) : dirname(config.path),
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
  const byName = new Map<string, EntityModel>();
  for (const config of configs) {
    byName.set(
      config.automationId,
      makeEntity({
        name: config.automationId,
        type: "automation",
        summary: bounded(
          `Codex automation '${config.name}' (${config.status}). ` +
            `Schedule: ${config.rrule || "unspecified"}.`,
          260,
        ),
        last_touched: undefined,
        tags: ["codex-automation", "automation", config.status.toLowerCase()],
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
            summary: "Project mentioned by Codex automation run memory.",
            last_touched: run.date,
            tags: ["codex-automation", "automation-evidence"],
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
            summary: "Signal class inferred from Codex automation run memory.",
            last_touched: run.date,
            tags: ["codex-automation", "automation-signal"],
            visibility: Visibility.TEAM,
          }),
        );
      }
    }
  }
  return [...byName.values()];
}

// -- Participant ---------------------------------------------------------------

/**
 * External participant for Codex automation memory artifacts. Reads
 * `~/.codex/automations/<id>/{automation.toml,memory.md}` and normalizes dated
 * runs into an L5 manifest.
 */
export class CodexAutomationsParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;

  private readonly automationsDir: string;
  private readonly policy: VisibilityPolicyModel;

  /**
   * Conventional Codex automations dir (`~/.codex/automations`). Provided for
   * protocol uniformity — the setup wizard wires the parent `codex` participant
   * and skips `-automations` sub-surfaces rather than detecting this one.
   */
  static defaultNativePath(home?: string): string {
    return defaultCodexAutomationsDir(home);
  }

  constructor(automationsDir?: string, codexHome?: string) {
    this.automationsDir = automationsDir ?? defaultCodexAutomationsDir(codexHome);
    this.policy = DEFAULT_POLICY;
  }

  get nativePath(): string {
    return this.automationsDir;
  }

  discover(): AgentStore {
    if (!isDir(this.automationsDir)) {
      throw new ParticipantDiscoveryError(
        `Codex automations directory not found at ${this.automationsDir}.`,
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
      capabilities: ["codex-automation-memory", "run-summary-publication"],
      recent_sessions: sessions,
      known_entities: visibleEntities,
      visibility_policy: this.policy,
    });
  }

  healthCheck(): HealthStatus {
    if (!isDir(this.automationsDir)) {
      return {
        status: "blocked",
        reason: `Codex automations directory not found at ${this.automationsDir}.`,
        details: { automations_dir: this.automationsDir },
        proposedFix: "Create Codex automations or pass --automations-dir.",
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
      proposedFix: hasConfigs ? undefined : "Add Codex automation.toml files.",
    };
  }

  // -- Internal ---------------------------------------------------------------

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
