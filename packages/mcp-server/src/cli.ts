#!/usr/bin/env node
/**
 * `bourdon-l6-server` — CLI entry point. Port of `core/l6_server.py`'s
 * `main()` / `_parse_args()` / `run_l6_server()`.
 *
 * Defaults match the Python server byte-for-byte: `--transport stdio`,
 * `--port 7500`, `--host 127.0.0.1`. A non-loopback HTTP bind without auth
 * refuses to start (non-zero exit). stdio resolves to OPERATOR.
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parse as yamlParse } from "yaml";

import { BindRefusedError, runHttpServer } from "./http-transport.js";
import { createL6Server } from "./server.js";
import { runStdio } from "./stdio.js";

const DEFAULT_PEERS_CONFIG = join(homedir(), ".bourdon", "peers.yaml");

interface Args {
  library: string;
  transport: "stdio" | "http";
  port: number;
  host: string;
  peer: string[];
  peersConfig: string;
  allowUnauthenticated: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    library: DEFAULT_LIBRARY_PATH,
    transport: "stdio",
    port: 7500,
    host: "127.0.0.1",
    peer: [],
    peersConfig: DEFAULT_PEERS_CONFIG,
    allowUnauthenticated: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--library":
        args.library = next();
        break;
      case "--transport": {
        const t = next();
        if (t !== "stdio" && t !== "http") throw new Error(`invalid --transport: ${t}`);
        args.transport = t;
        break;
      }
      case "--port":
        args.port = Number.parseInt(next(), 10);
        break;
      case "--host":
        args.host = next();
        break;
      case "--peer":
        args.peer.push(next());
        break;
      case "--peers-config":
        args.peersConfig = next();
        break;
      case "--allow-unauthenticated":
        args.allowUnauthenticated = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

/** An MCP-SDK-backed peer transport: open a streamable-HTTP client per call,
 * invoke the tool, recover the JSON-in-TextContent payload, close. */
function sdkPeerTransport(): PeerTransport {
  return {
    async callTool(toolName, toolArgs, opts) {
      const headerInit = opts.headers as Record<string, string>;
      const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
        requestInit: { headers: headerInit },
      });
      const client = new Client({ name: "@getbourdon/mcp-server peer", version: "0.1.0" }, { capabilities: {} });
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
        const tokenEnv = typeof e.token_env === "string" && e.token_env ? e.token_env : "BOURDON_PEER_TOKEN";
        if (seen.has(url)) continue;
        seen.add(url);
        peers.push(new RemoteL6Client({ url, name, tokenEnv, transport }));
      }
    } catch (exc) {
      console.warn(`Failed to load peers config ${configPath}: ${String(exc)}`);
    }
  }
  for (const url of inlineUrls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    peers.push(new RemoteL6Client({ url, name: url, transport }));
  }
  return peers;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const peers = loadPeers(args.peersConfig, args.peer);
  const store = new L6Store(args.library, peers);
  const registry = new FederationRegistry();

  process.stderr.write(
    `Bourdon L6 server starting — library=${args.library}, transport=${args.transport}, peers=${peers.length}\n`,
  );

  if (args.transport === "stdio") {
    await runStdio(createL6Server(store, { registry }));
    return;
  }
  runHttpServer(() => createL6Server(store, { registry }), {
    port: args.port,
    host: args.host,
    allowUnauthenticated: args.allowUnauthenticated,
    registry,
  });
}

main().catch((exc) => {
  if (exc instanceof BindRefusedError) {
    process.stderr.write(`${exc.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`fatal: ${String(exc instanceof Error ? exc.stack : exc)}\n`);
  process.exit(1);
});
