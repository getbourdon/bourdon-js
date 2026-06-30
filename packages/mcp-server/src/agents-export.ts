/**
 * Source-attributed agent export — faithful port of `core/agents_export.py`.
 *
 * The single place that turns a directory of `*.l5.yaml` manifests into the
 * stable, redacted `bourdon.agents/v1` JSON shape the desktop tray consumes.
 * The `export_agents` MCP tool calls `exportLocalAgents` here (NOT
 * `L6Store.exportAgents`, which serves the different federated-merge shape).
 *
 * Redaction reuses the `@getbourdon/redaction` SSOT — `_safe_native_memory_text`
 * in Python is a thin wrapper over `redact_text(value, limit=180)`, so the tray
 * never sees a raw credential regardless of session visibility. `source` /
 * `source_kind` are stamped by the caller (this machine), never read from the
 * agent's self-reported manifest.
 *
 * EGRESS visibility gate (3-Star audit P0-1): the peer-facing export path passes
 * `access_level="team"`/`"public"` so PRIVATE session content never crosses the
 * federation wire. The default `"private"` admits everything for the operator's
 * own local tray view.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { redactText } from "@getbourdon/redaction";
import { parse as yamlParse } from "yaml";

export const AGENTS_SCHEMA = "bourdon.agents/v1";
export const MAX_RECENT_SESSIONS = 10;

type Dict = Record<string, unknown>;

/**
 * Resolve this machine's label for source attribution. Honors
 * `BOURDON_LOCAL_NAME` (a deployment can pin a stable, friendly label), else
 * `os.hostname()`. Computed at call time so tests can override either source.
 */
export function resolveLocalName(): string {
  const env = process.env.BOURDON_LOCAL_NAME;
  if (env && env.trim()) return env.trim();
  return hostname();
}

/** Run a single emitted string field through the canonical redaction (limit
 * 180). Non-strings pass through untouched. */
function redactField(value: unknown): unknown {
  if (typeof value === "string") return redactText(value, 180);
  return value;
}

function redactStrList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((item) => redactText(String(item), 180));
}

const VISIBILITY_RANK: Record<string, number> = { public: 0, team: 1, private: 2 };

/** True if a session at its declared visibility is allowed at `accessLevel`.
 * Unmarked sessions default to `team` so they never escape to a public caller;
 * `accessLevel="private"` (the local default) admits everything. */
function sessionVisible(session: unknown, accessLevel: string): boolean {
  let vis = "team";
  if (session !== null && typeof session === "object" && !Array.isArray(session)) {
    const declared = String((session as Dict).visibility ?? "team").trim().toLowerCase();
    if (declared in VISIBILITY_RANK) vis = declared;
  }
  return VISIBILITY_RANK[vis]! <= (VISIBILITY_RANK[accessLevel] ?? 2);
}

function sessionDate(session: unknown): string {
  if (session !== null && typeof session === "object" && !Array.isArray(session)) {
    return String((session as Dict).date ?? "");
  }
  return "";
}

/**
 * Build one redacted, source-attributed summary from a parsed L5 manifest. The
 * canonical per-agent tray shape plus the two source-attribution fields.
 */
export function summarizeAgentManifest(
  manifest: Dict,
  opts: { source: string; sourceKind?: string; accessLevel?: string },
): Dict {
  const sourceKind = opts.sourceKind ?? "local";
  const accessLevel = opts.accessLevel ?? "private";
  const agent = (manifest.agent as Dict) || {};
  let sessions = manifest.recent_sessions;
  if (!Array.isArray(sessions)) sessions = [];

  // Stable sort by date descending (mirrors Python `sorted(..., reverse=True)`).
  const sortedSessions = [...(sessions as unknown[])].sort((a, b) => {
    const da = sessionDate(a);
    const db = sessionDate(b);
    return da < db ? 1 : da > db ? -1 : 0;
  });
  const visibleSessions = sortedSessions.filter((s) => sessionVisible(s, accessLevel));
  const recentActivity = visibleSessions.slice(0, MAX_RECENT_SESSIONS).map((session) => {
    const s = (session !== null && typeof session === "object" && !Array.isArray(session)
      ? session
      : {}) as Dict;
    return {
      date: sessionDate(session),
      project_focus: redactStrList(s.project_focus),
      key_actions: redactStrList(s.key_actions),
      visibility: String(s.visibility ?? "team"),
    };
  });
  const freshest = visibleSessions.length > 0 ? sessionDate(visibleSessions[0]) : null;

  const capabilities = manifest.capabilities;
  const roleNarrative = agent.role_narrative;

  return {
    id: redactField(String(agent.id ?? "")),
    type: redactField(String(agent.type ?? "")) || null,
    instance: redactField(String(agent.instance ?? "")) || null,
    role_narrative: roleNarrative ? redactField(String(roleNarrative)) : null,
    last_updated: manifest.last_updated ?? null,
    capability_count: Array.isArray(capabilities) ? capabilities.length : 0,
    session_count: visibleSessions.length,
    freshest_session_date: freshest || null,
    recent_activity: recentActivity,
    parse_error: null,
    source: opts.source,
    source_kind: sourceKind,
  };
}

/** Partial-failure entry so the tray can represent a broken manifest. */
export function errorAgentEntry(
  agentId: string,
  message: string,
  opts: { source: string; sourceKind?: string },
): Dict {
  return {
    id: agentId,
    type: null,
    instance: null,
    role_narrative: null,
    last_updated: null,
    capability_count: null,
    session_count: null,
    freshest_session_date: null,
    recent_activity: [],
    parse_error: message,
    source: opts.source,
    source_kind: opts.sourceKind ?? "local",
  };
}

/**
 * Summarize every local `*.l5.yaml` manifest into the tray envelope. Agents are
 * sorted by `last_updated` descending; per-manifest parse failures are
 * represented inline (`parse_error`) rather than raised, so one broken file
 * never sinks the whole export.
 */
export function exportLocalAgents(
  agentsDir: string,
  localName: string,
  accessLevel = "private",
): Dict {
  const agents: Dict[] = [];
  let isDir = false;
  try {
    isDir = statSync(agentsDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    let manifestPaths: string[] = [];
    try {
      manifestPaths = readdirSync(agentsDir)
        .filter((f) => f.endsWith(".l5.yaml"))
        .filter((f) => {
          try {
            return statSync(join(agentsDir, f)).isFile();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      manifestPaths = [];
    }
    for (const fname of manifestPaths) {
      const path = join(agentsDir, fname);
      const stem = fname.slice(0, fname.length - ".l5.yaml".length);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (exc) {
        agents.push(errorAgentEntry(stem, String(exc), { source: localName }));
        continue;
      }
      let loaded: unknown;
      try {
        loaded = yamlParse(text);
      } catch (exc) {
        agents.push(errorAgentEntry(stem, String(exc), { source: localName }));
        continue;
      }
      if (loaded === null || typeof loaded !== "object" || Array.isArray(loaded)) {
        agents.push(
          errorAgentEntry(stem, "manifest is not a YAML mapping", { source: localName }),
        );
        continue;
      }
      try {
        agents.push(
          summarizeAgentManifest(loaded as Dict, { source: localName, accessLevel }),
        );
      } catch (exc) {
        agents.push(errorAgentEntry(stem, String(exc), { source: localName }));
      }
    }
  }

  // Sort by last_updated descending (stable — preserves glob order on ties).
  agents.sort((a, b) => {
    const la = String(a.last_updated ?? "");
    const lb = String(b.last_updated ?? "");
    return la < lb ? 1 : la > lb ? -1 : 0;
  });

  return {
    schema: AGENTS_SCHEMA,
    machine: localName,
    generated_from: agentsDir,
    agents,
  };
}
