import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { conformanceDir } from "@getbourdon/conformance";
import { parse as yamlParse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  bestMatchTier,
  containsSubsequence,
  detectEntities,
  loadCases,
  MATCH_TIER_NAME,
  matchTier,
  MatchTier,
  meets,
  normalizedConfidence,
  recognitionConfidence,
  recognitionFirst,
  runEval,
  tierFromName,
  tokenize,
  type ConfidenceBucket,
  type EntityDict,
} from "../src/index.js";

const dir = conformanceDir();

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(dir, rel), "utf8")) as T;
}

interface TierVector {
  prompt: string;
  names: string[];
  tier: string;
  confidence: ConfidenceBucket;
}
interface ConfidenceBucketVector {
  tier: string;
  n_anchor_terms: number;
  cwd_hit: boolean;
  recency_fresh: boolean;
  bucket: ConfidenceBucket;
}
interface RecognitionStringVector {
  name: string;
  prompt: string;
  manifest: Record<string, unknown>;
  access_level: string;
  matched_names: string[];
  recognition: string;
  confidence: ConfidenceBucket;
  entity_confidences: Record<string, ConfidenceBucket>;
}
interface RecognitionVectors {
  tier_vectors: TierVector[];
  confidence_buckets: ConfidenceBucketVector[];
  recognition_strings: RecognitionStringVector[];
}

const vectors = readJson<RecognitionVectors>("recognition_vectors.json");

// ---------------------------------------------------------------------------
// Surface 1: tier_vectors — bestMatchTier(...).name === tier AND
// recognitionConfidence (TIER-ONLY) === confidence.
// ---------------------------------------------------------------------------

describe("@getbourdon/recognition tier_vectors parity", () => {
  it("loads the 12 tier vectors", () => {
    expect(vectors.tier_vectors.length).toBe(12);
  });

  for (const v of vectors.tier_vectors) {
    it(`tier+conf: ${JSON.stringify(v.prompt)} vs ${JSON.stringify(v.names)}`, () => {
      const tier = bestMatchTier(v.prompt, v.names);
      expect(MATCH_TIER_NAME[tier]).toBe(v.tier);
      expect(recognitionConfidence(v.prompt, v.names)).toBe(v.confidence);
    });
  }
});

// ---------------------------------------------------------------------------
// Surface 2: confidence_buckets — pins the 0.45 + 0.80 edge arithmetic incl.
// round(score,4).
// ---------------------------------------------------------------------------

describe("@getbourdon/recognition confidence bucket edges", () => {
  it("loads the 9 confidence-bucket vectors", () => {
    expect(vectors.confidence_buckets.length).toBe(9);
  });

  for (const v of vectors.confidence_buckets) {
    it(`bucket: ${v.tier} n=${v.n_anchor_terms} cwd=${v.cwd_hit} recency=${v.recency_fresh} -> ${v.bucket}`, () => {
      const bucket = normalizedConfidence(tierFromName(v.tier), {
        nAnchorTerms: v.n_anchor_terms,
        cwdHit: v.cwd_hit,
        recencyFresh: v.recency_fresh,
      });
      expect(bucket).toBe(v.bucket);
    });
  }

  // Explicit pins on the load-bearing edges (belt + suspenders over the fixtures).
  it("NAME_SUBSTRING + recency_fresh = 0.80 -> high (ON the 0.80 edge)", () => {
    expect(normalizedConfidence(MatchTier.NAME_SUBSTRING, { recencyFresh: true })).toBe("high");
  });
  it("NAME_SUBSTRING bare = 0.75 -> medium (just below 0.80)", () => {
    expect(normalizedConfidence(MatchTier.NAME_SUBSTRING)).toBe("medium");
  });
  it("TOKEN_OVERLAP + n=2 = 0.45 -> medium (ON the 0.45 edge)", () => {
    expect(normalizedConfidence(MatchTier.TOKEN_OVERLAP, { nAnchorTerms: 2 })).toBe("medium");
  });
  it("TOKEN_OVERLAP + n=2 + cwd + recency = 0.60 -> medium", () => {
    expect(
      normalizedConfidence(MatchTier.TOKEN_OVERLAP, {
        nAnchorTerms: 2,
        cwdHit: true,
        recencyFresh: true,
      }),
    ).toBe("medium");
  });
  it("TOKEN_OVERLAP bare = 0.30 -> low (multi-term bump NOT folded into parity bucket)", () => {
    expect(recognitionConfidence("the federation substrate work", ["Bourdon federation engine"])).toBe(
      "low",
    );
  });
});

// ---------------------------------------------------------------------------
// Surface 3: recognition_strings — full recognitionFirst end-to-end.
// ---------------------------------------------------------------------------

describe("@getbourdon/recognition recognition_strings parity", () => {
  it("loads the 12 recognition-string vectors", () => {
    expect(vectors.recognition_strings.length).toBe(12);
  });

  for (const v of vectors.recognition_strings) {
    it(`recognitionFirst: ${v.name}`, () => {
      const result = recognitionFirst(v.prompt, v.manifest, { accessLevel: v.access_level });
      // matched names, order = manifest known_entities order (post visibility filter)
      const matchedNames = result.matchedEntities.map((e) => String(e.name ?? "")).filter((m) => m);
      expect(matchedNames).toEqual(v.matched_names);
      // Literal " -- " + "You're" (no em-dash / smart-quote).
      expect(result.recognition).toBe(v.recognition);
      expect(result.confidence).toBe(v.confidence);
      expect(result.entityConfidences).toEqual(v.entity_confidences);
    });
  }
});

// ---------------------------------------------------------------------------
// Short-name guard + tokenizer (a regression here must fail visibly).
// ---------------------------------------------------------------------------

describe("@getbourdon/recognition tokenizer + short-name guard", () => {
  it("hyphen-splits and lowercases, keeping order + duplicates", () => {
    expect(tokenize("Bourdon-AI v2")).toEqual(["bourdon", "ai", "v2"]);
    expect(tokenize("a a B b")).toEqual(["a", "a", "b", "b"]);
    expect(tokenize("")).toEqual([]);
  });

  it("short-name guard: 'ILTTed' is a substring but not a token subsequence", () => {
    // n_norm 'iltt' IS a substring of p_norm, but [iltt] is NOT a contiguous
    // token subsequence of [we, iltted, the, build] -> NONE.
    expect(matchTier("we ILTTed the build", "ILTT")).toBe(MatchTier.NONE);
    expect(containsSubsequence(["we", "iltted", "the", "build"], ["iltt"])).toBe(false);
  });

  it("substring-not-token: 'NAS' is a real whole token -> NAME_SUBSTRING", () => {
    expect(matchTier("i deployed to a NAS box, the bananas were fine", "NAS")).toBe(
      MatchTier.NAME_SUBSTRING,
    );
  });

  it("detectEntities applies the >= TOKEN_SUBSEQUENCE gate (no short-name false positive)", () => {
    const manifest = { known_entities: [{ name: "ILTT", type: "product" } as EntityDict] };
    expect(detectEntities("the build ILTTed yesterday and broke", manifest)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Eval harness: golden dataset -> micro_f1 == 1.0 && macro_f1 == 1.0 &&
// confidence_accuracy == 1.0 (the F1==1.0 CI gate).
// ---------------------------------------------------------------------------

describe("@getbourdon/recognition eval golden gate", () => {
  it("recognition_golden_v1.yaml scores a perfect F1 + confidence accuracy", () => {
    const raw = yamlParse(readFileSync(resolve(dir, "recognition_golden_v1.yaml"), "utf8"));
    const cases = loadCases(raw);
    expect(cases.length).toBe(12);
    const report = runEval(cases);
    expect(report.nCases).toBe(12);
    expect(report.nErrors).toBe(0);
    expect(report.microF1).toBe(1.0);
    expect(report.macroF1).toBe(1.0);
    expect(report.confidenceAccuracy).toBe(1.0);
    expect(meets(report, { minMicroF1: 1.0, minMacroF1: 1.0 })).toBe(true);
  });
});
