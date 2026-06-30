/**
 * @getbourdon/mcp-server — the Bourdon L6 MCP server facade (BUSL-1.1).
 *
 * The TypeScript mirror of `core/l6_server.py` on `@modelcontextprotocol/sdk`,
 * WIRE-COMPATIBLE with the Python server BOTH directions so mixed-language
 * federation works: every tool returns JSON-in-TextContent
 * (`text = JSON.stringify(payload)`) — NOT the SDK's default structured content
 * — so a Python `RemoteL6Client`'s `json.loads(item.text)` recovers the payload.
 *
 * The 10 tools + 3 resources are thin delegates to `@getbourdon/federation`
 * (L6Store + trust) and `@getbourdon/recognition`. The public/team `access_level`
 * default split is reproduced exactly. Python (`pip install bourdon`) is the
 * oracle; this package asserts against `@getbourdon/conformance` `mcp_snapshots`.
 */

import type { FederationAudit, FederationRegistry, L6Store } from "@getbourdon/federation";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createL6Server, type CreateL6ServerOptions } from "./server.js";

export { createL6Server, type CreateL6ServerOptions } from "./server.js";

// Agents export (the `export_agents` tool's summarizer).
export {
  AGENTS_SCHEMA,
  MAX_RECENT_SESSIONS,
  errorAgentEntry,
  exportLocalAgents,
  resolveLocalName,
  summarizeAgentManifest,
} from "./agents-export.js";

// Recognition / context helpers.
export {
  CODEX_TURN_DEFERRED,
  compileCodexTurnFromStore,
  getDeeperContextForPrompt,
  prepareRecognitionContextFromStore,
  recognitionPromptContext,
} from "./recognition-context.js";

// Transports + auth.
export { runStdio } from "./stdio.js";
export {
  BindRefusedError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  authenticateBearer,
  isLoopbackHost,
  normalizedLegacyToken,
  runHttpServer,
  type AuthResult,
  type RunHttpServerOptions,
} from "./http-transport.js";

/**
 * Convenience factory: build an `McpServer` over `store` with the given trust
 * `registry` + `audit`. Equivalent to `createL6Server(store, { registry, audit })`.
 */
export function createServer(
  store: L6Store,
  registry?: FederationRegistry,
  opts: Omit<CreateL6ServerOptions, "registry"> & { audit?: FederationAudit } = {},
): McpServer {
  return createL6Server(store, { ...opts, registry });
}
