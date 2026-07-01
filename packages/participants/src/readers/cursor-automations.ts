/**
 * Cursor automations participant — publish background agent run memory as L5
 * evidence. Port of `participants/cursor_automations.py`.
 *
 * Reads the `~/.cursor/automations/<id>/` CONVENTION (file-based, no SQLite):
 *
 *   automation.toml  — id, name, status, schedule (rrule), kind, cwds
 *   memory.md        — dated bullet entries, one block per run
 *
 * Each `automation.toml` becomes a known Entity; each dated section of
 * `memory.md` becomes a recent Session. This covers the federation gap the
 * interactive-only `cursor` participant leaves behind: Cursor Cloud Agent
 * background tasks whose work never touches the interactive SQLite state.
 *
 * Path resolution (default dir):
 *   1. explicit `cursorHome` ctor arg → `<cursorHome>/automations`
 *   2. `CURSOR_DIR` or `CURSOR_HOME` env → `<env>/automations`
 *   3. `~/.cursor/automations`
 *
 * Redaction: every native action string passes through the redaction SSOT
 * (`redactText(v, 180)` == Python `_safe_native_memory_text`). Visibility policy
 * filters PRIVATE entities BEFORE emission. `healthCheck` never throws.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const AGENT_ID = "cursor-automations";
const AGENT_TYPE = "other";
const ROLE_NARRATIVE =
  "Publishes read-only Cursor Cloud Agent automation run memory into Bourdon " +
  "so background PR reviews, code generation tasks, and scheduled agent runs " +
  "become visible alongside interactive Cursor IDE sessions.";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "health", "family", "legal"],
  team_tags: ["cursor-automation", "automation", "workspace"],
});

const AUTOMATIONS_DIR_NAME = "automations";
const AUTOMATION_TOML = "automation.toml";
const MEMORY_MD = "memory.md";
const MAX_MEMORY_CHARS = 160_000;
const MAX_KEY_ACTIONS_PER_RUN = 6;
const MAX_KEY_ACTION_CHARS = 280;

/** `^(YYYY-MM-DD)(?:\b|$)(rest)$` — matches a run-header line (post `.strip()`). */
const RUN_HEADER_RE = /^(\d{4}-\d{2}-\d{2})(?:\b|$)(.*)$/;
/** Chars stripped from a run-header suffix (space, hyphen, colon, em-dash). */
const HEADER_SUFFIX_STRIP = " -:—";

const PROJECT_HINTS: readonly string[] = [
  "ShipStable", "ILTT", "Prun", "PRUN", "OMNIvour", "Castmore",
  "Bourdon", "RADLAB", "CHIP", "Claude Brain", "Cursor", "Copilot",
  "Codex", "Cascade",
];

const SIGNAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["human-dashboard-action", /\b(human|ryan|dashboard|manual)\b/i],
  ["release-gate", /\b(release|store|app review|play console|testflight)\b/i],
  ["billing-drift", /\b(billing|stripe|revenuecat|iap|subscription)\b/i],
  ["memory-coverage-gap", /\b(memory|l5|manifest|federated|bourdon)\b/i],
  ["launch-decision", /\b(launch|go-live|pricing|prod|production)\b/i],
  ["ci-signal", /\b(github action|workflow run|ci|cd|deploy|pipeline)\b/i],
];

/** `^[-*]\s+(rest)$` — a markdown bullet line (used by the merge path). */
const BULLET_RE = /^[-*]\s+(.*)$/;
/** `^[A-Za-z0-9._-]+$` — a filesystem-safe automation id (merge validation). */
const VALID_ID_RE = /^[A-Za-z0-9._-]+$/;

// -- Data shapes ---------------------------------------------------------------

interface AutomationConfig {
  automationId: string;
  name: string;
  status: string;
  rrule: string;
  kind: string;
  cwds: string[];
  /** Absolute path to the automation.toml. */
  path: string;
  /** Absolute path to memory.md, or null when it is not a readable file. */
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

// -- Minimal logger ------------------------------------------------------------

const logger = {
  warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[bourdon.participants] ${msg}`);
  },
};

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

// -- Python-idiom helpers ------------------------------------------------------

/** Python truthiness for the scalar types read here (str / int / None). */
function pyFalsy(v: unknown): boolean {
  return v === undefined || v === null || v === "" || v === 0 || v === false;
}

/** Mirror Python `str(raw.get(key) or fallback)`. */
function strOr(v: unknown, fallback: string): string {
  return String(pyFalsy(v) ? fallback : v);
}

/** Mirror Python `str.strip(chars)` — strip a fixed char SET from both ends. */
function stripChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) start++;
  while (end > start && chars.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

/** Mirror Python `str.rstrip()` (trailing whitespace only). */
function rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

/**
 * Mirror Python `_bounded`: collapse all whitespace to single spaces, trim, and
 * cap at `limit` with a trailing ellipsis. NOTE the exact truncation form —
 * `normalized[: limit - 1].rstrip() + "..."` — which is DISTINCT from
 * `redactText`'s `limit - 3` tail. Do not conflate the two.
 */
function bounded(value: string, limit: number): string {
  const trimmed = value.trim();
  const normalized = trimmed === "" ? "" : trimmed.split(/\s+/).join(" ");
  if (normalized.length <= limit) return normalized;
  return rstrip(normalized.slice(0, limit - 1)) + "...";
}

/** `_safe_native_memory_text(v)` == `redactText(v, 180)` (positional). */
function safeNativeMemoryText(value: string): string {
  return redactText(value, 180);
}

// -- Path helpers --------------------------------------------------------------

/** Return the default Cursor automations directory. */
export function defaultCursorAutomationsDir(cursorHome?: string | null): string {
  if (cursorHome !== undefined && cursorHome !== null) {
    return join(cursorHome, AUTOMATIONS_DIR_NAME);
  }
  const env = process.env.CURSOR_DIR || process.env.CURSOR_HOME;
  if (env) return join(env, AUTOMATIONS_DIR_NAME);
  return join(homeDir(), ".cursor", AUTOMATIONS_DIR_NAME);
}

// -- TOML + memory parsing -----------------------------------------------------

function readAutomationToml(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (exc) {
    logger.warn(`CursorAutomationsParticipant: cannot parse ${path}: ${String(exc)}`);
    return {};
  }
  try {
    const parsed = parseToml(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (exc) {
    logger.warn(`CursorAutomationsParticipant: cannot parse ${path}: ${String(exc)}`);
    return {};
  }
}

function buildConfig(tomlPath: string): AutomationConfig | null {
  const raw = readAutomationToml(tomlPath);
  const parentName = basenameOf(dirname(tomlPath));
  const automationId = strOr(raw["id"], parentName).trim();
  if (!automationId) return null;
  const name = strOr(raw["name"], automationId).trim();
  const status = strOr(raw["status"], "UNKNOWN").trim().toUpperCase();
  const rrule = strOr(raw["rrule"], "").trim();
  const kind = strOr(raw["kind"], "").trim();

  const cwdsRaw = raw["cwds"];
  const cwds: string[] = [];
  if (Array.isArray(cwdsRaw)) {
    for (const cwd of cwdsRaw) {
      if (typeof cwd === "string" && cwd.trim()) cwds.push(cwd);
    }
  } else if (typeof cwdsRaw === "string") {
    for (const ch of cwdsRaw) {
      if (ch.trim()) cwds.push(ch);
    }
  }

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

/** `os.path.basename` on a (possibly trailing-slash-free) dir path. */
function basenameOf(p: string): string {
  const parts = p.split(/[\\/]+/).filter((x) => x !== "");
  return parts.length ? parts[parts.length - 1]! : "";
}

/**
 * Enumerate `<dir>/*​/automation.toml`, sorted by full path. Mirrors Python's
 * `sorted(dir.glob("*​/automation.toml"))` — pathlib's `*` does NOT match names
 * beginning with a dot, so dot-prefixed automation dirs are skipped.
 */
function iterConfigs(automationsDir: string): AutomationConfig[] {
  const configs: AutomationConfig[] = [];
  if (!isDir(automationsDir)) return configs;
  let names: string[];
  try {
    names = readdirSync(automationsDir);
  } catch {
    return configs;
  }
  const tomlPaths: string[] = [];
  for (const name of names) {
    // pathlib `Path.glob("*")` MATCHES dot-prefixed dirs — do NOT skip them.
    const tomlPath = join(automationsDir, name, AUTOMATION_TOML);
    if (isFile(tomlPath)) tomlPaths.push(tomlPath);
  }
  tomlPaths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const tomlPath of tomlPaths) {
    const config = buildConfig(tomlPath);
    if (config !== null) configs.push(config);
  }
  return configs;
}

function readMemoryText(path: string | null): string {
  if (path === null) return "";
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (exc) {
    logger.warn(`CursorAutomationsParticipant: cannot read ${path}: ${String(exc)}`);
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
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rstrip(rawLine);
    const match = RUN_HEADER_RE.exec(line.trim());
    if (match) {
      if (currentDate) chunks.push([currentDate, currentLines]);
      currentDate = match[1]!;
      const suffix = stripChars(match[2]!.trim(), HEADER_SUFFIX_STRIP);
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

// -- Merge / ingest ------------------------------------------------------------

/** Split memory.md text into (date_header, list_of_bullets) sections. */
function parseMemorySections(text: string): Array<[string, string[]]> {
  const sections: Array<[string, string[]]> = [];
  let currentDate = "";
  let currentBullets: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rstrip(rawLine);
    const match = RUN_HEADER_RE.exec(line.trim());
    if (match) {
      if (currentDate) sections.push([currentDate, currentBullets]);
      currentDate = match[1]!;
      const suffix = stripChars(match[2]!.trim(), HEADER_SUFFIX_STRIP);
      currentBullets = [];
      if (suffix) currentBullets.push(suffix);
      continue;
    }
    if (!currentDate) continue;
    const bulletMatch = BULLET_RE.exec(line.trim());
    if (bulletMatch) currentBullets.push(bulletMatch[1]!.trim());
  }
  if (currentDate) sections.push([currentDate, currentBullets]);
  return sections;
}

/** Render a list of (date, bullets) back to memory.md form. */
function serializeSections(sections: Array<[string, string[]]>): string {
  const blocks: string[] = [];
  for (const [dateStr, bullets] of sections) {
    const lines = [dateStr, ...bullets.map((b) => `- ${b}`)];
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n") + "\n";
}

/**
 * Merge an automations tree from `sourceDir` into `destDir`. Idempotent —
 * calling twice on the same source is a no-op. Throws when `sourceDir` is not a
 * directory (Python `FileNotFoundError`).
 */
export function mergeAutomationTree(
  sourceDir: string,
  destDir: string,
  defaultKind = "cursor-cloud-agent",
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

  const entries = readdirSync(sourceDir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const entryName of entries) {
    const srcIdDir = join(sourceDir, entryName);
    if (!isDir(srcIdDir)) continue;
    seen += 1;
    const automationId = entryName;
    if (!VALID_ID_RE.test(automationId)) {
      skipped.push(automationId);
      continue;
    }

    const destIdDir = join(destDir, automationId);
    const srcToml = join(srcIdDir, AUTOMATION_TOML);
    const srcMemory = join(srcIdDir, MEMORY_MD);

    if (!existsPath(destIdDir)) {
      mkdirSync(destIdDir, { recursive: true });
      created += 1;
      if (isFile(srcToml)) {
        writeFileSync(join(destIdDir, AUTOMATION_TOML), readFileSync(srcToml, "utf8"), "utf8");
      } else {
        writeFileSync(
          join(destIdDir, AUTOMATION_TOML),
          `version = 1\nid = "${automationId}"\n` +
            `name = "${automationId}"\nstatus = "ACTIVE"\n` +
            `kind = "${defaultKind}"\nrrule = ""\ncwds = []\n`,
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
    // Map date -> bullets list (SAME array refs as destSections; last wins on
    // duplicate dates, matching Python `dict(dest_sections)`).
    const destByDate = new Map<string, string[]>();
    for (const [d, b] of destSections) destByDate.set(d, b);

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

    destSections.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
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

function existsPath(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// -- Init helper ---------------------------------------------------------------

const INIT_TOML_TEMPLATE = `id = "{automation_id}"
name = "{automation_id}"
status = "ACTIVE"
rrule = ""
kind = ""
cwds = []
`;

const INIT_MEMORY_TEMPLATE = `# {automation_id}
#
# Append dated sections below. Each YYYY-MM-DD header starts a new run;
# bullets under it become key_actions in the L5 manifest.
#
# Example:
# 2026-06-01
# - Reviewed open PRs in Bourdon and ILTT.
# - No critical issues found.
`;

/** Create a starter automation directory with toml + memory.md. */
export function initAutomationsDir(
  automationsDir?: string | null,
  automationId = "cursor-cloud-agent",
  force = false,
): string {
  const base = automationsDir || defaultCursorAutomationsDir();
  const target = join(base, automationId);
  if (existsPath(target) && !force) {
    throw new Error(`${target} already exists. Pass --force to overwrite.`);
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, AUTOMATION_TOML),
    INIT_TOML_TEMPLATE.split("{automation_id}").join(automationId),
    "utf8",
  );
  writeFileSync(
    join(target, MEMORY_MD),
    INIT_MEMORY_TEMPLATE.split("{automation_id}").join(automationId),
    "utf8",
  );
  return target;
}

// -- L5 helpers ----------------------------------------------------------------

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
    cwd: config.cwds.length ? config.cwds[0]! : dirname(config.path),
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
  const entitiesByName = new Map<string, EntityModel>();
  for (const config of configs) {
    entitiesByName.set(
      config.automationId,
      makeEntity({
        name: config.automationId,
        type: "automation",
        summary: bounded(
          `Cursor automation '${config.name}' (${config.status}). ` +
            `Schedule: ${config.rrule || "unspecified"}.`,
          260,
        ),
        last_touched: null,
        tags: ["cursor-automation", "automation", config.status.toLowerCase()],
        visibility: Visibility.TEAM,
      }),
    );
  }
  for (const run of runs) {
    for (const project of run.projects) {
      if (!entitiesByName.has(project)) {
        entitiesByName.set(
          project,
          makeEntity({
            name: project,
            type: "project",
            summary: "Project mentioned by Cursor automation run memory.",
            last_touched: run.date,
            tags: ["cursor-automation", "automation-evidence"],
            visibility: Visibility.TEAM,
          }),
        );
      }
    }
    for (const signal of run.signals) {
      if (!entitiesByName.has(signal)) {
        entitiesByName.set(
          signal,
          makeEntity({
            name: signal,
            type: "automation-signal",
            summary: "Signal class inferred from Cursor automation run memory.",
            last_touched: run.date,
            tags: ["cursor-automation", "automation-signal"],
            visibility: Visibility.TEAM,
          }),
        );
      }
    }
  }
  return [...entitiesByName.values()];
}

/** `datetime.now(timezone.utc).isoformat(timespec="seconds")` form. */
function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

// -- Participant ---------------------------------------------------------------

/** External participant for Cursor Cloud Agent automation memory artifacts. */
export class CursorAutomationsParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;

  private readonly automationsDir: string;
  private readonly policy: VisibilityPolicyModel;

  constructor(automationsDir?: string | null, cursorHome?: string | null) {
    this.automationsDir =
      automationsDir || defaultCursorAutomationsDir(cursorHome ?? undefined);
    this.policy = DEFAULT_POLICY;
  }

  get nativePath(): string {
    return this.automationsDir;
  }

  discover(): AgentStore {
    if (!isDir(this.automationsDir)) {
      throw new ParticipantDiscoveryError(
        `Cursor automations directory not found at ${this.automationsDir}.`,
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
      last_updated: nowIsoSeconds(),
      capabilities: ["cursor-automation-memory", "run-summary-publication"],
      recent_sessions: sessions,
      known_entities: visibleEntities,
      visibility_policy: this.policy,
    });
  }

  healthCheck(): HealthStatus {
    if (!isDir(this.automationsDir)) {
      return {
        status: "blocked",
        reason: `Cursor automations directory not found at ${this.automationsDir}.`,
        details: { automations_dir: this.automationsDir },
        proposedFix: "Create Cursor automations or pass --automations-dir.",
      };
    }
    const configs = iterConfigs(this.automationsDir);
    const runs = this.runs(configs);
    const hasConfigs = configs.length > 0;
    const details = {
      automations_dir: this.automationsDir,
      automation_count: configs.length,
      memory_files: configs.filter((c) => c.memoryPath !== null).length,
      runs_extracted: runs.length,
      active_automations: configs.filter((c) => c.status === "ACTIVE").length,
    };
    if (hasConfigs) {
      return { status: "ok", details };
    }
    return {
      status: "degraded",
      reason: "No automation.toml files found.",
      details,
      proposedFix: "Add Cursor automation.toml files.",
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
    // Sort by (date, automationId) DESCENDING (Python reverse=True on the tuple).
    runs.sort((a, b) => {
      if (a.date !== b.date) return a.date > b.date ? -1 : 1;
      const ai = a.automation.automationId;
      const bi = b.automation.automationId;
      return ai > bi ? -1 : ai < bi ? 1 : 0;
    });
    return runs;
  }
}
