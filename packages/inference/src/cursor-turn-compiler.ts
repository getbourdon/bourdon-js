/**
 * Turn-scoped recognition compiler for Cursor. Faithful port of
 * `core/cursor_turn_compiler.py`.
 *
 * Builds a compact recognition brief for one Cursor turn from the L6 federation
 * library (cross-agent entities matching the prompt) and the workspace cwd. The
 * `+2 / +3 / +1 / +0.5` scoring adjustments are transcribed verbatim;
 * `matched_entities[].score` rounds to 2 dp; `SCHEMA_VERSION` is exact. Confidence
 * is the SHARED tier-only bucket from `@getbourdon/recognition` (cursor's raw
 * score drives ranking only). `compile_latency_us` is runtime-dependent — DROP it
 * in fixtures.
 */

import { basename } from "node:path";

import { DEFAULT_LIBRARY_PATH, L6Store } from "@getbourdon/federation";
import { meaningfulTerms, recognitionConfidence, tokenize } from "@getbourdon/recognition";

import { safeNativeMemoryText } from "./codex-state.js";

type Dict = Record<string, unknown>;

export const SCHEMA_VERSION = "cursor-turn-brief/v1";
export const STRATEGY = "turn_compiled";
export const DEFAULT_MAX_ITEMS = 6;
export const DEFAULT_MAX_CHARS = 1_800;
export const MAX_ITEMS_CEILING = 20;
export const MAX_PROMPT_CHARS = 8_000;

export interface CursorTurnBrief {
  schemaVersion: string;
  strategy: string;
  promptTokens: string[];
  cwdProject: string;
  matchedEntities: Dict[];
  routing: Record<string, string>;
  /** perf_counter micro-latency — NON-DETERMINISTIC; drop in fixtures. */
  compileLatencyUs: number;
}

export interface CompileCursorTurnOptions {
  cwd?: string | null;
  accessLevel?: string;
  libraryPath?: string | null;
  maxItems?: number;
  maxChars?: number;
  /** Injected "now" for deterministic recency (tests freeze the clock). */
  now?: Date;
}

/** Render a {@link CursorTurnBrief} to plain text (cwd project + matches + confidence). */
export function cursorBriefToText(brief: CursorTurnBrief, maxChars = DEFAULT_MAX_CHARS): string {
  const lines: string[] = [];
  if (brief.cwdProject) lines.push(`Project: ${brief.cwdProject}`);
  if (brief.matchedEntities.length > 0) {
    lines.push("Federation context:");
    for (const entity of brief.matchedEntities) {
      const name = entity.name ?? "?";
      const agent = entity.agent ?? "?";
      const summary = String(entity.summary ?? "");
      let line = `  - ${String(name)} (via ${String(agent)})`;
      if (summary) line += `: ${safeNativeMemoryText(summary, 160)}`;
      lines.push(line);
    }
  }
  const conf = brief.routing.confidence ?? "none";
  lines.push(`Confidence: ${conf}`);
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 3).replace(/\s+$/, "")}...`;
  return text;
}

function extractPromptTokens(prompt: string): string[] {
  return meaningfulTerms(prompt);
}

function projectFromCwd(cwd: string | null): string {
  if (!cwd) return "";
  const name = basename(cwd).trim();
  return name && name !== "." && name !== "/" && name !== "~" ? name : "";
}

function scoreEntity(entity: Dict, promptTokens: string[], cwdProject: string, now: Date): number {
  let score = 0.0;
  const name = String(entity.name ?? "").toLowerCase();
  const aliases = (Array.isArray(entity.aliases) ? entity.aliases : []).map((a) =>
    String(a).toLowerCase(),
  );

  // Match DECISION on NAME + ALIASES only (whole-token, not substring).
  const nameAliasTokens = new Set(tokenize(name));
  for (const alias of aliases) {
    for (const tok of tokenize(alias)) nameAliasTokens.add(tok);
  }
  const nameAliasText = `${name} ${aliases.join(" ")}`;

  for (const token of promptTokens) {
    if (nameAliasTokens.has(token)) score += 2.0;
  }
  if (cwdProject && nameAliasText.includes(cwdProject.toLowerCase())) score += 3.0;

  const lastTouched = String(entity.last_touched ?? "");
  if (lastTouched) {
    const daysAgo = isoDaysAgo(lastTouched, now);
    if (daysAgo !== null) {
      if (daysAgo <= 7) score += 1.0;
      else if (daysAgo <= 30) score += 0.5;
    }
  }
  return score;
}

/** Compile a turn-scoped Cursor recognition brief. */
export function compileCursorTurn(prompt: string, opts: CompileCursorTurnOptions = {}): CursorTurnBrief {
  const t0 = process.hrtime.bigint();
  const now = opts.now ?? new Date();

  let maxItems: number;
  const rawMax = Number(opts.maxItems ?? DEFAULT_MAX_ITEMS);
  if (Number.isFinite(rawMax)) maxItems = Math.max(1, Math.min(Math.trunc(rawMax), MAX_ITEMS_CEILING));
  else maxItems = DEFAULT_MAX_ITEMS;

  let promptText = prompt;
  if (typeof promptText === "string" && promptText.length > MAX_PROMPT_CHARS) {
    promptText = promptText.slice(0, MAX_PROMPT_CHARS);
  }

  const promptTokens = extractPromptTokens(promptText);
  const cwdProject = projectFromCwd(opts.cwd ?? null);
  const accessLevel = opts.accessLevel ?? "team";

  const lib = opts.libraryPath ? opts.libraryPath : DEFAULT_LIBRARY_PATH;
  const store = new L6Store(lib);
  const agents = store.listAgents();

  const scoredEntities: { score: number; agentId: string; entity: Dict }[] = [];
  for (const agentId of agents) {
    const manifest = store.getAgentManifest(agentId, false, accessLevel);
    if (!manifest) continue;
    const entities = Array.isArray(manifest.known_entities) ? manifest.known_entities : [];
    for (const raw of entities) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entity = raw as Dict;
      const score = scoreEntity(entity, promptTokens, cwdProject, now);
      if (score > 0) scoredEntities.push({ score, agentId, entity });
    }
  }

  // Stable sort by score desc (V8 Array.sort is stable, matching Python list.sort).
  scoredEntities.sort((a, b) => b.score - a.score);
  const top = scoredEntities.slice(0, maxItems);

  const matched: Dict[] = top.map(({ score, agentId, entity }) => ({
    name: entity.name ?? "",
    type: entity.type ?? "topic",
    agent: agentId,
    summary: entity.summary ?? "",
    score: round2(score),
  }));

  let confidence: string;
  if (matched.length === 0) {
    confidence = "none";
  } else {
    const topEntity = top[0]!.entity;
    const anchorNames = [String(topEntity.name ?? "")].concat(
      Array.isArray(topEntity.aliases) ? topEntity.aliases.map((a) => String(a)) : [],
    );
    confidence = recognitionConfidence(promptText, anchorNames);
  }

  const elapsedUs = Number(process.hrtime.bigint() - t0) / 1000;

  return {
    schemaVersion: SCHEMA_VERSION,
    strategy: STRATEGY,
    promptTokens,
    cwdProject,
    matchedEntities: matched,
    routing: { confidence, strategy: STRATEGY },
    compileLatencyUs: round1(elapsedUs),
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Days between an ISO `YYYY-MM-DD` and `now`, or null on parse failure. */
function isoDaysAgo(lastTouched: string, now: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastTouched.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const nowMid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((nowMid - ms) / 86_400_000);
}
