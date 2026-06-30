import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { conformanceDir } from "@getbourdon/conformance";
import { stringify as yamlStringify } from "yaml";
import { describe, expect, it } from "vitest";

import {
  BackendCapabilities,
  BackendUnsupported,
  type InferenceBackend,
  L2Config,
  type L2Client,
  type Slot,
  type TurnBrief,
  compileCodexTurn,
  compileCursorTurn,
  formatL2Context,
  parseBool,
  parseSseLine,
  queryL2,
  registerBackend,
  turnBriefToDict,
} from "../src/index.js";

function fakeBackend(caps: BackendCapabilities): InferenceBackend {
  return {
    capabilities: () => caps,
    slots: async (): Promise<Slot[]> => [{ id: 0, busy: false }],
    // eslint-disable-next-line require-yield
    streamCompletion: async function* () {
      return;
    },
    cancel: async () => {},
  };
}

const fullCaps = new BackendCapabilities({
  streaming: true,
  cancel: true,
  concurrentSlots: 4,
  kvCacheReuse: true,
});

describe("@getbourdon/inference protocol", () => {
  it("supports() — concurrent_slots is true only when count > 1; unknown names false", () => {
    expect(fullCaps.supports("streaming")).toBe(true);
    expect(fullCaps.supports("cancel")).toBe(true);
    expect(fullCaps.supports("kv_cache_reuse")).toBe(true);
    expect(fullCaps.supports("concurrent_slots")).toBe(true);
    const single = new BackendCapabilities({
      streaming: true,
      cancel: false,
      concurrentSlots: 1,
      kvCacheReuse: false,
    });
    expect(single.supports("concurrent_slots")).toBe(false);
    expect(single.supports("nonsense")).toBe(false);
  });

  it("registerBackend returns the backend when capabilities are met", () => {
    expect(registerBackend(fakeBackend(fullCaps), ["streaming"])).toBeTruthy();
    expect(registerBackend(fakeBackend(fullCaps), ["streaming", "cancel", "kv_cache_reuse"])).toBeTruthy();
  });

  it("registerBackend throws BackendUnsupported listing every missing capability (sorted, deduped)", () => {
    const weak = fakeBackend(
      new BackendCapabilities({ streaming: true, cancel: false, concurrentSlots: 1, kvCacheReuse: false }),
    );
    try {
      registerBackend(weak, ["cancel", "kv_cache_reuse", "cancel"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BackendUnsupported);
      expect((e as BackendUnsupported).missing).toEqual(["cancel", "kv_cache_reuse"]);
    }
  });

  it("registerBackend throws TypeError on a non-backend or a bare-string requirement", () => {
    expect(() => registerBackend({}, ["streaming"])).toThrow(TypeError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => registerBackend(fakeBackend(fullCaps), "streaming" as any)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// llama.cpp SSE line parser (the platform-independent unit surface).
// ---------------------------------------------------------------------------

describe("parseSseLine null-cases", () => {
  it("returns null for empty, comment, retry, and non-data lines", () => {
    expect(parseSseLine("")).toBeNull();
    expect(parseSseLine(": keep-alive comment")).toBeNull();
    expect(parseSseLine("event: message")).toBeNull();
    expect(parseSseLine("retry: 1000")).toBeNull();
    expect(parseSseLine("data:")).toBeNull(); // empty payload
    expect(parseSseLine("data:   ")).toBeNull(); // whitespace-only payload
  });

  it("skips malformed JSON (never raises) and non-dict JSON", () => {
    expect(parseSseLine("data: not json")).toBeNull();
    expect(parseSseLine("data: [1,2,3]")).toBeNull(); // list is not a dict
    expect(parseSseLine('data: "a string"')).toBeNull();
    expect(parseSseLine("data: 42")).toBeNull();
  });

  it("parses both `data: {..}` and `data:{..}` (with/without space)", () => {
    expect(parseSseLine('data: {"content":"hi"}')).toEqual({ content: "hi" });
    expect(parseSseLine('data:{"content":"hi"}')).toEqual({ content: "hi" });
    expect(parseSseLine('data: {"stop":true,"id_slot":2}')).toEqual({ stop: true, id_slot: 2 });
  });
});

// ---------------------------------------------------------------------------
// L2: never raises, never blocks.
// ---------------------------------------------------------------------------

describe("queryL2 never raises / never blocks", () => {
  it("returns '' immediately when disabled (no client constructed)", async () => {
    const cfg = new L2Config({ enabled: false });
    const exploding: L2Client = {
      query: async () => {
        throw new Error("should never be called");
      },
    };
    expect(await queryL2("anything", cfg, exploding)).toBe("");
  });

  it("returns '' (does not hang) under a hung retriever that ignores the signal", async () => {
    const cfg = new L2Config({ enabled: true, timeoutSeconds: 0.05 });
    const hung: L2Client = {
      query: () => new Promise<string>(() => undefined), // never resolves
    };
    const t0 = Date.now();
    expect(await queryL2("hello", cfg, hung)).toBe("");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("passes an abort signal the client can use to actually cancel", async () => {
    const cfg = new L2Config({ enabled: true, timeoutSeconds: 0.05 });
    let sawAbort = false;
    const cancellable: L2Client = {
      query: (_q, _k, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted"));
          });
        }),
    };
    expect(await queryL2("hello", cfg, cancellable)).toBe("");
    expect(sawAbort).toBe(true);
  });

  it("returns '' when the client throws", async () => {
    const cfg = new L2Config({ enabled: true, timeoutSeconds: 1 });
    const failing: L2Client = {
      query: async () => {
        throw new Error("retriever down");
      },
    };
    expect(await queryL2("hello", cfg, failing)).toBe("");
  });

  it("returns the formatted context on success", async () => {
    const cfg = new L2Config({ enabled: true, timeoutSeconds: 1 });
    const ok: L2Client = { query: async () => "  episodic context  " };
    expect(await queryL2("hello", cfg, ok)).toBe("  episodic context  ");
  });
});

describe("L2 helpers", () => {
  it("parseBool covers truthy/falsy/unparseable", () => {
    expect(parseBool("yes")).toBe(true);
    expect(parseBool("OFF")).toBe(false);
    expect(parseBool(1)).toBe(true);
    expect(parseBool(true)).toBe(true);
    expect(parseBool("maybe")).toBeNull();
  });

  it("formatL2Context normalizes strings, lists, dicts, and .content holders", () => {
    expect(formatL2Context(null)).toBe("");
    expect(formatL2Context("  x  ")).toBe("x");
    expect(formatL2Context(["a", { text: "b" }, { summary: "c" }])).toBe("a\n\n---\n\nb\n\n---\n\nc");
    expect(formatL2Context({ content: [{ text: "z" }] })).toBe("z");
  });
});

// ---------------------------------------------------------------------------
// Turn compilers — parity against conformance/turn_compiler_vectors.json.
// ---------------------------------------------------------------------------

interface TurnVectors {
  frozen_clock: string;
  seed_library: Record<string, unknown>;
  codex_cases: CodexCase[];
  cursor_cases: CursorCase[];
}
interface CodexCase {
  name: string;
  prompt: string;
  cwd: string;
  access_level: string;
  recognition_confidence: string;
  item_scores: { rank: number; name: string; kind: string; source: string; score: number }[];
  brief: Record<string, unknown>;
}
interface CursorCase {
  name: string;
  prompt: string;
  cwd: string;
  access_level: string;
  recognition_confidence: string;
  cwd_project: string;
  prompt_tokens: string[];
  matched_entities: Record<string, unknown>[];
  routing: Record<string, string>;
}

function loadTurnVectors(): TurnVectors {
  return JSON.parse(
    readFileSync(resolve(conformanceDir(), "turn_compiler_vectors.json"), "utf8"),
  ) as TurnVectors;
}

/** Materialize the seed_library as a temp L6 library (agents/*.l5.yaml). */
function writeSeedLibrary(seed: Record<string, unknown>): string {
  const libDir = mkdtempSync(join(tmpdir(), "bourdon-turnlib-"));
  const agentsDir = join(libDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [filename, manifest] of Object.entries(seed)) {
    writeFileSync(join(agentsDir, filename), yamlStringify(manifest, { sortMapEntries: false }), "utf8");
  }
  return libDir;
}

describe("turn compilers parity (turn_compiler_vectors)", () => {
  const vectors = loadTurnVectors();
  const now = new Date(`${vectors.frozen_clock}T12:00:00Z`);
  const libDir = writeSeedLibrary(vectors.seed_library);
  const codexHome = mkdtempSync(join(tmpdir(), "bourdon-codexhome-")); // empty: no state_5.sqlite

  const round1 = (x: number): number => Math.round(x * 10) / 10;

  for (const kase of vectors.codex_cases) {
    it(`codex ${kase.name}: item scores + recognition bucket + to_dict`, () => {
      const brief: TurnBrief = compileCodexTurn(kase.prompt, {
        cwd: kase.cwd,
        codexHome,
        libraryPath: libDir,
        accessLevel: kase.access_level,
        now,
      });

      // item scores (round 1 dp)
      const itemScores = brief.items.map((item) => ({
        rank: item.rank,
        name: item.name,
        kind: item.kind,
        source: item.source,
        score: round1(item.score),
      }));
      expect(itemScores).toEqual(kase.item_scores);

      // shared tier-only recognition bucket
      expect(brief.routing.confidence).toBe(kase.recognition_confidence);

      // full TurnBrief.to_dict — swap the env-bound cwd back to the logical input
      const dict = turnBriefToDict(brief);
      dict.cwd = kase.cwd;
      expect((dict.repo as Record<string, unknown>).root).toBeNull();
      expect((dict.repo as Record<string, unknown>).remote).toBeNull();
      expect(dict).toEqual(kase.brief);
    });
  }

  for (const kase of vectors.cursor_cases) {
    it(`cursor ${kase.name}: matched entities + tokens + routing`, () => {
      const brief = compileCursorTurn(kase.prompt, {
        cwd: kase.cwd,
        accessLevel: kase.access_level,
        libraryPath: libDir,
        now,
      });
      expect(brief.cwdProject).toBe(kase.cwd_project);
      expect(brief.promptTokens).toEqual(kase.prompt_tokens);
      expect(brief.matchedEntities).toEqual(kase.matched_entities);
      expect(brief.routing).toEqual(kase.routing);
      // compileLatencyUs is runtime-dependent — assert present but excluded above.
      expect(typeof brief.compileLatencyUs).toBe("number");
    });
  }
});
