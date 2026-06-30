/**
 * stdio transport — the MCP-host default and `bourdon serve --transport stdio`.
 *
 * `StdioServerTransport` carries no auth: stdio has no HTTP request, so the
 * caller resolves to OPERATOR (trusted) via the unbound AsyncLocalStorage —
 * exactly v0.8.0 behavior. `server.connect(transport)` blocks the process until
 * the connecting MCP client disconnects.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** Connect `server` to a stdio transport. Resolves once connected; the process
 * stays alive until the client disconnects. */
export async function runStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
