/**
 * Turn-scoped recognition compiler for Codex. Faithful port of
 * `core/codex_turn_compiler.py`.
 *
 * Builds a tiny, ranked recognition brief for one Codex turn from stronger
 * surfaces than native Stage 1 (cwd/repo identity, local Codex thread metadata,
 * the L6 federation library). EVERY scoring magic number is transcribed verbatim
 * from the oracle; `BriefItem.score` rounds to 1 dp; `SCHEMA_VERSION` is exact;
 * `toDict` key order is identical. The emitted `recognition_confidence` bucket is
 * the SHARED tier-only bucket from `@getbourdon/recognition` (parity stage 4) —
 * codex's richer score drives ranking + surface selection but NOT the bucket.
 *
 * Read-only: no native Codex writes, no federation mutation, no model calls.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";

import { DEFAULT_LIBRARY_PATH, L6Store } from "@getbourdon/federation";
import {
  DOMAIN_STOPWORDS_CODEX,
  MatchTier,
  matchTier,
  meaningfulTerms,
  recognitionConfidence,
  tokenize,
} from "@getbourdon/recognition";
import { stringify as yamlStringify } from "yaml";

import {
  collectLightweightSessionRecords,
  inspectCodexStateDb,
  resolveCodexHome,
  safeNativeMemoryText,
} from "./codex-state.js";

type Dict = Record<string, unknown>;

export const SCHEMA_VERSION = "codex-turn-brief/v1";
export const STRATEGY = "turn_compiled";
const ACCESS_LEVELS = new Set(["public", "team", "private"]);
const DELIVERY_MODES = new Set(["explicit", "mcp", "memory-md", "fallback", "all"]);
export const MAX_PROMPT_CHARS = 8_000;
export const DEFAULT_MAX_ITEMS = 6;
export const DEFAULT_MAX_CHARS = 1_800;
const EXHAUSTED_PATHS = [
  "native_stage1_primary",
  "static_fallback_primary",
  "l5_export_only",
  "sync_native_only",
];

const GENERIC_NAMES: ReadonlySet<string> = new Set([
  "memory",
  "memories",
  "notes",
  "project",
  "session",
  "thread",
  "workspace",
  "repo",
  "repository",
]);

// codex's score weight per shared match tier. The TOKEN_OVERLAP weight is computed
// from the overlap count below.
const TIER_PROMPT_SCORE = new Map<number, number>([
  [MatchTier.EXACT, 40.0],
  [MatchTier.NAME_SUBSTRING, 36.0],
  [MatchTier.TOKEN_SUBSEQUENCE, 30.0],
]);

// -- Public model -------------------------------------------------------------

export interface RepoIdentity {
  name: string | null;
  root: string | null;
  remote: string | null;
}

function repoToDict(repo: RepoIdentity): Dict {
  return { name: repo.name, root: repo.root, remote: repo.remote };
}

export interface BriefHealth {
  nativeStage1: string;
  strategy: string;
}

function healthToDict(h: BriefHealth): Dict {
  return { native_stage1: h.nativeStage1, strategy: h.strategy };
}

export interface BriefItem {
  rank: number;
  /** Raw total score; `toDict` rounds to 1 dp. */
  score: number;
  kind: string;
  name: string;
  summary: string;
  reason: string;
  source: string;
  sourceAgents: string[];
  evidence: string[];
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function briefItemToDict(item: BriefItem): Dict {
  return {
    rank: item.rank,
    score: round1(item.score),
    kind: item.kind,
    name: item.name,
    summary: item.summary,
    reason: item.reason,
    source: item.source,
    source_agents: item.sourceAgents,
    evidence: item.evidence,
  };
}

export interface TurnBrief {
  prompt: string;
  cwd: string | null;
  repo: RepoIdentity;
  health: BriefHealth;
  routing: Dict;
  items: BriefItem[];
  delivery: Dict;
  trace: Dict;
  diagnostics: Dict;
}

/** Serialize a {@link TurnBrief} to the canonical key-ordered dict. */
export function turnBriefToDict(brief: TurnBrief): Dict {
  return {
    schema_version: SCHEMA_VERSION,
    prompt: brief.prompt,
    cwd: brief.cwd,
    repo: repoToDict(brief.repo),
    health: healthToDict(brief.health),
    routing: brief.routing,
    items: brief.items.map(briefItemToDict),
    delivery: brief.delivery,
    trace: brief.trace,
    diagnostics: brief.diagnostics,
  };
}

export function turnBriefToYaml(brief: TurnBrief): string {
  return yamlStringify(turnBriefToDict(brief), { sortMapEntries: false });
}

export function turnBriefToJson(brief: TurnBrief): string {
  return `${JSON.stringify(turnBriefToDict(brief), null, 2)}\n`;
}

// -- Internal candidate -------------------------------------------------------

interface Candidate {
  kind: string;
  name: string;
  summary: string;
  source: string;
  sourceAgents: string[];
  aliases: string[];
  tags: string[];
  dateText: string | null;
  cwd: string | null;
  projectFocus: string[];
  filesTouched: string[];
  evidence: string[];
  nativeStage1Only: boolean;
}

type ScoredRow = { candidate: Candidate; total: number; components: Dict; reason: string };

export interface CompileCodexTurnOptions {
  cwd?: string | null;
  codexHome?: string | null;
  libraryPath?: string | null;
  accessLevel?: string;
  maxItems?: number;
  maxChars?: number;
  delivery?: string;
  /** Injected "now" for deterministic recency (tests freeze the clock). */
  now?: Date;
}

// -- Entry point --------------------------------------------------------------

/** Compile a turn-scoped Codex recognition brief. Read-only. */
export function compileCodexTurn(prompt: string, opts: CompileCodexTurnOptions = {}): TurnBrief {
  const now = opts.now ?? new Date();
  const promptText = boundedPrompt(prompt);
  const access = validateAccessLevel(opts.accessLevel ?? "team");
  const itemLimit = boundedInt(opts.maxItems ?? DEFAULT_MAX_ITEMS, 1, 20, "max_items");
  const charLimit = boundedInt(opts.maxChars ?? DEFAULT_MAX_CHARS, 400, 6_000, "max_chars");
  const deliveryMode = validateDelivery(opts.delivery ?? "all");
  const cwdPath = resolveCwd(opts.cwd ?? null);
  const cwdText = cwdPath !== null ? cwdPath : null;
  const repo = detectRepo(cwdPath);
  const scoringCwd = cwdPath !== null && isHomeLikeCwd(cwdPath) ? null : cwdPath;
  const resolvedCodexHome = opts.codexHome ? opts.codexHome : resolveCodexHome();
  const resolvedLibrary = opts.libraryPath ? opts.libraryPath : DEFAULT_LIBRARY_PATH;

  const stateReport = inspectCodexStateDb(resolvedCodexHome);
  const nativeStage1 = classifyNativeStage1(stateReport);

  const store = new L6Store(resolvedLibrary);
  const manifest = store.buildRecognitionManifest(false, access);
  const candidates = gatherCandidates(promptText, manifest, resolvedCodexHome);
  const scored = scoreCandidates(candidates, promptText, scoringCwd, repo, now);
  const items = rankItems(scored, itemLimit);
  const routing = routingDecision(items, scored, repo, nativeStage1, prompt);
  const trace = recognitionTrace(items, scored, repo, nativeStage1, routing);

  const explicitText = renderExplicitText(items, repo, nativeStage1, charLimit);
  const deliveryPayload = buildDeliveryPayload(deliveryMode, explicitText, items, repo, nativeStage1);
  const diagnostics = buildDiagnostics(scored, stateReport, deliveryMode, itemLimit, charLimit);

  return {
    prompt: promptText,
    cwd: cwdText,
    repo,
    health: { nativeStage1, strategy: STRATEGY },
    routing,
    items,
    delivery: deliveryPayload,
    trace,
    diagnostics,
  };
}

// -- Input validation / bounds ------------------------------------------------

function boundedPrompt(prompt: string): string {
  const text = String(prompt ?? "").trim();
  if (text.length > MAX_PROMPT_CHARS) return text.slice(0, MAX_PROMPT_CHARS).replace(/\s+$/, "");
  return text;
}

function validateAccessLevel(value: string): string {
  if (!ACCESS_LEVELS.has(value)) {
    throw new Error(`access_level must be one of ${[...ACCESS_LEVELS].sort().join(", ")}`);
  }
  return value;
}

function validateDelivery(value: string): string {
  if (!DELIVERY_MODES.has(value)) {
    throw new Error(`delivery must be one of ${[...DELIVERY_MODES].sort().join(", ")}`);
  }
  return value;
}

function boundedInt(value: number, minimum: number, maximum: number, name: string): number {
  const number = Math.trunc(value);
  if (number < minimum || number > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

// -- cwd / repo ---------------------------------------------------------------

function expandUser(text: string): string {
  if (text === "~") return homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return join(homedir(), text.slice(2));
  return text;
}

function resolveCwd(cwd: string | null): string | null {
  if (cwd === null) return process.cwd();
  const text = String(cwd).trim();
  if (!text) return null;
  return resolvePath(expandUser(text));
}

function detectRepo(cwd: string | null): RepoIdentity {
  if (cwd === null) return { name: null, root: null, remote: null };
  const root = findGitRoot(cwd);
  if (root === null) {
    if (isHomeLikeCwd(cwd)) return { name: null, root: null, remote: null };
    return { name: basename(cwd) || null, root: null, remote: null };
  }
  const remote = readGitOrigin(root);
  return { name: basename(root), root, remote };
}

function isHomeLikeCwd(cwd: string): boolean {
  try {
    return resolvePath(cwd) === resolvePath(homedir());
  } catch {
    return false;
  }
}

function findGitRoot(path: string): string | null {
  let current = isDirSafe(path) ? path : dirname(path);
  // walk current + ancestors
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isDirSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readGitOrigin(root: string): string | null {
  const gitPath = join(root, ".git");
  let configPath: string | null = null;
  try {
    if (statSync(gitPath).isDirectory()) configPath = join(gitPath, "config");
  } catch {
    return null;
  }
  if (configPath === null || !existsSync(configPath)) return null;
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  // Minimal INI scan for [remote "origin"] url = ...
  const lines = text.split(/\r?\n/);
  let inOrigin = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[\s*remote\s+"origin"\s*\]$/.test(line);
      continue;
    }
    if (inOrigin) {
      const m = /^url\s*=\s*(.*)$/.exec(line);
      if (m) {
        const url = (m[1] ?? "").trim();
        return url || null;
      }
    }
  }
  return null;
}

// -- native stage1 ------------------------------------------------------------

function classifyNativeStage1(report: Dict): string {
  if (!report.present) return "unknown";
  const jobs = (report.memory_stage1_jobs as Dict) ?? {};
  const byStatus = (jobs.by_status as Dict) ?? {};
  const errors = Math.trunc(Number(byStatus.error ?? 0)) || 0;
  const done = Math.trunc(Number(byStatus.done ?? 0)) || 0;
  const outputs = Math.trunc(Number((report.stage1_outputs as Dict)?.total ?? 0)) || 0;
  if (errors > 0 && errors >= done) return "degraded";
  if (done > 0 || outputs > 0) return "available";
  return "unknown";
}

// -- candidate gathering ------------------------------------------------------

function asDictList(value: unknown): Dict[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v));
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(String);
}

function safeSummary(value: string, limit = 220): string {
  return safeNativeMemoryText(value, limit);
}

function gatherCandidates(prompt: string, manifest: Dict, codexHome: string | null): Candidate[] {
  const candidates: Candidate[] = [];

  for (const entity of asDictList(manifest.known_entities)) {
    const name = String(entity.name ?? "").trim();
    if (!name) continue;
    const sourceAgents = strList(entity.source_agents);
    const source = arraysEqual(sourceAgents, ["codex"]) ? "codex_l5" : "l6_federation";
    candidates.push({
      kind: entityKind(entity),
      name,
      summary: safeSummary(String(entity.summary ?? "")),
      source,
      sourceAgents,
      aliases: strList(entity.aliases),
      tags: strList(entity.tags),
      dateText: null,
      cwd: null,
      projectFocus: [],
      filesTouched: [],
      evidence: entityEvidence(entity, sourceAgents),
      nativeStage1Only: false,
    });
  }

  for (const session of asDictList(manifest.recent_sessions)) {
    const name = sessionName(session);
    if (!name) continue;
    const agent = String(session.agent ?? "");
    const source = agent === "codex" ? "codex_l5" : "l6_federation";
    candidates.push({
      kind: "session",
      name,
      summary: safeSummary(sessionSummary(session)),
      source,
      sourceAgents: agent ? [agent] : [],
      aliases: [],
      tags: [],
      dateText: String(session.date ?? "") || null,
      cwd: typeof session.cwd === "string" ? session.cwd : null,
      projectFocus: strList(session.project_focus),
      filesTouched: strList(session.files_touched),
      evidence: sessionEvidence(session),
      nativeStage1Only: false,
    });
  }

  for (const record of collectLightweightSessionRecords(codexHome, 60)) {
    const threadName = String(record.thread_name ?? "").trim();
    if (!threadName || threadName === "(untitled)") continue;
    if (isPromptEchoThread(threadName, prompt)) continue;
    const source = record.has_rollout ? "codex_rollout" : "codex_state";
    candidates.push({
      kind: "thread",
      name: safeSummary(threadName, 120),
      summary: safeSummary(recordSummary(record)),
      source,
      sourceAgents: ["codex"],
      aliases: [],
      tags: [],
      dateText: String(record.date ?? "") || null,
      cwd: typeof record.cwd === "string" ? record.cwd : null,
      projectFocus: [],
      filesTouched: strList(record.files_touched),
      evidence: recordEvidence(record),
      nativeStage1Only: false,
    });
  }

  return dedupeCandidates(candidates, prompt);
}

function isPromptEchoThread(threadName: string, prompt: string): boolean {
  const titleTerms = meaningfulPromptTerms(threadName);
  const promptTerms = meaningfulPromptTerms(prompt);
  if (promptTerms.length === 0) return false;
  if (arraysEqual(titleTerms, promptTerms)) return true;
  if (titleTerms.length <= promptTerms.length + 3) {
    return arraysEqual(titleTerms.slice(titleTerms.length - promptTerms.length), promptTerms);
  }
  return false;
}

function entityKind(entity: Dict): string {
  const entityType = String(entity.type ?? "entity");
  if (entityType === "project" || entityType === "preference") return entityType;
  const tags = new Set(asStringRaw(entity.tags));
  if (tags.has("workflow") || tags.has("handoff")) return "handoff";
  return "entity";
}

function asStringRaw(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

function entityEvidence(entity: Dict, sourceAgents: string[]): string[] {
  const evidence: string[] = [];
  if (sourceAgents.length > 0) evidence.push(`known by ${sourceAgents.slice(0, 4).join(", ")}`);
  // _entity_evidence reads raw aliases (string entries only), not the trimmed list.
  const aliasStrings = Array.isArray(entity.aliases)
    ? entity.aliases.filter((a): a is string => typeof a === "string")
    : [];
  if (aliasStrings.length > 0) evidence.push(`aliases: ${aliasStrings.slice(0, 3).join(", ")}`);
  return evidence;
}

function sessionName(session: Dict): string {
  const focus = strList(session.project_focus);
  if (focus.length > 0) return focus[0]!;
  const actions = strList(session.key_actions);
  if (actions.length > 0) return actions[0]!;
  return "";
}

function sessionSummary(session: Dict): string {
  const actions = strList(session.key_actions);
  if (actions.length > 0) return actions.slice(0, 2).join("; ");
  const focus = strList(session.project_focus);
  if (focus.length > 0) return `Recent work focused on ${focus.slice(0, 3).join(", ")}.`;
  return "Recent federated work item.";
}

function sessionEvidence(session: Dict): string[] {
  const evidence: string[] = [];
  if (session.date) evidence.push(`session date ${String(session.date)}`);
  if (session.cwd) evidence.push(`cwd ${String(session.cwd)}`);
  const files = strList(session.files_touched);
  if (files.length > 0) evidence.push(`files touched: ${files.slice(0, 3).join(", ")}`);
  return evidence;
}

function recordSummary(record: Dict): string {
  const parts: string[] = [];
  if (record.cwd) parts.push(`cwd ${String(record.cwd)}`);
  const files = strList(record.files_touched);
  if (files.length > 0) parts.push(`touched ${files.slice(0, 3).join(", ")}`);
  const concepts = strList(record.fallback_concepts);
  if (concepts.length > 0) parts.push(`concepts ${concepts.slice(0, 3).join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "Recent Codex thread metadata.";
}

function recordEvidence(record: Dict): string[] {
  const evidence: string[] = [];
  if (record.date) evidence.push(`thread date ${String(record.date)}`);
  if (record.has_rollout) evidence.push("rollout available");
  if (record.cwd) evidence.push(`cwd ${String(record.cwd)}`);
  return evidence;
}

function dedupeCandidates(candidates: Candidate[], prompt: string): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.kind} ${candidate.name.toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, candidate);
      continue;
    }
    if (promptMatchScore(candidate, prompt)[0] > promptMatchScore(existing, prompt)[0]) {
      byKey.set(key, candidate);
      continue;
    }
    for (const agent of candidate.sourceAgents) {
      if (!existing.sourceAgents.includes(agent)) existing.sourceAgents.push(agent);
    }
    for (const evidence of candidate.evidence) {
      if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
    }
  }
  return [...byKey.values()];
}

// -- scoring ------------------------------------------------------------------

function scoreCandidates(
  candidates: Candidate[],
  prompt: string,
  cwd: string | null,
  repo: RepoIdentity,
  now: Date,
): ScoredRow[] {
  const scored: ScoredRow[] = [];
  for (const candidate of candidates) {
    const [promptScore, promptReason] = promptMatchScore(candidate, prompt);
    const [cwdScoreValue, cwdReason] = cwdScore(candidate, cwd, repo);
    const recency = recencyScore(candidate.dateText, now);
    const crossAgent = crossAgentScore(candidate.sourceAgents);
    const continuity = continuityScore(candidate, cwd, repo, now);
    const penalty = penaltyScore(candidate, now);
    const components: Dict = {
      prompt: promptScore,
      cwd_repo: cwdScoreValue,
      recency,
      cross_agent: crossAgent,
      continuity,
      penalty,
    };
    const total = promptScore + cwdScoreValue + recency + crossAgent + continuity + penalty;
    const reason = buildReason(promptReason, cwdReason, components);
    if (!passesRecognitionGate(candidate, prompt, repo, components)) continue;
    if (total <= 0) continue;
    scored.push({ candidate, total, components, reason });
  }
  scored.sort((a, b) => {
    if (a.total !== b.total) return b.total - a.total;
    const ad = dateSortValue(a.candidate.dateText);
    const bd = dateSortValue(b.candidate.dateText);
    if (ad !== bd) return bd - ad;
    const an = a.candidate.name.toLowerCase();
    const bn = b.candidate.name.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    if (a.candidate.source !== b.candidate.source) return a.candidate.source < b.candidate.source ? -1 : 1;
    return 0;
  });
  return scored;
}

function passesRecognitionGate(
  candidate: Candidate,
  prompt: string,
  repo: RepoIdentity,
  components: Dict,
): boolean {
  if (Number(components.prompt) > 0) return true;
  if (!isVagueContinuationPrompt(prompt)) return false;
  if (candidate.kind === "thread") return false;
  const repoName = (repo.name ?? "").toLowerCase();
  if (!repoName) return false;
  const semanticText = [candidate.name, candidate.summary, ...candidate.projectFocus]
    .join(" ")
    .toLowerCase();
  return new RegExp(`\\b${escapeRegExp(repoName)}\\b`).test(semanticText);
}

function isVagueContinuationPrompt(prompt: string): boolean {
  const tokens = new Set(tokenize(prompt));
  const continuationTerms = new Set([
    "continue",
    "next",
    "working",
    "work",
    "here",
    "this",
    "repo",
    "project",
    "focus",
    "resume",
    "again",
  ]);
  for (const t of tokens) {
    if (continuationTerms.has(t)) return true;
  }
  const normalized = tokenize(prompt).join(" ");
  return normalized === "what should i do" || normalized === "what should i do next";
}

function promptMatchScore(candidate: Candidate, prompt: string): [number, string] {
  const promptTerms = meaningfulPromptTerms(prompt);
  const names = [candidate.name, ...candidate.aliases, ...candidate.projectFocus];
  let best = 0.0;
  let bestName = "";
  for (const name of names) {
    if (!name.trim()) continue;
    const tier = matchTier(prompt, name, DOMAIN_STOPWORDS_CODEX);
    let score: number;
    if (TIER_PROMPT_SCORE.has(tier)) {
      score = TIER_PROMPT_SCORE.get(tier)!;
    } else if (tier === MatchTier.TOKEN_OVERLAP) {
      const nameTerms = meaningfulTerms(name, DOMAIN_STOPWORDS_CODEX);
      const overlap = intersectionSize(new Set(promptTerms), new Set(nameTerms));
      score = Math.min(24.0, overlap * 12.0);
    } else {
      score = 0.0;
    }
    if (score > best) {
      best = score;
      bestName = name;
    }
  }
  if (best) return [best, `prompt matched ${bestName}`];
  return [0.0, ""];
}

function meaningfulPromptTerms(prompt: string): string[] {
  return meaningfulTerms(prompt, DOMAIN_STOPWORDS_CODEX);
}

function cwdScore(candidate: Candidate, cwd: string | null, repo: RepoIdentity): [number, string] {
  if (cwd === null && !repo.name) return [0.0, ""];
  let score = 0.0;
  const reasons: string[] = [];
  const repoName = (repo.name ?? "").toLowerCase();
  const remote = (repo.remote ?? "").toLowerCase();
  const candidateText = [candidate.name, candidate.summary, ...candidate.projectFocus, candidate.cwd ?? ""]
    .join(" ")
    .toLowerCase();

  if (candidate.cwd && cwd) {
    const candidatePath = resolvePath(expandUser(candidate.cwd));
    if (sameOrNestedPath(candidatePath, cwd)) {
      score = Math.max(score, 25.0);
      reasons.push("cwd matched prior Codex thread");
    } else if (repo.root && sameOrNestedPath(candidatePath, repo.root)) {
      score = Math.max(score, 22.0);
      reasons.push("repo root matched prior Codex thread");
    }
  }

  if (repoName && new RegExp(`\\b${escapeRegExp(repoName)}\\b`).test(candidateText)) {
    score = Math.max(score, 18.0);
    reasons.push("repo name matched candidate");
  }
  if (repoName && remote && remote.includes(repoName) && candidate.name.toLowerCase().includes(repoName)) {
    score = Math.max(score, 14.0);
    reasons.push("git remote reinforced repo identity");
  }
  if (cwd) {
    const base = basename(cwd).toLowerCase();
    if (base && candidateText.includes(base) && !GENERIC_NAMES.has(base)) {
      score = Math.max(score, 15.0);
      reasons.push("cwd basename matched candidate");
    }
  }
  return [score, reasons.join("; ")];
}

function sameOrNestedPath(left: string, right: string): boolean {
  let L: string;
  let R: string;
  try {
    L = resolvePath(left);
    R = resolvePath(right);
  } catch {
    return false;
  }
  if (L === R) return true;
  const rel = relative(R, L);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function recencyScore(dateText: string | null, now: Date): number {
  if (!dateText) return 0.0;
  const age = ageDays(dateText, now);
  if (age === null) return 0.0;
  if (age <= 1) return 15.0;
  if (age <= 7) return 12.0;
  if (age <= 30) return 8.0;
  if (age <= 90) return 4.0;
  return 1.0;
}

function crossAgentScore(sourceAgents: string[]): number {
  const count = new Set(sourceAgents).size;
  if (count <= 1) return 0.0;
  return Math.min(10.0, 4.0 + (count - 1) * 2.0);
}

function continuityScore(
  candidate: Candidate,
  cwd: string | null,
  repo: RepoIdentity,
  now: Date,
): number {
  let score = 0.0;
  if (candidate.filesTouched.length > 0) score += 5.0;
  if ((candidate.kind === "thread" || candidate.kind === "session") && candidate.dateText) {
    score += Math.min(5.0, recencyScore(candidate.dateText, now) / 3);
  }
  if (repo.name && candidate.filesTouched.some((p) => p.toLowerCase().includes(repo.name!.toLowerCase()))) {
    score += 3.0;
  }
  if (cwd && candidate.cwd) score += 2.0;
  return Math.min(10.0, score);
}

function penaltyScore(candidate: Candidate, now: Date): number {
  let penalty = 0.0;
  if (GENERIC_NAMES.has(candidate.name.toLowerCase())) penalty -= 10.0;
  if (candidate.summary.length > 260) penalty -= 4.0;
  if (candidate.nativeStage1Only) penalty -= 8.0;
  if (candidate.source === "codex_l5" && candidate.dateText) {
    const age = ageDays(candidate.dateText, now);
    if (age !== null && age > 30) penalty -= 4.0;
  }
  return penalty;
}

// -- ranking ------------------------------------------------------------------

function rankItems(scored: ScoredRow[], maxItems: number): BriefItem[] {
  const items: BriefItem[] = [];
  scored.slice(0, maxItems).forEach((row, index) => {
    items.push({
      rank: index + 1,
      score: row.total,
      kind: row.candidate.kind,
      name: safeSummary(row.candidate.name, 120),
      summary: safeSummary(row.candidate.summary || "Recognition anchor.", 260),
      reason: row.reason,
      source: row.candidate.source,
      sourceAgents: row.candidate.sourceAgents,
      evidence: row.candidate.evidence.slice(0, 4).map((item) => safeSummary(item, 160)),
    });
  });
  return items;
}

function renderExplicitText(
  items: BriefItem[],
  repo: RepoIdentity,
  nativeStage1: string,
  maxChars: number,
): string {
  const lines = [
    "Bourdon turn recognition brief",
    `Strategy: turn-scoped compiler; native Stage 1 is ${nativeStage1}.`,
  ];
  if (repo.name) lines.push(`Repo: ${repo.name}`);
  if (items.length === 0) {
    lines.push("No high-confidence recognition anchors found for this turn.");
  } else {
    lines.push("Use these as recognition anchors, not as a final answer:");
    for (const item of items) {
      let line = `${item.rank}. ${item.name} [${item.kind}, ${item.source}, score ${item.score.toFixed(1)}]`;
      if (item.sourceAgents.length > 0) line += ` via ${item.sourceAgents.slice(0, 4).join(", ")}`;
      lines.push(line);
      lines.push(`   ${item.summary}`);
      lines.push(`   Why: ${item.reason}`);
    }
  }
  const text = lines.join("\n").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3).replace(/\s+$/, "")}...`;
}

// -- routing ------------------------------------------------------------------

function routingDecision(
  items: BriefItem[],
  scored: ScoredRow[],
  repo: RepoIdentity,
  nativeStage1: string,
  prompt: string,
): Dict {
  if (items.length === 0) {
    return {
      mode: "observe",
      primary_surface: "none",
      surfaces: [],
      confidence: "none",
      reason: "no high-confidence recognition anchors",
      suppressed_surfaces: ["native_stage1", "memory_md", "fallback_file"],
      next_action: "continue without recognition injection",
    };
  }

  const topItem = items[0]!;
  const topCandidate = scored[0]!.candidate;
  const anchorNames = [topCandidate.name, ...topCandidate.aliases, ...topCandidate.projectFocus];
  const confidence = recognitionConfidence(prompt, anchorNames);
  const surfaces = recommendedSurfaces(topItem, repo, nativeStage1);
  const suppressed = suppressedSurfaces(nativeStage1, confidence);
  return {
    mode: "inject",
    primary_surface: surfaces[0],
    surfaces,
    confidence,
    reason: routingReason(topItem, repo, nativeStage1, scored),
    suppressed_surfaces: suppressed,
    next_action: routingNextAction(surfaces[0]!),
  };
}

function recommendedSurfaces(topItem: BriefItem, repo: RepoIdentity, nativeStage1: string): string[] {
  const surfaces = ["explicit_pre_turn"];
  if (topItem.score >= 35) surfaces.push("mcp");
  if (repo.name && topItem.score >= 45) surfaces.push("repo_overlay_candidate");
  if (nativeStage1 === "available" && topItem.score >= 60) surfaces.push("native_memory_supporting");
  return surfaces;
}

function suppressedSurfaces(nativeStage1: string, confidence: string): string[] {
  const suppressed: string[] = [];
  if (nativeStage1 === "degraded") suppressed.push("native_stage1_primary");
  if (confidence === "low") suppressed.push("memory_md", "fallback_file");
  return suppressed;
}

function routingReason(
  topItem: BriefItem,
  repo: RepoIdentity,
  nativeStage1: string,
  scored: ScoredRow[],
): string {
  const sourceCount = new Set(scored.map((row) => row.candidate.source)).size;
  const pieces = [
    `top anchor scored ${topItem.score.toFixed(1)}`,
    `source mix spans ${sourceCount} surface(s)`,
  ];
  if (repo.name) pieces.push(`repo identity available as ${repo.name}`);
  if (nativeStage1 === "degraded") {
    pieces.push("native Stage 1 is degraded, so active injection is preferred");
  }
  return pieces.join("; ");
}

function routingNextAction(primarySurface: string): string {
  if (primarySurface === "explicit_pre_turn") return "prepend delivery.explicit_text before the Codex turn";
  if (primarySurface === "mcp") return "return delivery.mcp_payload to the MCP caller";
  return "use routing.surfaces to choose the strongest available channel";
}

// -- trace --------------------------------------------------------------------

function recognitionTrace(
  items: BriefItem[],
  scored: ScoredRow[],
  repo: RepoIdentity,
  nativeStage1: string,
  routing: Dict,
): Dict {
  const selectedNames = new Set(items.map((item) => `${item.kind} ${item.name.toLowerCase()}`));
  const selected: Dict[] = [];
  const ignoredSources: Dict = {};
  const candidateSourceMix: Dict = {};
  const selectedSourceMix: Dict = {};

  for (const item of items) {
    selectedSourceMix[item.source] = (Number(selectedSourceMix[item.source]) || 0) + 1;
  }

  for (const row of scored) {
    const { candidate, total, components, reason } = row;
    candidateSourceMix[candidate.source] = (Number(candidateSourceMix[candidate.source]) || 0) + 1;
    const key = `${candidate.kind} ${candidate.name.toLowerCase()}`;
    if (selectedNames.has(key)) {
      selected.push({
        name: candidate.name,
        kind: candidate.kind,
        score: round1(total),
        dominant_components: dominantComponents(components),
        reason,
      });
    } else {
      ignoredSources[candidate.source] = (Number(ignoredSources[candidate.source]) || 0) + 1;
    }
  }

  return {
    routing_decision: {
      primary_surface: routing.primary_surface,
      confidence: routing.confidence,
      reason: routing.reason,
    },
    surface_health: {
      native_stage1: nativeStage1,
      repo_identity: repo.name ? "available" : "missing",
      candidate_count: scored.length,
    },
    source_mix: {
      candidates: sortedDict(candidateSourceMix),
      selected: sortedDict(selectedSourceMix),
      ignored: sortedDict(ignoredSources),
    },
    selected_items: selected.slice(0, 10),
  };
}

function dominantComponents(components: Dict): string[] {
  const positive: [string, number][] = [];
  for (const [name, value] of Object.entries(components)) {
    if (name !== "penalty" && Number(value) > 0) positive.push([name, Number(value)]);
  }
  positive.sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return positive.slice(0, 3).map(([name]) => name);
}

// -- delivery -----------------------------------------------------------------

function buildDeliveryPayload(
  deliveryMode: string,
  explicitText: string,
  items: BriefItem[],
  repo: RepoIdentity,
  nativeStage1: string,
): Dict {
  const mcpPayload: Dict = {
    schema_version: SCHEMA_VERSION,
    strategy: STRATEGY,
    native_stage1: nativeStage1,
    repo: repoToDict(repo),
    items: items.map(briefItemToDict),
    prompt_context: explicitText,
  };
  const memoryBlock = boundedMemoryBlock(explicitText, "BOURDON TURN BRIEF");
  const fallbackBlock = boundedMemoryBlock(explicitText, "Bourdon Turn Brief");
  const repoOverlayBlock = repoOverlayBlockFn(explicitText, repo, items);
  return {
    explicit_text: deliveryMode === "explicit" || deliveryMode === "all" ? explicitText : "",
    mcp_payload: deliveryMode === "mcp" || deliveryMode === "all" ? mcpPayload : {},
    memory_md_block: deliveryMode === "memory-md" || deliveryMode === "all" ? memoryBlock : "",
    fallback_block: deliveryMode === "fallback" || deliveryMode === "all" ? fallbackBlock : "",
    repo_overlay_block: deliveryMode === "all" ? repoOverlayBlock : "",
  };
}

function repoOverlayBlockFn(explicitText: string, repo: RepoIdentity, items: BriefItem[]): string {
  if (!repo.name || items.length === 0) return "";
  const lines = [
    "<!-- BEGIN BOURDON REPO OVERLAY CANDIDATE -->",
    `Repo overlay candidate for ${repo.name}`,
  ];
  if (repo.root) lines.push(`Repo root: ${repo.root}`);
  if (repo.remote) lines.push(`Remote: ${repo.remote}`);
  lines.push(
    "Use only as an explicit, human-reviewed overlay candidate.",
    "",
    explicitText,
    "<!-- END BOURDON REPO OVERLAY CANDIDATE -->",
  );
  return lines.join("\n");
}

function boundedMemoryBlock(text: string, title: string): string {
  return `<!-- BEGIN ${title} -->\n${text}\n<!-- END ${title} -->`;
}

// -- diagnostics --------------------------------------------------------------

function buildDiagnostics(
  scored: ScoredRow[],
  stateReport: Dict,
  deliveryMode: string,
  maxItems: number,
  maxChars: number,
): Dict {
  const components: Dict = {};
  for (const row of scored.slice(0, maxItems)) {
    const rounded: Dict = {};
    for (const [key, value] of Object.entries(row.components)) {
      rounded[key] = round1(Number(value));
    }
    components[row.candidate.name] = rounded;
  }
  return {
    scoring_components: components,
    candidate_count: scored.length,
    delivery: deliveryMode,
    max_items: maxItems,
    max_chars: maxChars,
    stage1_jobs: stage1JobSummary(stateReport),
    exhausted_paths: EXHAUSTED_PATHS,
  };
}

function stage1JobSummary(stateReport: Dict): Dict {
  const jobs = (stateReport.memory_stage1_jobs as Dict) ?? {};
  const errorClasses: Dict = {};
  const errors = Array.isArray(jobs.errors) ? jobs.errors : [];
  for (const error of errors) {
    const text = String((error as Dict)?.last_error ?? "").toLowerCase();
    let key: string;
    if (text.includes("usage limit")) key = "usage_limit";
    else if (text.includes("context window") || text.includes("ran out of room")) key = "context_window";
    else if (text) key = "other";
    else key = "unknown";
    errorClasses[key] = (Number(errorClasses[key]) || 0) + 1;
  }
  return {
    total: Math.trunc(Number(jobs.total ?? 0)) || 0,
    by_status: { ...((jobs.by_status as Dict) ?? {}) },
    error_classes: sortedDict(errorClasses),
  };
}

// -- reason / misc ------------------------------------------------------------

function buildReason(promptReason: string, cwdReason: string, components: Dict): string {
  const reasons = [promptReason, cwdReason].filter((r) => r);
  if (Number(components.cross_agent) > 0) reasons.push("cross-agent agreement");
  if (Number(components.recency) >= 8) reasons.push("recent work");
  if (Number(components.continuity) > 0) reasons.push("continuity evidence");
  if (reasons.length === 0) reasons.push("weak but available recognition signal");
  return reasons.join("; ");
}

// -- date helpers -------------------------------------------------------------

function parseDateMs(dateText: string | null): number | null {
  const text = String(dateText ?? "").trim();
  if (!text) return null;
  if (text.length >= 10 && text[4] === "-" && text[7] === "-") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.slice(0, 10));
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const ms = Date.UTC(y, mo - 1, d);
    const dt = new Date(ms);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return ms;
  }
  const parsed = new Date(text.replace("Z", "+00:00"));
  if (Number.isNaN(parsed.getTime())) return null;
  return Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
}

function nowMidnightUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function ageDays(dateText: string, now: Date): number | null {
  const parsed = parseDateMs(dateText);
  if (parsed === null) return null;
  return Math.max(0, Math.floor((nowMidnightUtc(now) - parsed) / 86_400_000));
}

function dateSortValue(dateText: string | null): number {
  if (!dateText) return 0;
  const parsed = parseDateMs(dateText);
  if (parsed === null) return 0;
  return Math.floor(parsed / 86_400_000);
}

// -- tiny utils ---------------------------------------------------------------

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) {
    if (b.has(x)) n++;
  }
  return n;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sortedDict(obj: Dict): Dict {
  const out: Dict = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key];
  }
  return out;
}
