/**
 * Participant parity + contract tests.
 *
 * For each seeded reader in the @getbourdon/conformance `native_stores` family:
 *   1. construct the REAL participant against the byte-identical seeded store,
 *   2. exportL5() → toDict(),
 *   3. apply the SAME freeze the generator applies (last_updated → a fixed valid
 *      date-time; agent.instance → 'conformance-host' where present),
 *   4. assert it validates against L5_schema.json AND equals expected_l5.json.
 *
 * Only the export_l5 OUTPUT SHAPE is the contract (internal scraping is not).
 * Plus the contract invariants: healthCheck never throws on a missing store, and
 * discoverParticipants log-and-skips a participant that throws on construction.
 */

import { join } from "node:path";

import { conformanceDir } from "@getbourdon/conformance";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ClaudeCodeParticipant,
  GitHubCopilotParticipant,
  HermesParticipant,
  discoverParticipants,
  sqliteAvailable,
  toDict,
  validateManifest,
  type BourdonParticipant,
  type L5ManifestModel,
} from "../src/index.js";

const NATIVE = join(conformanceDir(), "native_stores");
const FROZEN_LAST_UPDATED = "2026-06-29T00:00:00+00:00";
const FROZEN_INSTANCE = "conformance-host";

function readExpected(reader: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(NATIVE, reader, "expected_l5.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/** Freeze the two runtime-bound fields exactly as `_freeze_native_l5` does. */
function freeze(manifest: L5ManifestModel): Record<string, unknown> {
  const d = JSON.parse(JSON.stringify(toDict(manifest))) as Record<string, unknown>;
  d["last_updated"] = FROZEN_LAST_UPDATED;
  const agent = d["agent"];
  if (agent && typeof agent === "object" && "instance" in (agent as Record<string, unknown>)) {
    (agent as Record<string, unknown>)["instance"] = FROZEN_INSTANCE;
  }
  return d;
}

function assertSchemaValid(frozen: Record<string, unknown>): void {
  const result = validateManifest(frozen);
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
}

// ---------------------------------------------------------------------------
// hermes — SQLite reader (gated on the native addon)
// ---------------------------------------------------------------------------

describe.skipIf(!sqliteAvailable())("hermes (sqlite reader)", () => {
  const home = join(NATIVE, "hermes", "store", ".hermes");

  it("exportL5().toDict() == expected_l5.json (frozen) + schema-valid", () => {
    const p = new HermesParticipant(home);
    const frozen = freeze(p.exportL5());
    assertSchemaValid(frozen);
    expect(frozen).toEqual(readExpected("hermes"));
  });

  it("exportL5 is deterministic (byte-identical on re-run)", () => {
    const a = freeze(new HermesParticipant(home).exportL5());
    const b = freeze(new HermesParticipant(home).exportL5());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// claude_code — file/convention reader
// ---------------------------------------------------------------------------

describe("claude_code (file reader)", () => {
  const store = join(NATIVE, "claude_code", "store");

  function seeded(): ClaudeCodeParticipant {
    // Seed the three discovered sources directly — path resolution is not the
    // parity contract (matches the generator's hermetic construction).
    const p = new ClaudeCodeParticipant();
    p.brainPath = join(store, "brain");
    p.autoMemoryPath = join(store, "auto_memory");
    p.knowledgeGraphPath = join(store, "knowledge_graph", "memory.jsonl");
    return p;
  }

  it("exportL5().toDict() == expected_l5.json (frozen) + schema-valid", () => {
    const frozen = freeze(seeded().exportL5());
    assertSchemaValid(frozen);
    expect(frozen).toEqual(readExpected("claude_code"));
  });

  it("drops PRIVATE entities (person + credential observation) before emission", () => {
    const entities = (freeze(seeded().exportL5())["known_entities"] ?? []) as Array<{
      name: string;
    }>;
    const names = entities.map((e) => e.name);
    expect(names).not.toContain("Ry Guy"); // type: person
    expect(names).not.toContain("SecretCreds"); // service_role observation
  });
});

// ---------------------------------------------------------------------------
// github_copilot — network reader, offline-from-cache
// ---------------------------------------------------------------------------

describe("github_copilot (network reader)", () => {
  const cacheRoot = join(NATIVE, "github_copilot", "cache");

  function seeded(): GitHubCopilotParticipant {
    // Infinite TTL + null auth → reads the seeded cache offline, never touches
    // the network or a token.
    const p = new GitHubCopilotParticipant({ authProvider: () => null, cacheRoot });
    p.cacheTtlSeconds = Number.POSITIVE_INFINITY;
    return p;
  }

  it("exportL5().toDict() == expected_l5.json (frozen) + schema-valid", () => {
    const frozen = freeze(seeded().exportL5());
    assertSchemaValid(frozen);
    expect(frozen).toEqual(readExpected("github_copilot"));
  });

  it("redacts a credential-keyword PR title in the emitted session", () => {
    const sessions = (freeze(seeded().exportL5())["recent_sessions"] ?? []) as Array<{
      key_actions: string[];
    }>;
    const flat = sessions.flatMap((s) => s.key_actions);
    expect(flat).toContain("PR #9: [redacted credential-like text]");
  });

  it("healthCheck never throws and reports ok on a fresh cache", () => {
    expect(() => seeded().healthCheck()).not.toThrow();
    expect(seeded().healthCheck().status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Contract invariants
// ---------------------------------------------------------------------------

describe("contract invariants", () => {
  it("healthCheck never throws on a missing store (all readers)", () => {
    const missing = join(NATIVE, "__does_not_exist__");
    const readers: BourdonParticipant[] = [
      new HermesParticipant(join(missing, ".hermes")),
      (() => {
        const p = new ClaudeCodeParticipant();
        p.brainPath = null;
        p.autoMemoryPath = null;
        p.knowledgeGraphPath = null;
        return p;
      })(),
      new GitHubCopilotParticipant({ authProvider: () => null, cacheRoot: missing }),
    ];
    for (const r of readers) {
      expect(() => r.healthCheck()).not.toThrow();
      expect(["ok", "degraded", "blocked"]).toContain(r.healthCheck().status);
    }
  });

  it("discoverParticipants log-and-skips a participant that throws on construction", () => {
    class BrokenParticipant {
      agentId = "broken";
      agentType = "other";
      constructor() {
        throw new Error("boom");
      }
    }
    const result = discoverParticipants([
      BrokenParticipant as unknown as new () => BourdonParticipant,
      HermesParticipant as unknown as new () => BourdonParticipant,
    ]);
    const ids = result.map((r) => r.agentId);
    expect(ids).toContain("hermes");
    expect(ids).not.toContain("broken");
  });

  it("discoverParticipants returns the first-party set sorted by agentId", () => {
    const ids = discoverParticipants().map((r) => r.agentId);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain("claude-code");
    expect(ids).toContain("github-copilot");
  });
});
