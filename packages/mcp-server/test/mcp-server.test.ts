import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  FederationAudit,
  FederationRegistry,
  L6Store,
  OPERATOR,
  AgentIdentity,
  TIER_QUARANTINED,
  runWithCaller,
} from "@getbourdon/federation";
import { conformanceDir } from "@getbourdon/conformance";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createL6Server } from "../src/server.js";
import {
  authenticateBearer,
  BindRefusedError,
  isLoopbackHost,
  normalizedLegacyToken,
  runHttpServer,
} from "../src/http-transport.js";
import { normalizeSnapshot } from "./normalize.js";

const dir = conformanceDir();
const seedLibrary = join(dir, "fed_seed_library");
const snapshotsDir = join(dir, "mcp_snapshots");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function tempLibCopy(): string {
  const tmp = mkdtempSync(join(tmpdir(), "bourdon-mcp-"));
  cpSync(seedLibrary, join(tmp, "lib"), { recursive: true });
  return join(tmp, "lib");
}

/** Build a fresh server over a fresh temp copy of the seed, wired with throwaway
 * registry + audit (temp paths) so tests never touch ~/.bourdon. */
function freshServer(): { server: ReturnType<typeof createL6Server>; cleanup: () => void } {
  const lib = tempLibCopy();
  const reg = new FederationRegistry(join(lib, "..", "registry.yaml"));
  const audit = new FederationAudit(join(lib, "..", "audit.jsonl"));
  const store = new L6Store(lib);
  const server = createL6Server(store, { registry: reg, audit });
  return {
    server,
    cleanup: () => rmSync(join(lib, ".."), { recursive: true, force: true }),
  };
}

/** Connect an in-memory MCP client to a fresh server. Returns the client + a
 * teardown. The in-memory transport is wire-equivalent to stdio: OPERATOR. */
async function connectedClient(): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const { server, cleanup } = freshServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    cleanup: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      cleanup();
    },
  };
}

/** Recover a tool payload off the wire exactly as a Python peer would:
 * iterate content, take the TextContent `.text`, JSON.parse it. */
function firstJsonPayload(result: unknown): unknown {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("tool result has no content array");
  for (const item of content) {
    if (
      item !== null &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return JSON.parse((item as { text: string }).text);
    }
  }
  throw new Error("no TextContent JSON payload in tool result");
}

const PRESERVE_LOCAL_NAME = process.env.BOURDON_LOCAL_NAME;

beforeAll(() => {
  // Freeze the machine label so export_agents matches the snapshot.
  process.env.BOURDON_LOCAL_NAME = "conformance-host";
});

afterAll(() => {
  if (PRESERVE_LOCAL_NAME === undefined) delete process.env.BOURDON_LOCAL_NAME;
  else process.env.BOURDON_LOCAL_NAME = PRESERVE_LOCAL_NAME;
});

// ---------------------------------------------------------------------------
// Normalizer self-test — must match _normalizer.json pair-for-pair.
// ---------------------------------------------------------------------------

describe("snapshot normalizer", () => {
  interface NormalizerCase {
    raw: unknown;
    normalized: unknown;
  }
  const fixture = readJson<{ cases: NormalizerCase[] }>(join(snapshotsDir, "_normalizer.json"));

  it("has the 7 codified cases", () => {
    expect(fixture.cases.length).toBe(7);
  });

  for (const [i, kase] of fixture.cases.entries()) {
    it(`normalizer case #${i} matches the oracle`, () => {
      expect(normalizeSnapshot(kase.raw)).toEqual(kase.normalized);
    });
  }
});

// ---------------------------------------------------------------------------
// Wire-contract snapshot parity — every tool's normalized payload == the
// Python res fixture, recovered through the TextContent JSON envelope.
// ---------------------------------------------------------------------------

describe("mcp_snapshots parity (fed_seed_library)", () => {
  // compile_codex_turn is intentionally EXCLUDED from byte-equal snapshot parity:
  // its live output is environment-bound (resolves the live cwd, git repo name +
  // remote, repo-identity scoring), so the Python generator special-cases its
  // snapshot to a deferred stub. The real tool now returns a full brief at runtime
  // (matching the live Python server) — asserted structurally below.
  const TOOLS = [
    "query_agent_memory",
    "list_recent_work",
    "find_entity",
    "list_agents",
    "export_agents",
    "commit_to_federation",
    "get_cross_agent_summary",
    "prepare_recognition_context",
    "get_deeper_context",
  ];

  for (const tool of TOOLS) {
    it(`${tool} round-trips to its Python snapshot`, async () => {
      const req = readJson<{ tool: string; args: Record<string, unknown> }>(
        join(snapshotsDir, `${tool}.req.json`),
      );
      const expected = readJson<unknown>(join(snapshotsDir, `${tool}.res.json`));
      const { client, cleanup } = await connectedClient();
      try {
        const result = await client.callTool({ name: req.tool, arguments: req.args });
        // The envelope MUST be JSON-in-TextContent, never structured content.
        const content = (result as { content: { type: string; text: string }[] }).content;
        expect(Array.isArray(content)).toBe(true);
        expect(content[0]!.type).toBe("text");
        expect(typeof content[0]!.text).toBe("string");
        const payload = firstJsonPayload(result);
        expect(normalizeSnapshot(payload)).toEqual(expected);
      } finally {
        await cleanup();
      }
    });
  }

  it("compile_codex_turn returns a real turn brief (env-bound; not the deferred stub)", async () => {
    const { client, cleanup } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "compile_codex_turn",
        arguments: { prompt: "Bourdon recognition", access_level: "team" },
      });
      const payload = firstJsonPayload(result) as Record<string, unknown>;
      expect(payload.schema_version).toBe("codex-turn-brief/v1");
      expect(payload._status).toBeUndefined(); // no longer the deferred stub
      expect(typeof payload.routing).toBe("object");
      expect(Array.isArray(payload.items)).toBe(true);
      const routing = payload.routing as Record<string, unknown>;
      expect(["inject", "observe"]).toContain(routing.mode);
    } finally {
      await cleanup();
    }
  });

  it("prepare_recognition_context carried a numeric recognition_latency_us pre-normalize", async () => {
    const { client, cleanup } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "prepare_recognition_context",
        arguments: { prompt: "what about Bourdon", access_level: "team" },
      });
      const payload = firstJsonPayload(result) as Record<string, unknown>;
      expect(typeof payload.recognition_latency_us).toBe("number");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// stdio handshake smoke + tool/resource surface.
// ---------------------------------------------------------------------------

describe("tool + resource surface", () => {
  it("exposes exactly the 10 named tools", async () => {
    const { client, cleanup } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "commit_to_federation",
          "compile_codex_turn",
          "export_agents",
          "find_entity",
          "get_cross_agent_summary",
          "get_deeper_context",
          "list_agents",
          "list_recent_work",
          "prepare_recognition_context",
          "query_agent_memory",
        ].sort(),
      );
    } finally {
      await cleanup();
    }
  });

  it("exposes the static agents resource + the 2 templated resources", async () => {
    const { client, cleanup } = await connectedClient();
    try {
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toContain("agent-library://agents");
      const { resourceTemplates } = await client.listResourceTemplates();
      const templates = resourceTemplates.map((t) => t.uriTemplate);
      expect(templates).toContain("agent-library://agents/{agent_id}/memory");
      expect(templates).toContain("agent-library://entities/{name}");
    } finally {
      await cleanup();
    }
  });

  it("agent-library://agents resource returns JSON-in-text [claude-code, codex]", async () => {
    const { client, cleanup } = await connectedClient();
    try {
      const result = await client.readResource({ uri: "agent-library://agents" });
      const c = result.contents[0]!;
      expect(c.mimeType).toBe("application/json");
      expect(JSON.parse(c.text as string)).toEqual(["claude-code", "codex"]);
    } finally {
      await cleanup();
    }
  });

  it("agent-library://entities/Bourdon resource resolves the cross-agent view", async () => {
    const { client, cleanup } = await connectedClient();
    try {
      const result = await client.readResource({ uri: "agent-library://entities/Bourdon" });
      const payload = JSON.parse(result.contents[0]!.text as string) as { name: string }[];
      expect(payload).toHaveLength(1);
      expect(payload[0]!.name).toBe("Bourdon");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Quarantined enforcement (the tier gate the tools apply over the wire).
// ---------------------------------------------------------------------------

describe("quarantined enforcement", () => {
  function quarantinedServerCall(
    identity: AgentIdentity,
    fn: (server: ReturnType<typeof createL6Server>) => Promise<unknown>,
  ): Promise<unknown> {
    const { server, cleanup } = freshServer();
    return runWithCaller(identity, () => fn(server)).finally(() => {
      void server.close();
      cleanup();
    });
  }

  it("denies aggregate tools wholesale to a quarantined caller", async () => {
    const quarantined = new AgentIdentity("intruder", TIER_QUARANTINED, []);
    const { server, cleanup } = freshServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "q", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      // Drive the handler under the quarantined identity via AsyncLocalStorage.
      const result = await runWithCaller(quarantined, () =>
        client.callTool({
          name: "get_cross_agent_summary",
          arguments: { project: "Bourdon" },
        }),
      );
      const payload = firstJsonPayload(result) as Record<string, unknown>;
      expect(payload.error).toBe("access denied");
      expect(payload.tier).toBe("quarantined");
      expect(payload.op).toBe("get_cross_agent_summary");
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      cleanup();
    }
  });

  it("a quarantined caller may not query an ungranted namespace", async () => {
    const quarantined = new AgentIdentity("intruder", TIER_QUARANTINED, []);
    const { server, cleanup } = freshServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "q", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const result = await runWithCaller(quarantined, () =>
        client.callTool({
          name: "query_agent_memory",
          arguments: { agent: "claude-code", topic: "Bourdon" },
        }),
      );
      const payload = firstJsonPayload(result) as Record<string, unknown>;
      expect(payload.error).toBe("access denied");
      expect(payload.detail).toBe("namespace 'claude-code' not granted");
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      cleanup();
    }
  });

  it("a granted namespace is readable by a quarantined caller", async () => {
    const granted = new AgentIdentity("partner", TIER_QUARANTINED, ["claude-code"]);
    const { server, cleanup } = freshServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "q", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const result = await runWithCaller(granted, () =>
        client.callTool({
          name: "query_agent_memory",
          arguments: { agent: "claude-code", topic: "Bourdon" },
        }),
      );
      const payload = firstJsonPayload(result) as Record<string, unknown>;
      expect(payload.error).toBeUndefined();
      expect(payload.agent).toBe("claude-code");
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Auth middleware decision logic (503 / 401 / empty-bearer / loopback).
// ---------------------------------------------------------------------------

describe("Bearer auth middleware", () => {
  function tempRegistry(): FederationRegistry {
    const tmp = mkdtempSync(join(tmpdir(), "bourdon-reg-"));
    return new FederationRegistry(join(tmp, "federation.yaml"));
  }

  it("fails CLOSED with 503 when nothing is configured", () => {
    const reg = tempRegistry();
    const r = authenticateBearer(reg, null, "Bearer whatever");
    expect(r.kind).toBe("unconfigured");
  });

  it("401 'missing Bearer token' when the header is absent / malformed", () => {
    const reg = tempRegistry();
    const legacy = "op-secret-token";
    expect(authenticateBearer(reg, legacy, null)).toEqual({
      kind: "unauthorized",
      message: "missing Bearer token",
    });
    expect(authenticateBearer(reg, legacy, "Basic abc")).toEqual({
      kind: "unauthorized",
      message: "missing Bearer token",
    });
  });

  it("an EMPTY Bearer can never authenticate as OPERATOR", () => {
    const reg = tempRegistry();
    const legacy = "op-secret-token";
    // "Bearer " -> token == "" after strip. Must NOT match the legacy operator.
    const r = authenticateBearer(reg, legacy, "Bearer ");
    expect(r).toEqual({ kind: "unauthorized", message: "invalid or revoked Bearer token" });
  });

  it("the legacy token resolves to the trusted OPERATOR", () => {
    const reg = tempRegistry();
    const legacy = "op-secret-token";
    const r = authenticateBearer(reg, legacy, `Bearer ${legacy}`);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.identity).toBe(OPERATOR);
      expect(r.identity.isTrusted).toBe(true);
    }
  });

  it("an unknown token gets a non-distinguishing 401", () => {
    const reg = tempRegistry();
    const legacy = "op-secret-token";
    const r = authenticateBearer(reg, legacy, "Bearer not-the-token");
    expect(r).toEqual({ kind: "unauthorized", message: "invalid or revoked Bearer token" });
  });

  it("a registered per-agent token authenticates to its identity + tier", () => {
    const reg = tempRegistry();
    const token = reg.addAgent("peer-a", "trusted");
    const r = authenticateBearer(reg, null, `Bearer ${token}`);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.identity.agentId).toBe("peer-a");
      expect(r.identity.tier).toBe("trusted");
    }
  });

  it("a revoked per-agent token stops authenticating (401)", () => {
    const reg = tempRegistry();
    const token = reg.addAgent("peer-b", "trusted");
    reg.revoke("peer-b");
    const r = authenticateBearer(reg, null, `Bearer ${token}`);
    expect(r).toEqual({ kind: "unauthorized", message: "invalid or revoked Bearer token" });
  });
});

describe("normalizedLegacyToken", () => {
  const PRESERVE = process.env.BOURDON_PEER_TOKEN_SERVER;
  afterAll(() => {
    if (PRESERVE === undefined) delete process.env.BOURDON_PEER_TOKEN_SERVER;
    else process.env.BOURDON_PEER_TOKEN_SERVER = PRESERVE;
  });

  it("maps a set-but-empty / whitespace token to null (P1-1)", () => {
    process.env.BOURDON_PEER_TOKEN_SERVER = "   ";
    expect(normalizedLegacyToken()).toBeNull();
    process.env.BOURDON_PEER_TOKEN_SERVER = "";
    expect(normalizedLegacyToken()).toBeNull();
  });

  it("passes a real token through", () => {
    process.env.BOURDON_PEER_TOKEN_SERVER = "real-token";
    expect(normalizedLegacyToken()).toBe("real-token");
  });
});

describe("loopback bind contract", () => {
  it("recognizes loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
    expect(isLoopbackHost("pc.tailnet")).toBe(false);
  });

  it("REFUSES a non-loopback bind with --allow-unauthenticated", () => {
    const reg = new FederationRegistry(join(mkdtempSync(join(tmpdir(), "r-")), "f.yaml"));
    expect(() =>
      runHttpServer(() => createL6Server(new L6Store(seedLibrary), { registry: reg }), {
        host: "0.0.0.0",
        allowUnauthenticated: true,
        registry: reg,
      }),
    ).toThrow(BindRefusedError);
  });

  it("REFUSES a non-loopback bind when no auth is configured", () => {
    const reg = new FederationRegistry(join(mkdtempSync(join(tmpdir(), "r-")), "f.yaml"));
    const PRESERVE = process.env.BOURDON_PEER_TOKEN_SERVER;
    delete process.env.BOURDON_PEER_TOKEN_SERVER;
    try {
      expect(() =>
        runHttpServer(() => createL6Server(new L6Store(seedLibrary), { registry: reg }), {
          host: "0.0.0.0",
          allowUnauthenticated: false,
          registry: reg,
        }),
      ).toThrow(BindRefusedError);
    } finally {
      if (PRESERVE === undefined) delete process.env.BOURDON_PEER_TOKEN_SERVER;
      else process.env.BOURDON_PEER_TOKEN_SERVER = PRESERVE;
    }
  });
});
