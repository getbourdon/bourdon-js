import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { conformanceDir } from "@getbourdon/conformance";
import { describe, expect, it } from "vitest";

import {
  AgentIdentity,
  decodeCursor,
  encodeCursor,
  enforceToolAccess,
  FederationAudit,
  FederationRegistry,
  L6Store,
  serializeEntry,
  TIER_QUARANTINED,
  TIER_TRUSTED,
  type AuditEntry,
} from "../src/index.js";

const dir = conformanceDir();
const seedLibrary = join(dir, "fed_seed_library");

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(dir, rel), "utf8")) as T;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bourdon-fed-"));
}

// ---------------------------------------------------------------------------
// fed_seed_library — L6Store query primitives + visibility
// ---------------------------------------------------------------------------

describe("L6Store over fed_seed_library", () => {
  const store = new L6Store(seedLibrary);

  it("listAgents == [claude-code, codex]", () => {
    expect(store.listAgents()).toEqual(["claude-code", "codex"]);
  });

  it("findEntity('Bourdon') spans both agents (public)", () => {
    const matches = store.findEntity("Bourdon");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe("Bourdon");
    expect([...matches[0]!.agents].sort()).toEqual(["claude-code", "codex"]);
  });

  it("findEntity matches aliases (NeuroLayer -> Bourdon on claude-code)", () => {
    const matches = store.findEntity("NeuroLayer");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe("Bourdon");
    expect(matches[0]!.agents).toContain("claude-code");
  });

  it("visibility filtering: team/private rows hidden at public", () => {
    // Roadmap is team-only; Quarterly Revenue is private.
    expect(store.findEntity("Roadmap")).toHaveLength(0);
    expect(store.findEntity("Roadmap", false, "team")).toHaveLength(1);
    expect(store.findEntity("Quarterly Revenue", false, "team")).toHaveLength(0);
    expect(store.findEntity("Quarterly Revenue", false, "private")).toHaveLength(1);
  });

  it("getAgentManifest filters entities/sessions by access level", () => {
    const pub = store.getAgentManifest("claude-code", false, "public")!;
    expect((pub.known_entities as unknown[]).length).toBe(1); // Bourdon only
    const team = store.getAgentManifest("claude-code", false, "team")!;
    expect((team.known_entities as unknown[]).length).toBe(2); // + Roadmap
    const priv = store.getAgentManifest("claude-code", false, "private")!;
    expect((priv.known_entities as unknown[]).length).toBe(3); // + Quarterly Revenue
  });

  it("listRecentWork: cursor pagination is stable and lossless", () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const all = store.listRecentWork({ since, accessLevel: "private", limit: 100 });
    const total = all.sessions.length;
    expect(total).toBeGreaterThan(2);

    // Page size 2 across the full set; collect via cursor.
    const collected: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = store.listRecentWork({
        since,
        accessLevel: "private",
        limit: 2,
        cursor,
      });
      for (const s of page.sessions) collected.push(`${s.date}|${s.agent}`);
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor && guard < 50);

    const oneShot = all.sessions.map((s) => `${s.date}|${s.agent}`);
    expect(collected).toEqual(oneShot);
    // Newest-first, agent-desc tiebreak.
    expect(oneShot[0]!.startsWith("2026-06-08")).toBe(true);
  });

  it("getCrossAgentSummary('Bourdon') aggregates entities + focus sessions", () => {
    const summary = store.getCrossAgentSummary("Bourdon", false, "private");
    expect(summary.entities.some((e) => e.name === "Bourdon")).toBe(true);
    expect(summary.agents).toContain("claude-code");
    // claude-code has a session with project_focus [Bourdon].
    expect(summary.recentSessions.some((s) => s.projectFocus.includes("Bourdon"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cursor invariants
// ---------------------------------------------------------------------------

describe("base64url cursor", () => {
  it("round-trips offsets", () => {
    for (const n of [0, 1, 20, 99, 1000]) {
      expect(decodeCursor(encodeCursor(n))).toBe(n);
    }
  });

  it("null/empty -> 0", () => {
    expect(decodeCursor(null)).toBe(0);
    expect(decodeCursor("")).toBe(0);
    expect(decodeCursor(undefined)).toBe(0);
  });

  it("throws on a non-empty unreadable cursor (never silent offset-0)", () => {
    expect(() => decodeCursor("not-base64-$$$")).toThrow();
    expect(() => decodeCursor(encodeCursor(-1 as unknown as number))).toThrow();
    // negative offset embedded:
    const neg = Buffer.from(JSON.stringify({ offset: -5 }), "utf8").toString("base64url");
    expect(() => decodeCursor(neg)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// tier_matrix.json — enforcement parity
// ---------------------------------------------------------------------------

interface TierCase {
  tool: string;
  tier: "trusted" | "quarantined";
  namespace: string | null;
  granted: boolean | null;
  args: Record<string, unknown>;
  decision: "allow" | "deny";
  denial: Record<string, unknown> | null;
}
interface TierMatrix {
  denial_shape: { keys: string[]; error_value: string };
  caller: {
    trusted: { agent_id: string; tier: string };
    quarantined: { agent_id: string; tier: string; grants: string[] };
  };
  cases: TierCase[];
}

describe("tier_matrix enforcement", () => {
  const matrix = readJson<TierMatrix>("tier_matrix.json");
  const callers = {
    trusted: new AgentIdentity(matrix.caller.trusted.agent_id, TIER_TRUSTED),
    quarantined: new AgentIdentity(
      matrix.caller.quarantined.agent_id,
      TIER_QUARANTINED,
      matrix.caller.quarantined.grants,
    ),
  };

  for (const c of matrix.cases) {
    it(`${c.tool} / ${c.tier} / granted=${c.granted} -> ${c.decision}`, () => {
      const caller = callers[c.tier];
      const result = enforceToolAccess(c.tool, caller, c.args);
      expect(result.decision).toBe(c.decision);
      if (c.decision === "deny") {
        expect(result.denial).not.toBeNull();
        const denial = result.denial as unknown as Record<string, unknown>;
        // Verbatim match of the structured denial (key set + values incl. the
        // single-quoted detail prose).
        expect(denial).toEqual(c.denial);
        // Key set parity (order-independent).
        expect(Object.keys(denial).sort()).toEqual(Object.keys(c.denial!).sort());
        expect(denial.error).toBe("access denied");
      } else {
        expect(result.denial).toBeNull();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// on_disk/federation.yaml + auth_vectors.json — registry authenticate parity
// ---------------------------------------------------------------------------

interface AuthVector {
  name: string;
  token_fragments: string[];
  expect: { agent_id: string; tier: string; grants: string[] } | null;
}

describe("FederationRegistry over on_disk fixtures", () => {
  const registryPath = join(dir, "on_disk", "federation.yaml");
  const vectors = readJson<{ vectors: AuthVector[] }>("on_disk/auth_vectors.json").vectors;
  const registry = new FederationRegistry(registryPath);

  for (const v of vectors) {
    it(`authenticate(${v.name}) reproduces the oracle`, () => {
      const token = v.token_fragments.join("");
      const identity = registry.authenticate(token);
      if (v.expect === null) {
        expect(identity).toBeNull();
      } else {
        expect(identity).not.toBeNull();
        expect(identity!.agentId).toBe(v.expect.agent_id);
        expect(identity!.tier).toBe(v.expect.tier);
        expect([...identity!.grants]).toEqual(v.expect.grants);
      }
    });
  }

  it("token sha256 in the fixture matches sha256(joined token)", () => {
    const trusted = vectors.find((v) => v.name === "trusted_member")!;
    const token = trusted.token_fragments.join("");
    const sha = createHash("sha256").update(token, "utf8").digest("hex");
    const fileText = readFileSync(registryPath, "utf8");
    expect(fileText).toContain(sha);
  });

  it("isConfigured() true (rows exist), revoked member never authenticates", () => {
    expect(registry.isConfigured()).toBe(true);
    const revoked = vectors.find((v) => v.name === "revoked_member")!;
    expect(registry.authenticate(revoked.token_fragments.join(""))).toBeNull();
  });

  it("empty token authenticates NOWHERE", () => {
    expect(registry.authenticate("")).toBeNull();
    expect(registry.authenticate(null)).toBeNull();
    expect(registry.authenticate(undefined)).toBeNull();
  });

  it("no token plaintext is stored on disk (only sha256 hashes)", () => {
    const fileText = readFileSync(registryPath, "utf8");
    expect(fileText).not.toContain("bdn_");
  });
});

// ---------------------------------------------------------------------------
// Registry token lifecycle (round-trip on a temp registry)
// ---------------------------------------------------------------------------

describe("FederationRegistry token lifecycle", () => {
  it("addAgent issues a bdn_ token, authenticates, revoke kills it", () => {
    const tmp = tempDir();
    try {
      const reg = new FederationRegistry(join(tmp, "federation.yaml"));
      const token = reg.addAgent("openclaw", "quarantined", ["claude-code"]);
      expect(token.startsWith("bdn_")).toBe(true);
      expect(token).toHaveLength(4 + 48); // bdn_ + 24 bytes hex

      const ident = reg.authenticate(token);
      expect(ident!.agentId).toBe("openclaw");
      expect(ident!.isTrusted).toBe(false);
      expect(ident!.mayRead("claude-code")).toBe(true);
      expect(ident!.mayRead("codex")).toBe(false);

      // Plaintext never persisted.
      expect(readFileSync(reg.path, "utf8")).not.toContain(token);

      reg.revoke("openclaw");
      expect(reg.authenticate(token)).toBeNull();
      expect(reg.isConfigured()).toBe(true); // still configured, just 401s now
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("duplicate non-revoked add raises", () => {
    const tmp = tempDir();
    try {
      const reg = new FederationRegistry(join(tmp, "federation.yaml"));
      reg.addAgent("dup");
      expect(() => reg.addAgent("dup")).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// on_disk/audit.jsonl — audit read + serialization parity
// ---------------------------------------------------------------------------

describe("FederationAudit over on_disk/audit.jsonl", () => {
  const auditPath = join(dir, "on_disk", "audit.jsonl");

  it("reads every record and tolerates the line format", () => {
    const audit = new FederationAudit(auditPath);
    const rows = audit.entries();
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(rows).toHaveLength(lines.length);
    expect(rows[0]!.op).toBe("find_entity");
    expect(rows[0]!.decision).toBe("allow");
  });

  it("denials_only + agent filters work; most-recent-last", () => {
    const audit = new FederationAudit(auditPath);
    const denials = audit.entries(null, true);
    expect(denials.every((e) => e.decision === "deny")).toBe(true);
    const openclaw = audit.entries("openclaw");
    expect(openclaw.every((e) => e.agent === "openclaw")).toBe(true);
  });

  it("serializeEntry reproduces the committed bytes EXACTLY (spaces after :/,)", () => {
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    for (const line of lines) {
      const parsed = JSON.parse(line) as AuditEntry;
      // Rebuild from the parsed object (key order preserved by JSON.parse).
      expect(serializeEntry(parsed)).toBe(line);
    }
  });

  it("record() emits the microsecond ts + key order + omits falsy detail", () => {
    const tmp = tempDir();
    try {
      const audit = new FederationAudit(join(tmp, "audit.jsonl"));
      audit.record("openclaw", "find_entity", "claude-code", "allow");
      audit.record("openclaw", "query_agent_memory", "codex", "deny", "namespace 'codex' not granted");
      const written = readFileSync(audit.path, "utf8").trim().split("\n");
      const first = JSON.parse(written[0]!) as AuditEntry;
      expect(Object.keys(first)).toEqual(["ts", "agent", "op", "namespace", "decision"]); // no detail
      expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      const second = JSON.parse(written[1]!) as AuditEntry;
      expect(second.detail).toBe("namespace 'codex' not granted");
      expect(written[1]).toContain('"decision": "deny"'); // default separators
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// commitL5 async mutex — concurrent commits must not lose updates
// ---------------------------------------------------------------------------

describe("commitL5 async mutex", () => {
  it("20 concurrent commits to the same agent all land (no lost update)", async () => {
    const tmp = tempDir();
    try {
      const store = new L6Store(tmp);
      const N = 20;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          store.commitL5("claude-desktop-chat", {
            agentType: "other",
            entities: [{ name: `Entity${i}`, type: "topic", summary: `s${i}` }],
            mode: "merge",
          }),
        ),
      );
      const fresh = new L6Store(tmp);
      const manifest = fresh.getAgentManifest("claude-desktop-chat", false, "private")!;
      const names = (manifest.known_entities as { name: string }[]).map((e) => e.name).sort();
      expect(names).toHaveLength(N);
      for (let i = 0; i < N; i++) expect(names).toContain(`Entity${i}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("commitL5 validates agent_id and agent_type", async () => {
    const tmp = tempDir();
    try {
      const store = new L6Store(tmp);
      await expect(store.commitL5("Bad Id", { agentType: "other" })).rejects.toThrow();
      await expect(store.commitL5("newagent", {})).rejects.toThrow(); // no agent_type for new
      await expect(
        store.commitL5("newagent", { agentType: "not-a-real-type" }),
      ).rejects.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AgentIdentity DENY-BY-DEFAULT
// ---------------------------------------------------------------------------

describe("AgentIdentity", () => {
  it("trusted mayRead everything; quarantined deny-by-default", () => {
    const trusted = new AgentIdentity("operator", TIER_TRUSTED);
    expect(trusted.isTrusted).toBe(true);
    expect(trusted.mayRead("anything")).toBe(true);

    const q = new AgentIdentity("openclaw", TIER_QUARANTINED, ["claude-code"]);
    expect(q.isTrusted).toBe(false);
    expect(q.mayRead("claude-code")).toBe(true);
    expect(q.mayRead("codex")).toBe(false);
  });

  it("is frozen (immutable)", () => {
    const q = new AgentIdentity("openclaw", TIER_QUARANTINED, ["claude-code"]);
    expect(Object.isFrozen(q)).toBe(true);
  });
});
