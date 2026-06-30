/**
 * Bourdon L6 — MCP server (faithful port of `core/l6_server.py`).
 *
 * Wraps `@getbourdon/federation`'s `L6Store` in an `@modelcontextprotocol/sdk`
 * `McpServer` so any MCP-aware agent (Claude Code, Codex, Cursor) can query the
 * federation natively. Registers the SAME 10 tools + 3 resources as the Python
 * server, with byte-identical names, arg names, and defaults (the public/team
 * `access_level` split is reproduced exactly).
 *
 * WIRE ENCODING — the single highest-risk port detail: every tool handler
 * returns `{ content: [{ type: "text", text: JSON.stringify(payload) }] }`, NOT
 * the SDK's default structured content. The Python `RemoteL6Client` (and
 * `@getbourdon/client`) recover the payload with `json.loads(item.text)` /
 * `JSON.parse(text)`. Returning structured content instead makes a Python peer's
 * `json.loads(item.text)` get `None` and silently breaks mixed-language
 * federation. Each tool closure builds a plain object; `jsonContent` stringifies
 * it onto the wire.
 *
 * Caller identity arrives via the AsyncLocalStorage binding (`getCaller()` from
 * `@getbourdon/federation`): the HTTP auth middleware binds the resolved
 * identity for the request subtree; stdio has no binding and resolves to
 * OPERATOR (trusted) — exactly v0.8.0 behavior. Quarantined callers get an
 * allowlisted read surface (granted namespaces) and STAGED writes; every call is
 * audited, allow and deny alike.
 */

import {
  type AgentIdentity,
  type EntityMatch,
  FederationAudit,
  FederationRegistry,
  L6Store,
  TIER_QUARANTINED,
  clampPeerAccess,
  getCaller,
  mergeIntoStaged,
} from "@getbourdon/federation";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { join as pathJoin } from "node:path";
import { z } from "zod";

import {
  exportLocalAgents,
  resolveLocalName,
} from "./agents-export.js";
import {
  compileCodexTurnFromStore,
  getDeeperContextForPrompt,
  prepareRecognitionContextFromStore,
} from "./recognition-context.js";

const DECISION_ALLOW = "allow";
const DECISION_DENY = "deny";

type Dict = Record<string, unknown>;

/** Build the JSON-in-TextContent envelope (the wire contract). */
function jsonContent(payload: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Build the JSON-in-text resource envelope. */
function jsonResource(uri: string, payload: unknown): ReadResourceResult {
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload) }],
  };
}

/** Python `repr()` of a simple string: single-quoted. Agent ids / namespaces
 * are `^[a-z0-9][a-z0-9_-]*$`, so no escaping is needed. */
function pyRepr(s: string): string {
  return `'${s}'`;
}

export interface CreateL6ServerOptions {
  name?: string;
  registry?: FederationRegistry;
  audit?: FederationAudit;
}

/**
 * Build an `McpServer` exposing the L6 resources + tools over `store`. Mirrors
 * `create_l6_server(store, name="bourdon-l6", registry=None, audit=None)`.
 */
export function createL6Server(store: L6Store, options: CreateL6ServerOptions = {}): McpServer {
  const name = options.name ?? "bourdon-l6";
  const registry = options.registry ?? new FederationRegistry();
  const audit = options.audit ?? new FederationAudit();

  const mcp = new McpServer({ name, version: "0.1.0" });

  // -- Trust-tier enforcement helpers (ported from the l6_server closures) -----

  /** The current caller. OPERATOR (trusted) under stdio / unbound; the bound
   * identity under HTTP (set by the auth middleware via AsyncLocalStorage). An
   * HTTP request that bypassed the middleware never reaches here (middleware
   * 401s first), so the stdio default is the only unbound path. */
  function resolveCaller(): AgentIdentity {
    return getCaller();
  }

  function recordAudit(
    caller: AgentIdentity,
    op: string,
    namespace = "*",
    decision: string = DECISION_ALLOW,
    detail: string | null = null,
  ): void {
    audit.record(caller.agentId, op, namespace, decision, detail);
  }

  function denied(
    op: string,
    caller: AgentIdentity,
    namespace = "*",
    detail = "tier 'quarantined' may not call this tool",
  ): Dict {
    recordAudit(caller, op, namespace, DECISION_DENY, detail);
    return {
      error: "access denied",
      op,
      agent: caller.agentId,
      tier: caller.tier,
      detail,
    };
  }

  /** Drop non-granted agents from EntityMatch rows; drop emptied rows. */
  function filterEntityMatches(matches: EntityMatch[], caller: AgentIdentity): EntityMatch[] {
    if (caller.isTrusted) return matches;
    const kept: EntityMatch[] = [];
    for (const m of matches) {
      const agents = m.agents.filter((a) => caller.mayRead(a));
      if (agents.length === 0) continue;
      m.agents = agents;
      const summaries: Record<string, string> = {};
      for (const [a, s] of Object.entries(m.summaries)) {
        if (caller.mayRead(a)) summaries[a] = s;
      }
      m.summaries = summaries;
      kept.push(m);
    }
    return kept;
  }

  // -- Resources ---------------------------------------------------------------

  mcp.registerResource(
    "agents",
    "agent-library://agents",
    { description: "List of all agent IDs known to the federation." },
    (uri): ReadResourceResult => {
      const caller = resolveCaller();
      let agents = store.listAgents();
      if (!caller.isTrusted) agents = agents.filter((a) => caller.mayRead(a));
      recordAudit(caller, "resource:agents");
      return jsonResource(uri.href, agents);
    },
  );

  mcp.registerResource(
    "agent-memory",
    new ResourceTemplate("agent-library://agents/{agent_id}/memory", { list: undefined }),
    { description: "Full visibility-filtered L5 manifest for one agent." },
    (uri, variables): ReadResourceResult => {
      const caller = resolveCaller();
      const agentId = String(variables.agent_id);
      if (!caller.mayRead(agentId)) {
        return jsonResource(
          uri.href,
          denied("resource:agent-memory", caller, agentId, `namespace ${pyRepr(agentId)} not granted`),
        );
      }
      recordAudit(caller, "resource:agent-memory", agentId);
      const manifest = store.getAgentManifest(agentId, false);
      if (manifest === null) {
        return jsonResource(uri.href, { error: `agent not found: ${agentId}` });
      }
      return jsonResource(uri.href, manifest);
    },
  );

  mcp.registerResource(
    "entity",
    new ResourceTemplate("agent-library://entities/{name}", { list: undefined }),
    { description: "Cross-agent view of one entity by name." },
    (uri, variables): ReadResourceResult => {
      const caller = resolveCaller();
      let matches = store.findEntity(String(variables.name), false, "public");
      matches = filterEntityMatches(matches, caller);
      recordAudit(caller, "resource:entity");
      return jsonResource(uri.href, matches.map((m) => m.toDict()));
    },
  );

  // -- Tools -------------------------------------------------------------------

  mcp.registerTool(
    "query_agent_memory",
    {
      description: "Find entries in one agent's L5 that match a topic.",
      inputSchema: {
        agent: z.string(),
        topic: z.string(),
        access_level: z.string().default("public"),
        include_private: z.boolean().default(false),
      },
    },
    (args): CallToolResult => {
      const { agent, topic, access_level, include_private } = args;
      const caller = resolveCaller();
      if (!caller.mayRead(agent)) {
        return jsonContent(
          denied("query_agent_memory", caller, agent, `namespace ${pyRepr(agent)} not granted`),
        );
      }
      recordAudit(caller, "query_agent_memory", agent);
      const matches = store
        .findEntity(topic, include_private, access_level)
        .filter((m) => m.agents.includes(agent));
      return jsonContent({
        agent,
        topic,
        access_level,
        include_private,
        matches: matches.map((m) => m.toDict()),
      });
    },
  );

  mcp.registerTool(
    "list_recent_work",
    {
      description: "Return a page of sessions across agents (or a single agent).",
      inputSchema: {
        since: z.string().nullish(),
        agent: z.string().nullish(),
        access_level: z.string().default("public"),
        include_private: z.boolean().default(false),
        limit: z.number().int().nullish(),
        cursor: z.string().nullish(),
        summary: z.boolean().default(false),
        federation_hop: z.number().int().default(0),
      },
    },
    async (args): Promise<CallToolResult> => {
      const since = args.since ?? null;
      const agent = args.agent ?? null;
      let accessLevel = args.access_level;
      let includePrivate = args.include_private;
      const limit = args.limit ?? null;
      const cursor = args.cursor ?? null;
      const summary = args.summary;
      const federationHop = args.federation_hop;

      const caller = resolveCaller();
      if (!caller.isTrusted && agent !== null && !caller.mayRead(agent)) {
        const denial = denied("list_recent_work", caller, agent, `namespace ${pyRepr(agent)} not granted`);
        denial.sessions = [];
        denial.next_cursor = null;
        denial.has_more = false;
        return jsonContent(denial);
      }
      recordAudit(caller, "list_recent_work", agent ?? "*");

      let cutoff: Date | null = null;
      if (since) {
        const parsed = parseSince(since);
        if (parsed === null) {
          console.warn(`Invalid 'since' value: ${since}`);
        } else {
          cutoff = parsed;
        }
      }
      if (federationHop > 0) {
        [accessLevel, includePrivate] = clampPeerAccess(accessLevel, includePrivate);
      }

      try {
        let page;
        if (store.peers.length > 0 && !cursor && federationHop <= 0) {
          page = await store.listRecentWorkFederated({
            since: cutoff,
            agent,
            includePrivate,
            accessLevel,
            limit,
            cursor,
          });
        } else {
          page = store.listRecentWork({
            since: cutoff,
            agent,
            includePrivate,
            accessLevel,
            limit,
            cursor,
          });
        }
        let rows = page.sessions;
        if (!caller.isTrusted) rows = rows.filter((s) => caller.mayRead(s.agent));
        return jsonContent({
          since,
          agent,
          access_level: accessLevel,
          include_private: includePrivate,
          limit,
          cursor,
          summary,
          sessions: rows.map((s) => s.toDict(summary)),
          next_cursor: page.nextCursor,
          has_more: page.hasMore,
        });
      } catch (exc) {
        // Bad cursor token — surface to the caller rather than silently treating
        // it as a fresh first page.
        return jsonContent({
          error: String(exc instanceof Error ? exc.message : exc),
          since,
          agent,
          access_level: accessLevel,
          include_private: includePrivate,
          limit,
          cursor,
          summary,
          sessions: [],
          next_cursor: null,
          has_more: false,
        });
      }
    },
  );

  mcp.registerTool(
    "find_entity",
    {
      description: "Find an entity by name across all agents.",
      inputSchema: {
        name: z.string(),
        access_level: z.string().default("public"),
        include_private: z.boolean().default(false),
        federation_hop: z.number().int().default(0),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { name } = args;
      let accessLevel = args.access_level;
      let includePrivate = args.include_private;
      const federationHop = args.federation_hop;
      const caller = resolveCaller();
      recordAudit(caller, "find_entity");
      let matches: EntityMatch[];
      if (federationHop > 0) {
        [accessLevel, includePrivate] = clampPeerAccess(accessLevel, includePrivate);
        matches = store.findEntity(name, includePrivate, accessLevel);
      } else {
        matches = await store.findEntityFederated(name, includePrivate, accessLevel);
      }
      matches = filterEntityMatches(matches, caller);
      return jsonContent({
        name,
        access_level: accessLevel,
        include_private: includePrivate,
        matches: matches.map((m) => m.toDict()),
      });
    },
  );

  mcp.registerTool(
    "list_agents",
    {
      description: "List agent IDs known to this L6 server, plus any peers' agents.",
      inputSchema: {
        federation_hop: z.number().int().default(0),
      },
    },
    async (args): Promise<CallToolResult> => {
      const caller = resolveCaller();
      let agents: string[];
      if (args.federation_hop > 0) {
        agents = [...store.listAgents()].sort();
      } else {
        agents = await store.listAgentsFederated();
      }
      if (!caller.isTrusted) agents = agents.filter((a) => caller.mayRead(a));
      recordAudit(caller, "list_agents");
      return jsonContent({ agents });
    },
  );

  mcp.registerTool(
    "export_agents",
    {
      description: "Export THIS server's LOCAL agents only, source-attributed for the tray.",
      inputSchema: {},
    },
    (): CallToolResult => {
      const caller = resolveCaller();
      // Egress visibility clamp (3-Star audit P0-1): PRIVATE session content must
      // never cross the federation wire. Trusted -> team; quarantined -> public.
      const egressAccess = caller.isTrusted ? "team" : "public";
      const envelope = exportLocalAgents(
        pathJoin(store.libraryPath, "agents"),
        resolveLocalName(),
        egressAccess,
      );
      if (!caller.isTrusted) {
        envelope.agents = (envelope.agents as Dict[]).filter((a) =>
          caller.mayRead(String(a.id ?? "")),
        );
      }
      recordAudit(caller, "export_agents");
      return jsonContent(envelope);
    },
  );

  mcp.registerTool(
    "commit_to_federation",
    {
      description: "Write a contribution to the federation under agent_id.",
      inputSchema: {
        agent_id: z.string(),
        agent_type: z.string().nullish(),
        instance: z.string().nullish(),
        role_narrative: z.string().nullish(),
        entities: z.array(z.record(z.string(), z.unknown())).nullish(),
        sessions: z.array(z.record(z.string(), z.unknown())).nullish(),
        mode: z.string().default("merge"),
      },
    },
    async (args): Promise<CallToolResult> => {
      const agentId = args.agent_id;
      const agentType = args.agent_type ?? null;
      const instance = args.instance ?? null;
      const roleNarrative = args.role_narrative ?? null;
      const entities = (args.entities ?? null) as Dict[] | null;
      const sessions = (args.sessions ?? null) as Dict[] | null;
      const mode = args.mode;

      const caller = resolveCaller();
      if (!caller.isTrusted) {
        if (agentId !== caller.agentId) {
          return jsonContent(
            denied(
              "commit_to_federation",
              caller,
              agentId,
              `quarantined members may only write their own namespace (${pyRepr(caller.agentId)})`,
            ),
          );
        }
        try {
          for (const row of entities ?? []) {
            if (row === null || typeof row !== "object" || !String(row.name ?? "").trim()) {
              throw new Error("each entity needs a non-empty 'name'");
            }
          }
          for (const row of sessions ?? []) {
            if (row === null || typeof row !== "object" || !String(row.date ?? "").trim()) {
              throw new Error("each session needs a non-empty ISO-8601 'date'");
            }
          }
          const path = mergeIntoStaged(store.libraryPath, caller.agentId, agentId, entities, sessions, {
            agentType,
            instance,
            roleNarrative,
          });
          recordAudit(caller, "commit_to_federation", agentId, DECISION_ALLOW, "staged");
          return jsonContent({
            staged: true,
            agent_id: agentId,
            path: String(path),
            note:
              "quarantined write staged for review; an operator must run " +
              "`bourdon staging promote " +
              agentId +
              "` before it propagates to the federation",
          });
        } catch (exc) {
          return jsonContent({
            error: String(exc instanceof Error ? exc.message : exc),
            agent_id: agentId,
            mode,
          });
        }
      }
      recordAudit(caller, "commit_to_federation", agentId);
      try {
        const summary = await store.commitL5(agentId, {
          agentType,
          instance,
          roleNarrative,
          entities,
          sessions,
          mode: mode as "merge" | "replace",
        });
        return jsonContent(summary);
      } catch (exc) {
        return jsonContent({
          error: String(exc instanceof Error ? exc.message : exc),
          agent_id: agentId,
          mode,
        });
      }
    },
  );

  mcp.registerTool(
    "get_cross_agent_summary",
    {
      description: "Aggregate everything the federation knows about a project.",
      inputSchema: {
        project: z.string(),
        access_level: z.string().default("public"),
        include_private: z.boolean().default(false),
        federation_hop: z.number().int().default(0),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { project } = args;
      let accessLevel = args.access_level;
      let includePrivate = args.include_private;
      const federationHop = args.federation_hop;
      const caller = resolveCaller();
      if (!caller.isTrusted) {
        return jsonContent(denied("get_cross_agent_summary", caller));
      }
      recordAudit(caller, "get_cross_agent_summary");
      let summary;
      if (federationHop > 0) {
        [accessLevel, includePrivate] = clampPeerAccess(accessLevel, includePrivate);
        summary = store.getCrossAgentSummary(project, includePrivate, accessLevel);
      } else {
        summary = await store.getCrossAgentSummaryFederated(project, includePrivate, accessLevel);
      }
      return jsonContent(summary.toDict());
    },
  );

  mcp.registerTool(
    "prepare_recognition_context",
    {
      description: "Return immediate recognition and a bounded prompt-context fragment.",
      inputSchema: {
        prompt: z.string(),
        access_level: z.string().default("team"),
        include_private: z.boolean().default(false),
        federation_hop: z.number().int().default(0),
      },
    },
    async (args): Promise<CallToolResult> => {
      const { prompt } = args;
      const accessLevel = args.access_level;
      const includePrivate = args.include_private;
      const federationHop = args.federation_hop;
      const caller = resolveCaller();
      if (!caller.isTrusted) {
        return jsonContent(denied("prepare_recognition_context", caller));
      }
      recordAudit(caller, "prepare_recognition_context");
      if (store.peers.length > 0 && federationHop <= 0) {
        return jsonContent(
          await prepareRecognitionContextFederated(store, prompt, accessLevel, includePrivate),
        );
      }
      return jsonContent(
        prepareRecognitionContextFromStore(store, prompt, accessLevel, includePrivate),
      );
    },
  );

  mcp.registerTool(
    "compile_codex_turn",
    {
      description: "Compile a turn-scoped Codex recognition brief.",
      inputSchema: {
        prompt: z.string(),
        cwd: z.string().nullish(),
        access_level: z.string().default("team"),
        max_items: z.number().int().default(6),
        max_chars: z.number().int().default(1800),
      },
    },
    (args): CallToolResult => {
      const caller = resolveCaller();
      if (!caller.isTrusted) {
        return jsonContent(denied("compile_codex_turn", caller));
      }
      recordAudit(caller, "compile_codex_turn");
      return jsonContent(
        compileCodexTurnFromStore(store, args.prompt, {
          cwd: args.cwd ?? null,
          accessLevel: args.access_level,
          maxItems: args.max_items,
          maxChars: args.max_chars,
        }),
      );
    },
  );

  mcp.registerTool(
    "get_deeper_context",
    {
      description: "Return post-recognition L2 context for the prompt.",
      inputSchema: {
        prompt: z.string(),
        access_level: z.string().default("team"),
        include_private: z.boolean().default(false),
      },
    },
    (args): CallToolResult => {
      const caller = resolveCaller();
      if (!caller.isTrusted) {
        return jsonContent(denied("get_deeper_context", caller));
      }
      recordAudit(caller, "get_deeper_context");
      return jsonContent(
        getDeeperContextForPrompt(args.prompt, args.access_level, args.include_private),
      );
    },
  );

  return mcp;
}

// -- module-local helpers ------------------------------------------------------

/**
 * Parse a `since` value the way the Python tool does: ISO datetime first, then a
 * date-only fallback. Returns null when unparseable (the tool warns + ignores).
 */
function parseSince(since: string): Date | null {
  // YYYY-MM-DD (date-only) — interpret as local midnight, matching
  // `datetime.combine(date.fromisoformat(since), time.min)`.
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    const d = new Date(`${since}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(since);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Federated recognition with bounded per-peer latency — port of
 * `prepare_recognition_context_federated`. Local recognition fires first
 * (always a valid answer); peers augment under their per-call recognition
 * budget. Slow/failed peers are dropped and reported in `peer_latencies_us`.
 */
async function prepareRecognitionContextFederated(
  store: L6Store,
  prompt: string,
  accessLevel = "team",
  includePrivate = false,
): Promise<Dict> {
  const local = prepareRecognitionContextFromStore(store, prompt, accessLevel, includePrivate);
  if (store.peers.length === 0) {
    local.peer_latencies_us = {};
    local.peers_queried = 0;
    local.peers_responded = 0;
    local.peers_timed_out = 0;
    return local;
  }

  const matchedByKey = new Map<string, Dict>();
  for (const e of local.matched_entities as Dict[]) {
    const n = String(e.name ?? "");
    if (n) matchedByKey.set(n.toLowerCase(), e);
  }
  const peerLatencies: Record<string, number | null> = {};
  const extraContextLines: string[] = [];
  let peersResponded = 0;
  let peersTimedOut = 0;

  const results = await Promise.all(
    store.peers.map(async (peer) => {
      const start = Number(process.hrtime.bigint());
      let payload: Dict | null = null;
      let timedOut = false;
      try {
        const budgetMs = Math.max(0, peer.recognitionTimeout) * 1000;
        const work = peer.prepareRecognitionContext(prompt, accessLevel, includePrivate);
        const timer = new Promise<symbol>((resolve) => setTimeout(() => resolve(TIMEOUT), budgetMs));
        const raced = await Promise.race([work, timer]);
        if (raced === TIMEOUT) {
          timedOut = true;
        } else {
          payload = raced as Dict;
        }
      } catch (exc) {
        console.warn(`peer ${peer.name} prepare_recognition_context raised: ${String(exc)}`);
        payload = null;
      }
      const latencyUs = Math.round(((Number(process.hrtime.bigint()) - start) / 1000) * 10) / 10;
      return { name: peer.name, payload, latencyUs: payload ? latencyUs : null, timedOut };
    }),
  );

  for (const { name, payload, latencyUs, timedOut } of results) {
    peerLatencies[name] = latencyUs;
    if (timedOut) {
      peersTimedOut += 1;
      continue;
    }
    if (payload === null) continue;
    peersResponded += 1;
    for (const ent of (payload.matched_entities as Dict[] | undefined) ?? []) {
      if (ent === null || typeof ent !== "object") continue;
      const entName = String(ent.name ?? "").trim();
      if (!entName) continue;
      const taggedAgents = (Array.isArray(ent.source_agents) ? ent.source_agents : [])
        .filter((a): a is string => typeof a === "string")
        .map((a) => `peer:${name}:${a}`);
      const key = entName.toLowerCase();
      const existing = matchedByKey.get(key);
      if (existing === undefined) {
        matchedByKey.set(key, {
          name: entName,
          type: String(ent.type ?? "topic"),
          source_agents: taggedAgents,
        });
      } else {
        const src = existing.source_agents as string[];
        for (const a of taggedAgents) if (!src.includes(a)) src.push(a);
      }
    }
    const peerRecognition = String(payload.recognition ?? "").trim();
    if (peerRecognition) extraContextLines.push(`[peer:${name}] ${peerRecognition}`);
  }

  local.matched_entities = [...matchedByKey.values()];
  if (extraContextLines.length > 0) {
    const existingCtx = String(local.prompt_context ?? "");
    local.prompt_context = existingCtx.replace(/\s+$/, "") + "\n" + extraContextLines.join("\n");
  }
  local.peer_latencies_us = peerLatencies;
  local.peers_queried = store.peers.length;
  local.peers_responded = peersResponded;
  local.peers_timed_out = peersTimedOut;
  return local;
}

const TIMEOUT = Symbol("timeout");
