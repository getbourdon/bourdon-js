/**
 * Remote L6 client — proxy L6Store query methods to a peer Bourdon L6 server
 * over MCP-streamable-HTTP.
 *
 * Faithful port of `core/l6_remote.py`. The transport itself (the MCP session)
 * is injected so this package carries no hard MCP-SDK dependency: wire a
 * `PeerTransport` (e.g. backed by `@getbourdon/client`) at construction, or pass
 * none and every call degrades to its empty default (mirroring a dead peer).
 *
 * Security/parity invariants preserved IN CODE:
 *  - `federation_hop: 1` on EVERY fan-out-capable query so the peer answers from
 *    its LOCAL store only — federation is DEPTH-1 by contract; omitting it makes
 *    bidirectional peering recurse to fd exhaustion (#139). `export_agents`
 *    sends `{}` (already local-only server-side).
 *  - NEVER `include_private: true`; `access_level` capped to ("public","team")
 *    on egress for find_entity / list_recent_work / get_cross_agent_summary
 *    (3-Star P1-2) — mirrors the ingress clamp on the server.
 *  - The whole call is wrapped: a peer call NEVER raises (warn + return the
 *    empty default), so one dead peer never breaks a federated merge.
 *  - Per-call timeout 5.0s default; recognition 0.2s (Phase 1.7 tight budget).
 *  - Result-shape tolerance: list -> coerce; dict with .agents/.matches/
 *    .sessions -> unwrap; else the empty default.
 */

const PEER_TOOL_NAMES = new Set([
  "list_agents",
  "export_agents",
  "query_agent_memory",
  "list_recent_work",
  "find_entity",
  "get_cross_agent_summary",
  "prepare_recognition_context",
  "get_deeper_context",
]);

type Dict = Record<string, unknown>;

/** The injected MCP transport. Implementations open a streamable-HTTP MCP
 * session, call the named tool, and return the parsed JSON payload (Bourdon
 * tools JSON-encode their result in a TextContent item). May throw — the client
 * wraps every call so a throw degrades to the empty default. */
export interface PeerTransport {
  callTool(toolName: string, args: Dict, opts: { url: string; headers: Dict; timeout: number }): Promise<unknown>;
}

export interface RemoteL6ClientOptions {
  /** Base URL of the peer's MCP HTTP endpoint. Trailing `/mcp` appended if missing. */
  url: string;
  /** Short identifier for this peer (log lines + merge dedupe). */
  name: string;
  /** Env var to read the Bearer token from. "" => skip auth. */
  tokenEnv?: string;
  /** Per-call timeout in seconds. Default 5s. */
  timeout?: number;
  /** Tighter per-call budget for the recognition hot path. Default 0.2s. */
  recognitionTimeout?: number;
  /** Transport. When absent, every call returns its empty default. */
  transport?: PeerTransport;
}

function clampLevel(accessLevel: string): string {
  return accessLevel === "public" || accessLevel === "team" ? accessLevel : "team";
}

export class RemoteL6Client {
  url: string;
  readonly name: string;
  readonly tokenEnv: string;
  readonly timeout: number;
  readonly recognitionTimeout: number;
  private readonly transport?: PeerTransport;

  constructor(opts: RemoteL6ClientOptions) {
    // __post_init__: normalize URL — MCP streamable-HTTP path is /mcp.
    let url = opts.url.replace(/\/+$/, "");
    if (!url.endsWith("/mcp")) url = `${url}/mcp`;
    this.url = url;
    this.name = opts.name;
    this.tokenEnv = opts.tokenEnv ?? "BOURDON_PEER_TOKEN";
    this.timeout = opts.timeout ?? 5.0;
    this.recognitionTimeout = opts.recognitionTimeout ?? 0.2;
    this.transport = opts.transport;
  }

  private _headers(): Dict {
    const token = this.tokenEnv ? process.env[this.tokenEnv] : undefined;
    if (token) return { Authorization: `Bearer ${token}` };
    return {};
  }

  /** Call one MCP tool on the peer. Returns parsed JSON or null on any failure.
   * NEVER raises (mirrors the Python `noqa BLE001` wrap). */
  private async _callTool(
    toolName: string,
    args: Dict,
    timeout = this.timeout,
  ): Promise<unknown> {
    if (!PEER_TOOL_NAMES.has(toolName)) {
      throw new Error(`unknown peer tool: ${JSON.stringify(toolName)}`); // typo guard
    }
    if (!this.transport) return null;
    try {
      return await this.transport.callTool(toolName, args, {
        url: this.url,
        headers: this._headers(),
        timeout,
      });
    } catch (exc) {
      console.warn(`peer ${this.name} tool ${toolName} failed: ${String(exc)}`);
      return null;
    }
  }

  // ----------------------------------------------------- mirrored query API

  async listAgents(): Promise<string[]> {
    const result = await this._callTool("list_agents", { federation_hop: 1 });
    if (Array.isArray(result)) return result.filter((a): a is string => typeof a === "string");
    if (result && typeof result === "object" && Array.isArray((result as Dict).agents)) {
      return ((result as Dict).agents as unknown[]).filter((a): a is string => typeof a === "string");
    }
    return [];
  }

  async exportAgents(): Promise<Dict | null> {
    // export_agents sends {} — it is already local-only server-side.
    const result = await this._callTool("export_agents", {});
    return result && typeof result === "object" && !Array.isArray(result) ? (result as Dict) : null;
  }

  async findEntity(
    name: string,
    accessLevel = "team",
    _includePrivate = false,
  ): Promise<Dict[]> {
    const result = await this._callTool("find_entity", {
      name,
      // Never ask a peer for PRIVATE (P1-2); the peer also clamps on ingress.
      access_level: clampLevel(accessLevel),
      include_private: false,
      federation_hop: 1,
    });
    if (Array.isArray(result)) {
      return result.filter((m): m is Dict => m !== null && typeof m === "object" && !Array.isArray(m));
    }
    if (result && typeof result === "object" && Array.isArray((result as Dict).matches)) {
      return ((result as Dict).matches as unknown[]).filter(
        (m): m is Dict => m !== null && typeof m === "object" && !Array.isArray(m),
      );
    }
    return [];
  }

  async listRecentWork(opts: {
    since?: string | null;
    agent?: string | null;
    accessLevel?: string;
    includePrivate?: boolean;
    limit?: number | null;
    cursor?: string | null;
    summary?: boolean;
  } = {}): Promise<Dict> {
    const args: Dict = {
      access_level: clampLevel(opts.accessLevel ?? "team"),
      include_private: false, // never ask a peer for PRIVATE (P1-2)
      summary: opts.summary ?? false,
      federation_hop: 1,
    };
    if (opts.since !== null && opts.since !== undefined) args.since = opts.since;
    if (opts.agent !== null && opts.agent !== undefined) args.agent = opts.agent;
    if (opts.limit !== null && opts.limit !== undefined) args.limit = opts.limit;
    if (opts.cursor !== null && opts.cursor !== undefined) args.cursor = opts.cursor;
    const result = await this._callTool("list_recent_work", args);
    if (result && typeof result === "object" && !Array.isArray(result)) return result as Dict;
    return { sessions: [], next_cursor: null, has_more: false };
  }

  async getCrossAgentSummary(
    project: string,
    accessLevel = "team",
    _includePrivate = false,
  ): Promise<Dict> {
    const result = await this._callTool("get_cross_agent_summary", {
      project,
      access_level: clampLevel(accessLevel),
      include_private: false, // never ask a peer for PRIVATE (P1-2)
      federation_hop: 1,
    });
    return result && typeof result === "object" && !Array.isArray(result) ? (result as Dict) : {};
  }

  async prepareRecognitionContext(
    prompt: string,
    accessLevel = "team",
    includePrivate = false,
  ): Promise<Dict> {
    // Aggregate tool the server denies wholesale to quarantined callers and
    // clamps for peers, so access_level/include_private pass through. Tight
    // recognition budget.
    const result = await this._callTool(
      "prepare_recognition_context",
      {
        prompt,
        access_level: accessLevel,
        include_private: includePrivate,
        federation_hop: 1,
      },
      this.recognitionTimeout,
    );
    return result && typeof result === "object" && !Array.isArray(result) ? (result as Dict) : {};
  }

  async getDeeperContext(
    prompt: string,
    accessLevel = "team",
    includePrivate = false,
  ): Promise<Dict> {
    const result = await this._callTool("get_deeper_context", {
      prompt,
      access_level: accessLevel,
      include_private: includePrivate,
    });
    return result && typeof result === "object" && !Array.isArray(result) ? (result as Dict) : {};
  }
}
