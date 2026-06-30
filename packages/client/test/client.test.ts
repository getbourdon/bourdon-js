import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { BourdonL6Client } from "../src/index.js";

/**
 * A minimal fake L6 server. It echoes the called tool name + arguments back inside
 * the SAME TextContent-JSON envelope the real Python L6 server uses
 * (`{content:[{type:'text', text: JSON.stringify(payload)}]}`), so these tests
 * prove the client's tool routing, argument forwarding, and — critically — that it
 * unwraps `json.loads(item.text)`-style payloads exactly like a Python peer would.
 * The `__rawtext__` tool returns non-JSON to exercise the parse fallback.
 */
function makeFakeL6(): Server {
  const server = new Server({ name: "fake-l6", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    if (name === "__rawtext__") {
      return { content: [{ type: "text", text: "not json" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ tool: name, args }) }] };
  });
  return server;
}

async function connectedClient(): Promise<{ client: BourdonL6Client; server: Server }> {
  const server = makeFakeL6();
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  const client = new BourdonL6Client({ transport: "custom", instance: clientEnd });
  return { client, server };
}

let open: BourdonL6Client | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe("@getbourdon/client tool routing + wire envelope", () => {
  it("each typed method routes to the right L6 tool name and unwraps the JSON payload", async () => {
    const { client } = await connectedClient();
    open = client;

    expect(await client.queryAgentMemory({ agent: "clyde", topic: "x" })).toMatchObject({
      tool: "query_agent_memory",
    });
    expect(await client.listRecentWork()).toMatchObject({ tool: "list_recent_work" });
    expect(await client.findEntity({ name: "Castmore" })).toMatchObject({ tool: "find_entity" });
    expect(await client.listAgents()).toMatchObject({ tool: "list_agents" });
    expect(await client.exportAgents()).toMatchObject({ tool: "export_agents" });
    expect(await client.getCrossAgentSummary({ project: "ILTT" })).toMatchObject({
      tool: "get_cross_agent_summary",
    });
    expect(await client.prepareRecognitionContext({ prompt: "p" })).toMatchObject({
      tool: "prepare_recognition_context",
    });
    expect(await client.getDeeperContext({ prompt: "p" })).toMatchObject({
      tool: "get_deeper_context",
    });
    expect(await client.compileCodexTurn({ prompt: "p" })).toMatchObject({
      tool: "compile_codex_turn",
    });
    expect(await client.commitToFederation({ agent_id: "clyde" })).toMatchObject({
      tool: "commit_to_federation",
    });
  });

  it("forwards provided args and drops undefined (so the server applies its own defaults)", async () => {
    const { client } = await connectedClient();
    open = client;

    const res = (await client.findEntity({
      name: "Castmore",
      access_level: "team",
      include_private: undefined,
    })) as { tool: string; args: Record<string, unknown> };

    expect(res.tool).toBe("find_entity");
    expect(res.args).toEqual({ name: "Castmore", access_level: "team" });
    expect("include_private" in res.args).toBe(false);
  });

  it("listAgents / exportAgents send no arguments", async () => {
    const { client } = await connectedClient();
    open = client;
    const res = (await client.listAgents()) as { args: Record<string, unknown> };
    expect(res.args).toEqual({});
  });

  it("falls back to raw text when the payload is not JSON", async () => {
    const { client } = await connectedClient();
    open = client;
    expect(await client.callTool("__rawtext__")).toBe("not json");
  });

  it("close() is idempotent", async () => {
    const { client } = await connectedClient();
    await client.listAgents();
    await client.close();
    await client.close();
  });
});
