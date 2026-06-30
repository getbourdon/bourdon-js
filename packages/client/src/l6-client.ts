/**
 * Bourdon L6 federation MCP client.
 *
 * Connects to a running Bourdon L6 server — spawned as a `python -m core.l6_server`
 * stdio subprocess (default) or a long-lived Streamable-HTTP service — and proxies
 * the ten L6 tools it exposes. Wraps the official `@modelcontextprotocol/sdk`
 * client so JSON-RPC framing is not re-implemented.
 *
 * Lifted and extended from the proven openclaw-bourdon-plugin client:
 *   - all TEN tools (the plugin proxied six read tools)
 *   - Streamable HTTP transport (SSE is deprecated in the SDK)
 *   - results are JSON-parsed from the server's TextContent envelope
 *     (the L6 server returns `{content:[{type:'text', text: JSON.stringify(payload)}]}`,
 *     so a raw CallToolResult is unwrapped to the payload here)
 *   - an injectable transport (`{transport:'custom'}`) for in-memory testing
 *
 * Tool surface mirrored from bourdon/core/l6_server.py. The server applies
 * per-tool `access_level` defaults (public for queries, team for recognition),
 * so this client never hardcodes them — omitted args are dropped, not defaulted.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Federation visibility level. Mirrors the Python `Visibility` enum values. */
export type AccessLevel = "public" | "team" | "private";

export interface L6StdioConfig {
  transport: "stdio";
  /** Defaults to `python`. */
  command?: string;
  /** Defaults to `["-m", "core.l6_server"]`. */
  args?: string[];
  /** Optional library path forwarded to L6 via `--library`. */
  library?: string;
  /** cwd for the subprocess (so `core.l6_server` is importable when not installed). */
  cwd?: string;
  /** Optional environment passed to the subprocess. */
  env?: Record<string, string>;
}

export interface L6HttpConfig {
  transport: "http";
  url: string;
  /** Bearer token sent as `Authorization: Bearer <token>` (federation peer auth). */
  token?: string;
}

/** Inject a pre-built transport (used for in-memory testing). */
export interface L6CustomConfig {
  transport: "custom";
  instance: Transport;
}

export type L6Config = L6StdioConfig | L6HttpConfig | L6CustomConfig;

export interface CommonToolArgs {
  access_level?: AccessLevel;
  include_private?: boolean;
}

export interface QueryAgentMemoryArgs extends CommonToolArgs {
  agent: string;
  topic: string;
}

export interface ListRecentWorkArgs extends CommonToolArgs {
  /** ISO 8601 date or datetime. */
  since?: string;
  agent?: string;
  limit?: number;
  cursor?: string;
  summary?: boolean;
}

export interface FindEntityArgs extends CommonToolArgs {
  name: string;
}

export interface GetCrossAgentSummaryArgs extends CommonToolArgs {
  project: string;
}

export interface RecognitionArgs extends CommonToolArgs {
  prompt: string;
}

export interface CompileCodexTurnArgs {
  prompt: string;
  cwd?: string;
  access_level?: AccessLevel;
  max_items?: number;
  max_chars?: number;
}

export interface CommitToFederationArgs {
  agent_id: string;
  agent_type?: string;
  instance?: string;
  role_narrative?: string;
  entities?: Record<string, unknown>[];
  sessions?: Record<string, unknown>[];
  /** `merge` (default) or `replace`. */
  mode?: string;
}

/** The parsed payload returned by an L6 tool (server-defined JSON shape). */
export type L6ToolResult = unknown;

export class BourdonL6Client {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly config: L6Config;

  constructor(config: L6Config) {
    this.config = config;
  }

  /** Connect lazily on first call; subsequent calls reuse the live client. */
  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connectPromise) {
      await this.connectPromise;
      if (!this.client) throw new Error("Bourdon L6 client failed to initialize");
      return this.client;
    }
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
    if (!this.client) throw new Error("Bourdon L6 client failed to initialize");
    return this.client;
  }

  private async connect(): Promise<void> {
    const transport = this.buildTransport(this.config);
    const client = new Client({ name: "@getbourdon/client", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
  }

  private buildTransport(config: L6Config): Transport {
    if (config.transport === "custom") return config.instance;
    if (config.transport === "stdio") {
      const args = [...(config.args ?? ["-m", "core.l6_server"])];
      if (config.library && !args.includes("--library")) {
        args.push("--library", config.library);
      }
      return new StdioClientTransport({
        command: config.command ?? "python",
        args,
        cwd: config.cwd,
        env: config.env,
      });
    }
    // Streamable HTTP (replaces deprecated SSE). Bearer auth via request headers.
    const opts =
      config.token === undefined
        ? undefined
        : { requestInit: { headers: { Authorization: `Bearer ${config.token}` } } };
    return new StreamableHTTPClientTransport(new URL(config.url), opts);
  }

  /** Close the client and underlying transport. Idempotent. */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {
        /* best-effort shutdown */
      });
      this.client = null;
    }
    if (this.transport) {
      await this.transport.close?.().catch(() => {});
      this.transport = null;
    }
  }

  /**
   * Generic call. Unwraps the server's TextContent JSON envelope to the payload.
   * Prefer the typed methods below.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<L6ToolResult> {
    const client = await this.ensureConnected();
    const result = await client.callTool({ name, arguments: args });
    return parseToolResult(result);
  }

  // -- the ten L6 tools (typed) ------------------------------------------------

  queryAgentMemory(args: QueryAgentMemoryArgs): Promise<L6ToolResult> {
    return this.callTool("query_agent_memory", argsToRecord(args));
  }

  listRecentWork(args: ListRecentWorkArgs = {}): Promise<L6ToolResult> {
    return this.callTool("list_recent_work", argsToRecord(args));
  }

  findEntity(args: FindEntityArgs): Promise<L6ToolResult> {
    return this.callTool("find_entity", argsToRecord(args));
  }

  listAgents(): Promise<L6ToolResult> {
    return this.callTool("list_agents", {});
  }

  exportAgents(): Promise<L6ToolResult> {
    return this.callTool("export_agents", {});
  }

  getCrossAgentSummary(args: GetCrossAgentSummaryArgs): Promise<L6ToolResult> {
    return this.callTool("get_cross_agent_summary", argsToRecord(args));
  }

  prepareRecognitionContext(args: RecognitionArgs): Promise<L6ToolResult> {
    return this.callTool("prepare_recognition_context", argsToRecord(args));
  }

  getDeeperContext(args: RecognitionArgs): Promise<L6ToolResult> {
    return this.callTool("get_deeper_context", argsToRecord(args));
  }

  compileCodexTurn(args: CompileCodexTurnArgs): Promise<L6ToolResult> {
    return this.callTool("compile_codex_turn", argsToRecord(args));
  }

  commitToFederation(args: CommitToFederationArgs): Promise<L6ToolResult> {
    return this.callTool("commit_to_federation", argsToRecord(args));
  }
}

/* -- internals ------------------------------------------------------------- */

/**
 * Unwrap an MCP CallToolResult to the L6 payload. The L6 server JSON-stringifies
 * its payload into a single `text` content block (so cross-language peers parse
 * it with `json.loads(item.text)`); we mirror that on the read side. Falls back to
 * the raw text, then the raw result, if the envelope is unexpected.
 */
function parseToolResult(result: unknown): L6ToolResult {
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" &&
        c !== null &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    );
    if (textBlock) {
      try {
        return JSON.parse(textBlock.text);
      } catch {
        return textBlock.text;
      }
    }
  }
  return result;
}

/** Drop undefined fields so the server applies its own per-tool defaults. */
function argsToRecord(args: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
