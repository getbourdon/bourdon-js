/**
 * Federation access enforcement — the trust-tier decision logic + the
 * peer-access clamps.
 *
 * Ported from the enforcement closures in `core/l6_server.py` (the gating that
 * the conformance `tier_matrix.json` pins) plus `_clamp_peer_access`. The MCP
 * server (`@getbourdon/mcp-server`, Phase 6) consumes these so the wire surface
 * and this package agree on every decision; the conformance suite asserts the
 * decisions here reproduce the Python oracle.
 *
 * Security invariants preserved IN CODE:
 *  - INGRESS clamp (`clampPeerAccess`): a federation-originated request
 *    (federation_hop > 0) can never extract PRIVATE memory — force
 *    include_private off + cap access_level at "team" (3-Star P1-2).
 *  - Tier gating: quarantined callers are denied the aggregate tools wholesale
 *    and may only read granted namespaces / write their own.
 *  - Structured-denial shape is byte-stable: {error, op, agent, tier, detail};
 *    list_recent_work denials additionally fold an empty page.
 */

import { AgentIdentity } from "./identity.js";

const ACCESS_RANK: Record<string, number> = { public: 0, team: 1, private: 2 };

/**
 * Clamp a peer-originated request so it can never extract PRIVATE memory.
 * Force include_private off and cap access_level at "team". Returns
 * `[cappedAccessLevel, false]`.
 */
export function clampPeerAccess(
  accessLevel: string,
  _includePrivate: boolean,
): [string, boolean] {
  let capped = accessLevel;
  const rank = ACCESS_RANK[accessLevel] ?? ACCESS_RANK.private!;
  if (rank > ACCESS_RANK.team!) capped = "team";
  return [capped, false];
}

/** Egress visibility cap for `export_agents` (3-Star P0-1): a trusted peer may
 * see team; a quarantined caller only public. PRIVATE never crosses the wire. */
export function exportEgressAccess(caller: AgentIdentity): "team" | "public" {
  return caller.isTrusted ? "team" : "public";
}

// -- Tier-matrix enforcement ---------------------------------------------------

/** Tools a quarantined caller may NOT call at all. */
const QUARANTINE_BLOCKED_TOOLS = new Set([
  "get_cross_agent_summary",
  "prepare_recognition_context",
  "get_deeper_context",
  "compile_codex_turn",
]);

export interface Denial {
  error: "access denied";
  op: string;
  agent: string;
  tier: string;
  detail: string;
  // list_recent_work folds an empty page into the denial.
  sessions?: never[];
  next_cursor?: null;
  has_more?: false;
}

export interface EnforcementDecision {
  decision: "allow" | "deny";
  denial: Denial | null;
}

function denied(
  op: string,
  caller: AgentIdentity,
  detail = "tier 'quarantined' may not call this tool",
  foldEmptyPage = false,
): EnforcementDecision {
  const denial: Denial = {
    error: "access denied",
    op,
    agent: caller.agentId,
    tier: caller.tier,
    detail,
  };
  if (foldEmptyPage) {
    denial.sessions = [];
    denial.next_cursor = null;
    denial.has_more = false;
  }
  return { decision: "deny", denial };
}

const ALLOW: EnforcementDecision = { decision: "allow", denial: null };

/** Python `repr()` of a simple string: single-quoted. The tier_matrix detail
 * strings are built with Python `{x!r}`, so a verbatim match needs single
 * quotes, not JSON double quotes. Agent ids / namespaces are
 * `^[a-z0-9][a-z0-9_-]*$` so no escaping is needed. */
function pyRepr(s: string): string {
  return `'${s}'`;
}

/**
 * Decide whether `caller` may invoke `tool` with `args`, reproducing the
 * `core.l6_server` gating that `tier_matrix.json` pins. Pure function: no I/O,
 * no store access — the namespace checks only need the caller's grants and the
 * tool args (`agent` / `agent_id`).
 */
export function enforceToolAccess(
  tool: string,
  caller: AgentIdentity,
  args: Record<string, unknown> = {},
): EnforcementDecision {
  // Trusted callers (OPERATOR / trusted peers) pass every tool gate; per-row
  // visibility filtering still applies downstream but never flips the decision.
  if (caller.isTrusted) return ALLOW;

  // Aggregate tools: denied to quarantined callers wholesale.
  if (QUARANTINE_BLOCKED_TOOLS.has(tool)) {
    return denied(tool, caller);
  }

  switch (tool) {
    case "query_agent_memory": {
      const namespace = String(args.agent ?? "");
      if (!caller.mayRead(namespace)) {
        return denied(tool, caller, `namespace ${pyRepr(namespace)} not granted`);
      }
      return ALLOW;
    }
    case "list_recent_work": {
      const agent = args.agent;
      if (agent !== null && agent !== undefined) {
        const namespace = String(agent);
        if (!caller.mayRead(namespace)) {
          return denied(tool, caller, `namespace ${pyRepr(namespace)} not granted`, true);
        }
      }
      return ALLOW;
    }
    case "commit_to_federation": {
      const agentId = String(args.agent_id ?? "");
      if (agentId !== caller.agentId) {
        return denied(
          tool,
          caller,
          `quarantined members may only write their own namespace (${pyRepr(caller.agentId)})`,
        );
      }
      return ALLOW;
    }
    // find_entity, list_agents, export_agents: allowed; results are
    // visibility-/grant-filtered downstream, but the call itself is permitted.
    default:
      return ALLOW;
  }
}
