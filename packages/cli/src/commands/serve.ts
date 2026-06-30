/**
 * `serve` — launch the L6 federation MCP server. Thin wrapper over the ported
 * @getbourdon/mcp-server transports: prints the onboarding banner to stderr
 * (stdout stays clean for the stdio MCP protocol), resolves peers exactly like
 * the `bourdon-l6-server` bin, and reuses the non-loopback-bind refusal in the
 * HTTP transport (the CLI passes host/port/auth through — the refusal lives in
 * runHttpServer, never the parser).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_LIBRARY_PATH,
  FederationRegistry,
  L6Store,
  RemoteL6Client,
  type PeerTransport,
} from "@getbourdon/federation";
import { BindRefusedError, createL6Server, runHttpServer, runStdio } from "@getbourdon/mcp-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parse as yamlParse } from "yaml";

import type { Dict } from "../util.js";

const DEFAULT_PEERS_CONFIG = join(homedir(), ".bourdon", "peers.yaml");

/** An MCP-SDK-backed peer transport (copied from the mcp-server bin): open a
 * streamable-HTTP client per call, invoke the tool, recover the
 * JSON-in-TextContent payload, close. */
function sdkPeerTransport(): PeerTransport {
  return {
    async callTool(toolName, toolArgs, opts) {
      const headerInit = opts.headers as Record<string, string>;
      const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
        requestInit: { headers: headerInit },
      });
      const client = new Client({ name: "bourdon serve peer", version: "0.1.0" }, { capabilities: {} });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: toolName, arguments: toolArgs });
        const content = (result as { content?: unknown }).content;
        if (Array.isArray(content)) {
          const textBlock = content.find(
            (c): c is { type: "text"; text: string } =>
              typeof c === "object" &&
              c !== null &&
              (c as { type?: unknown }).type === "text" &&
              typeof (c as { text?: unknown }).text === "string",
          );
          if (textBlock) return JSON.parse(textBlock.text);
        }
        return null;
      } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }
    },
  };
}

function loadPeers(configPath: string, inlineUrls: string[]): RemoteL6Client[] {
  const peers: RemoteL6Client[] = [];
  const seen = new Set<string>();
  const transport = sdkPeerTransport();
  if (existsSync(configPath)) {
    try {
      const data = (yamlParse(readFileSync(configPath, "utf8")) as { peers?: unknown }) || {};
      const entries = Array.isArray(data.peers) ? data.peers : [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const url = e.url;
        if (typeof url !== "string" || !url) continue;
        const name = typeof e.name === "string" && e.name ? e.name : url;
        const tokenEnv =
          typeof e.token_env === "string" && e.token_env ? e.token_env : "BOURDON_PEER_TOKEN";
        if (seen.has(url)) continue;
        seen.add(url);
        peers.push(new RemoteL6Client({ url, name, tokenEnv, transport }));
      }
    } catch (exc) {
      process.stderr.write(`Failed to load peers config ${configPath}: ${String(exc)}\n`);
    }
  }
  for (const url of inlineUrls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    peers.push(new RemoteL6Client({ url, name: url, transport }));
  }
  return peers;
}

export async function handleServe(opts: Dict, _args: string[]): Promise<number> {
  const library = opts.library ? String(opts.library) : DEFAULT_LIBRARY_PATH;
  const transport = String(opts.transport ?? "stdio");
  const port = Number(opts.port ?? 7500);
  const host = String(opts.host ?? "127.0.0.1");
  const allowUnauthenticated = Boolean(opts.allowUnauthenticated);
  const peersConfig = opts.peersConfig ? String(opts.peersConfig) : DEFAULT_PEERS_CONFIG;
  const peerUrls = (opts.peer as string[]) ?? [];

  const peers = loadPeers(peersConfig, peerUrls);
  const store = new L6Store(library, peers);
  const agents = store.listAgents();
  const registry = new FederationRegistry();

  if (!opts.quiet) {
    const err = (s: string): void => void process.stderr.write(`${s}\n`);
    err("Bourdon L6 server");
    err(`  library:   ${library}`);
    err(`  agents:    ${agents.length} loaded (${agents.length ? agents.join(", ") : "none"})`);
    err(`  transport: ${transport}`);
    if (transport === "http") {
      err(`  bind:      ${host}:${port}`);
      err(
        `  auth:      ${
          allowUnauthenticated
            ? "disabled (--allow-unauthenticated, loopback only)"
            : "Bearer (bourdon agent add / BOURDON_PEER_TOKEN_SERVER)"
        }`,
      );
    }
    if (peers.length) {
      err(`  peers:     ${peers.length} (${peers.map((p) => `${p.name} -> ${p.url}`).join(", ")})`);
    }
    err("");
    if (transport === "stdio") {
      err("MCP client config (stdio):");
      err('  {"command": "bourdon", "args": ["serve"]}');
    } else {
      err(`MCP client endpoint (http): http://127.0.0.1:${port}/mcp`);
    }
    err("");
  }

  if (transport === "stdio") {
    await runStdio(createL6Server(store, { registry }));
    return 0;
  }

  try {
    runHttpServer(() => createL6Server(store, { registry }), {
      port,
      host,
      allowUnauthenticated,
      registry,
    });
  } catch (exc) {
    if (exc instanceof BindRefusedError) {
      process.stderr.write(`${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  // Block until interrupted (KeyboardInterrupt → clean exit 0).
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  return 0;
}
