/**
 * Recognition / context helpers for the L6 MCP tools — faithful port of the
 * module-level functions in `core/l6_server.py`
 * (`prepare_recognition_context_from_store`, `_recognition_prompt_context`,
 * `get_deeper_context_for_prompt`, `compile_codex_turn_from_store`).
 *
 * Thin glue between `@getbourdon/federation` (L6Store) and
 * `@getbourdon/recognition` (recognitionFirst). No business logic of its own.
 */

import { L6Store } from "@getbourdon/federation";
import { compileCodexTurn, turnBriefToDict } from "@getbourdon/inference";
import { recognitionFirst } from "@getbourdon/recognition";
import { redactText } from "@getbourdon/redaction";

type Dict = Record<string, unknown>;

/** Thin wrapper over the redaction SSOT (MCP recognition context budget, 240). */
function safeContextText(value: string, limit = 240): string {
  return redactText(value, limit);
}

/**
 * Build the bounded prompt-context fragment from a recognition result. Iterates
 * the FULL matched-entity dicts (which carry `summary` / `source_agents`), not
 * the projected `matched_entities` field of the response.
 */
export function recognitionPromptContext(result: {
  recognition: string;
  matchedEntities: Dict[];
}): string {
  if (!result.recognition) return "";

  const lines: string[] = [
    "Bourdon recognition context",
    `Immediate recognition: ${safeContextText(result.recognition)}`,
  ];
  if (result.matchedEntities.length > 0) lines.push("Matched entities:");
  for (const entity of result.matchedEntities) {
    const name = safeContextText(String(entity.name ?? ""));
    const entityType = safeContextText(String(entity.type ?? "topic"));
    const summary = String(entity.summary ?? "").trim();
    const sourceAgents = (Array.isArray(entity.source_agents) ? entity.source_agents : []).filter(
      (a): a is string => typeof a === "string" && a.length > 0,
    );
    let line = `- ${name} (${entityType})`;
    if (sourceAgents.length > 0) line += ` via ${sourceAgents.join(", ")}`;
    if (summary) line += `: ${safeContextText(summary)}`;
    lines.push(line);
  }
  lines.push("Use this as timing-layer context, not as a final answer.");
  return lines.join("\n");
}

/**
 * Immediate recognition + a bounded prompt-context fragment from the store. The
 * recognition string is computed synchronously; `recognition_latency_us` is the
 * measured micro-latency (rounded to 1 dp, like Python). `hydration_scheduled`
 * mirrors Python's `hydration is not None` (true iff there were matches).
 */
export function prepareRecognitionContextFromStore(
  store: L6Store,
  prompt: string,
  accessLevel = "team",
  includePrivate = false,
): Dict {
  const manifest = store.buildRecognitionManifest(includePrivate, accessLevel);
  const t0 = process.hrtime.bigint();
  const result = recognitionFirst(prompt, manifest, { accessLevel });
  const latencyUs = Number(process.hrtime.bigint() - t0) / 1000;
  const hydrationScheduled = result.matchedEntities.length > 0;

  return {
    prompt,
    access_level: accessLevel,
    include_private: includePrivate,
    recognition: result.recognition,
    confidence: result.confidence,
    matched_entities: result.matchedEntities.map((entity) => ({
      name: String(entity.name ?? ""),
      type: String(entity.type ?? "topic"),
      source_agents: Array.isArray(entity.source_agents) ? [...entity.source_agents] : [],
    })),
    recognition_latency_us: Math.round(latencyUs * 10) / 10,
    hydration_scheduled: hydrationScheduled,
    prompt_context: recognitionPromptContext(result),
  };
}

/**
 * Post-recognition L2 context. The L2 retrieval layer is not part of the TS
 * mirror (Phase 6), so this returns empty context — matching the Python tool's
 * behavior when L2 is disabled/unavailable. Never raises.
 */
export function getDeeperContextForPrompt(
  prompt: string,
  accessLevel = "team",
  includePrivate = false,
): Dict {
  const context = "";
  return {
    prompt,
    access_level: accessLevel,
    include_private: includePrivate,
    context,
    context_chars: context.length,
  };
}

/**
 * The deferred stub the `mcp_snapshots` conformance fixture pins for
 * `compile_codex_turn`. Kept for back-compat: the generator special-cases this
 * tool's snapshot because its live output is environment-bound (resolves the live
 * cwd, git repo name + remote, repo-identity scoring), so it is NOT a portable
 * cross-impl parity surface. The real tool now returns a full brief at runtime
 * (matching the live Python server), so the snapshot test asserts structurally
 * rather than byte-equal to this stub.
 */
export const CODEX_TURN_DEFERRED = {
  _status: "deferred",
  schema_version: "codex-turn-brief/v1",
  reason:
    "compile_codex_turn output is environment-bound (resolves the live cwd, git " +
    "repo name + remote, and repo-identity scoring) and is not a portable " +
    "cross-impl parity fixture. The req pins the tool surface + arg defaults; the " +
    "res snapshot is this deferred stub.",
} as const;

/**
 * Return a Codex turn-scoped recognition brief using this server's store —
 * delegates to the P7 `@getbourdon/inference` turn compiler (faithful port of
 * `compile_codex_turn_from_store` in `core/l6_server.py`). The live Python server
 * returns the same full brief; only the conformance SNAPSHOT is the deferred stub.
 */
export function compileCodexTurnFromStore(
  store: L6Store,
  prompt: string,
  opts: { cwd?: string | null; accessLevel?: string; maxItems?: number; maxChars?: number } = {},
): Dict {
  const brief = compileCodexTurn(prompt, {
    cwd: opts.cwd ?? null,
    libraryPath: store.libraryPath,
    accessLevel: opts.accessLevel ?? "team",
    maxItems: opts.maxItems,
    maxChars: opts.maxChars,
    delivery: "all",
  });
  return turnBriefToDict(brief);
}
