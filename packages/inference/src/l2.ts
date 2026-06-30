/**
 * Bourdon L2 — episodic-memory async retrieval. Faithful port of `core/l2.py`.
 *
 * L2 is the third memory layer: it fires CONCURRENT with the AI's first response
 * tokens and completes during the human's read/type window. Two invariants are
 * enforced in code, not by trust:
 *
 *  - {@link queryL2} NEVER raises — a total try/catch returns `""` so L2 can never
 *    crash a session. Callers do not need try/catch.
 *  - L2 NEVER blocks the first response — an {@link AbortSignal} timeout (default
 *    8.0s) that ACTUALLY cancels the in-flight MCP call (the signal is passed to
 *    the client AND wins the race), not merely a race that leaks the request.
 *
 * L2 is OPT-IN: the default config has `enabled=false`, so a fresh install (L0+L1)
 * needs no UltraRAG. The production client talks to the retriever over
 * `@modelcontextprotocol/sdk` (lazy import — importing this module needs no SDK).
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as yamlParse } from "yaml";

import { logger } from "./logger.js";

declare const __filename: string | undefined;

function moduleDir(): string {
  if (typeof __filename === "string") return dirname(__filename);
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/** Default bundled YAML config path (`core/l2_config.yaml` in the oracle). */
export const DEFAULT_CONFIG_PATH = join(moduleDir(), "l2_config.yaml");

// -- bool parsing --------------------------------------------------------------

const TRUE_VALUES: ReadonlySet<string> = new Set(["true", "1", "yes", "on", "t", "y"]);
const FALSE_VALUES: ReadonlySet<string> = new Set(["false", "0", "no", "off", "f", "n"]);

/** Parse a bool-ish value, or null if unparseable (mirrors `_parse_bool`). */
export function parseBool(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Boolean(raw);
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(lower)) return true;
    if (FALSE_VALUES.has(lower)) return false;
  }
  return null;
}

// -- Config --------------------------------------------------------------------

export interface L2ConfigData {
  enabled: boolean;
  endpoint: string;
  toolName: string;
  topK: number;
  timeoutSeconds: number;
}

/**
 * Configuration for the L2 episodic-memory layer. Load order (later overrides
 * earlier): dataclass defaults -> YAML file (`fromYaml`) -> `BOURDON_L2_*` env.
 */
export class L2Config implements L2ConfigData {
  enabled = false;
  endpoint = "http://localhost:8765";
  toolName = "retriever_search";
  topK = 5;
  timeoutSeconds = 8.0;

  constructor(init: Partial<L2ConfigData> = {}) {
    if (init.enabled !== undefined) this.enabled = init.enabled;
    if (init.endpoint !== undefined) this.endpoint = init.endpoint;
    if (init.toolName !== undefined) this.toolName = init.toolName;
    if (init.topK !== undefined) this.topK = init.topK;
    if (init.timeoutSeconds !== undefined) this.timeoutSeconds = init.timeoutSeconds;
  }

  /** Load config from YAML (falls back to defaults if missing/unparseable), then env. */
  static fromYaml(path: string | null = null): L2Config {
    let cfg = new L2Config();
    const target = path ?? DEFAULT_CONFIG_PATH;
    let isFile = false;
    try {
      isFile = statSync(target).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) {
      try {
        const data = yamlParse(readFileSync(target, "utf8")) ?? {};
        if (data !== null && typeof data === "object" && !Array.isArray(data)) {
          cfg = L2Config._mergeDict(cfg, data as Record<string, unknown>);
        }
      } catch (e) {
        logger.warn(`Failed to load L2 config from ${target}: ${String(e)}`);
      }
    }
    return L2Config._applyEnvOverrides(cfg);
  }

  /** Merge dict values into a config, coercing types and ignoring unknown keys. */
  private static _mergeDict(base: L2Config, data: Record<string, unknown>): L2Config {
    const enabledRaw = "enabled" in data ? data.enabled : base.enabled;
    const parsedEnabled = parseBool(enabledRaw);
    return new L2Config({
      enabled: parsedEnabled !== null ? parsedEnabled : base.enabled,
      endpoint: "endpoint" in data ? String(data.endpoint) : base.endpoint,
      toolName: "tool_name" in data ? String(data.tool_name) : base.toolName,
      topK: "top_k" in data ? Math.trunc(Number(data.top_k)) : base.topK,
      timeoutSeconds:
        "timeout_seconds" in data ? Number(data.timeout_seconds) : base.timeoutSeconds,
    });
  }

  /** Apply any `BOURDON_L2_*` env vars on top of the given config. */
  private static _applyEnvOverrides(cfg: L2Config): L2Config {
    const updates: Partial<L2ConfigData> = {};
    const env = process.env;
    if (env.BOURDON_L2_ENABLED !== undefined) {
      const parsed = parseBool(env.BOURDON_L2_ENABLED);
      if (parsed !== null) updates.enabled = parsed;
    }
    if (env.BOURDON_L2_ENDPOINT !== undefined) updates.endpoint = env.BOURDON_L2_ENDPOINT;
    if (env.BOURDON_L2_TOOL !== undefined) updates.toolName = env.BOURDON_L2_TOOL;
    if (env.BOURDON_L2_TOP_K !== undefined) {
      const n = Number(env.BOURDON_L2_TOP_K);
      if (Number.isInteger(n)) updates.topK = n;
      else logger.warn(`Invalid BOURDON_L2_TOP_K=${env.BOURDON_L2_TOP_K}, ignoring`);
    }
    if (env.BOURDON_L2_TIMEOUT !== undefined) {
      const n = Number(env.BOURDON_L2_TIMEOUT);
      if (Number.isFinite(n)) updates.timeoutSeconds = n;
      else logger.warn(`Invalid BOURDON_L2_TIMEOUT=${env.BOURDON_L2_TIMEOUT}, ignoring`);
    }
    return new L2Config({ ...cfg, ...updates });
  }
}

// -- Client protocol + formatting ---------------------------------------------

/**
 * Protocol for an L2 retrieval client. Implementations provide an async `query`.
 * Tests supply a mock; production uses {@link FastMCPL2Client}. The `signal` lets
 * {@link queryL2} actually cancel an in-flight call on timeout.
 */
export interface L2Client {
  query(query: string, topK: number, signal?: AbortSignal): Promise<string>;
}

/**
 * Normalize a raw retriever response into a human-readable context block. Accepts
 * a plain string, a list of strings / `.text`-bearing items / dicts with
 * `content`/`text`/`summary`/`body`, or an MCP `CallToolResult` with `.content`.
 * Mirrors `_format_l2_context`.
 */
export function formatL2Context(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw.trim();

  // fastmcp's CallToolResult exposes a list at .content
  let value: unknown = raw;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const content = (value as Record<string, unknown>).content;
    if (content !== null && content !== undefined) value = content;
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item.trim());
        continue;
      }
      // TextContent-like: .text attribute
      const textAttr =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>).text
          : undefined;
      if (textAttr) {
        parts.push(String(textAttr).trim());
        continue;
      }
      if (typeof item === "object" && item !== null) {
        const dict = item as Record<string, unknown>;
        let matched = false;
        for (const key of ["content", "text", "summary", "body"] as const) {
          const v = dict[key];
          if (v) {
            parts.push(String(v).trim());
            matched = true;
            break;
          }
        }
        if (!matched) parts.push(String(item));
      } else {
        parts.push(String(item));
      }
    }
    return parts.filter((p) => p).join("\n\n---\n\n");
  }

  return String(value).trim();
}

// -- Production client (lazy @modelcontextprotocol/sdk import) -----------------

/**
 * Production L2 client backed by `@modelcontextprotocol/sdk`. Creates a fresh MCP
 * connection per query (stateless): simpler and safer than a long-lived
 * connection for mostly-idle agents, and the connect latency is negligible inside
 * L2's multi-second budget. The SDK import is deferred so importing this module
 * needs no SDK — only constructing the client (or its first query) does.
 */
export class FastMCPL2Client implements L2Client {
  readonly endpoint: string;
  readonly toolName: string;

  constructor(endpoint: string, toolName: string) {
    this.endpoint = endpoint;
    this.toolName = toolName;
  }

  async query(query: string, topK: number, signal?: AbortSignal): Promise<string> {
    let Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
    let StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
    try {
      ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
      ({ StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      ));
    } catch (exc) {
      throw new Error(
        "@modelcontextprotocol/sdk is required for L2 UltraRAG integration: " + String(exc),
      );
    }
    const client = new Client({ name: "bourdon-l2", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.endpoint));
    await client.connect(transport);
    try {
      const result = await client.callTool(
        { name: this.toolName, arguments: { query, top_k: topK } },
        undefined,
        signal ? { signal } : undefined,
      );
      return formatL2Context(result);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

// -- Entry point ---------------------------------------------------------------

/**
 * Fire an L2 retrieval. NEVER raises; returns `""` on any failure. If
 * `config.enabled` is false, returns `""` immediately without connecting. The
 * timeout (`config.timeoutSeconds`) actually cancels the in-flight call: the
 * abort signal is passed to the client AND wins the race if the client ignores it.
 *
 * @param query  the user message (or derived query) to retrieve context for
 * @param config defaults to {@link L2Config.fromYaml}
 * @param client overrides the default client (used in tests)
 */
export async function queryL2(
  query: string,
  config: L2Config | null = null,
  client: L2Client | null = null,
): Promise<string> {
  const cfg = config ?? L2Config.fromYaml();
  if (!cfg.enabled) return "";

  let c = client;
  if (c === null) {
    try {
      c = new FastMCPL2Client(cfg.endpoint, cfg.toolName);
    } catch (e) {
      logger.warn(`L2 client init failed: ${String(e)}`);
      return "";
    }
  }

  const signal = AbortSignal.timeout(cfg.timeoutSeconds * 1000);
  try {
    return await Promise.race([c.query(query, cfg.topK, signal), abortReject(signal)]);
  } catch (e) {
    if (isTimeout(e, signal)) {
      logger.warn(`L2 query timed out after ${cfg.timeoutSeconds}s`);
    } else {
      logger.warn(`L2 query failed: ${String(e)}`);
    }
    return "";
  }
}

/** A promise that rejects with the abort reason when `signal` fires. */
function abortReject(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
      once: true,
    });
  });
}

function isTimeout(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return (
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as { name?: unknown }).name === "TimeoutError"
  );
}
