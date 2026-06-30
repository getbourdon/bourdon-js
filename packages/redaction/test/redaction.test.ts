import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { conformanceDir } from "@getbourdon/conformance";
import { describe, expect, it } from "vitest";

import {
  AUDIT_SCHEMA_VERSION,
  REDACTED,
  SENSITIVE_PATTERNS,
  auditManifest,
  containsSecret,
  redactText,
} from "../src/index.js";

const dir = conformanceDir();

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(dir, rel), "utf8")) as T;
}

// ---------------------------------------------------------------------------
// redaction_battery.json — the keystone gate. redactText byte-identical +
// containsSecret boolean-identical for every secret AND benign string, plus the
// per-pattern case_variants probes.
// ---------------------------------------------------------------------------

interface SecretCase {
  fragments: string[];
  expect_redacted: string;
  expect_contains_secret: boolean;
}
interface BenignCase {
  text: string;
  expect_redacted: string;
  expect_contains_secret: boolean;
}
interface CaseVariantSide {
  fragments: string[];
  expect_redacted: string;
  expect_contains_secret: boolean;
}
interface CaseVariant {
  pattern: string;
  case_sensitive: boolean;
  correct: CaseVariantSide;
  wrong: CaseVariantSide;
}
interface RedactionBattery {
  redacted_sentinel: string;
  benign_limit: number;
  secrets: SecretCase[];
  benign: BenignCase[];
  case_variants?: CaseVariant[];
}

const battery = readJson<RedactionBattery>("redaction_battery.json");

describe("@getbourdon/redaction redaction_battery parity", () => {
  it("sentinel is byte-identical to the oracle", () => {
    expect(REDACTED).toBe(battery.redacted_sentinel);
  });

  it("ships 12 keyword + 14 token = 26 sensitive patterns, all non-global", () => {
    expect(SENSITIVE_PATTERNS.length).toBe(26);
    for (const p of SENSITIVE_PATTERNS) {
      expect(p.global).toBe(false);
    }
  });

  it("loads a non-empty secret + benign battery", () => {
    expect(battery.secrets.length).toBeGreaterThan(0);
    expect(battery.benign.length).toBeGreaterThan(0);
  });

  // Secrets: oracle uses the default limit (180).
  for (const [i, c] of battery.secrets.entries()) {
    it(`secret[${i}] redactText + containsSecret`, () => {
      const value = c.fragments.join("");
      expect(redactText(value)).toBe(c.expect_redacted);
      expect(containsSecret(value)).toBe(c.expect_contains_secret);
    });
  }

  // Benign: oracle uses limit = benign_limit (400). These MUST survive.
  for (const [i, c] of battery.benign.entries()) {
    it(`benign[${i}] redactText + containsSecret (survives)`, () => {
      expect(redactText(c.text, battery.benign_limit)).toBe(c.expect_redacted);
      expect(containsSecret(c.text)).toBe(c.expect_contains_secret);
    });
  }

  // Per-pattern case_variants: proves the per-pattern /i flag. `correct` always
  // redacts; `wrong` flips the case-bearing prefix — case-sensitive patterns
  // must then NOT match, IGNORECASE patterns must still match.
  describe("case_variants per-pattern case-flag probes", () => {
    const variants = battery.case_variants ?? [];
    it("ships one probe per token pattern (14)", () => {
      expect(variants.length).toBe(14);
    });
    for (const v of variants) {
      it(`${v.pattern} (case_sensitive=${v.case_sensitive})`, () => {
        const correct = v.correct.fragments.join("");
        const wrong = v.wrong.fragments.join("");
        expect(redactText(correct)).toBe(v.correct.expect_redacted);
        expect(containsSecret(correct)).toBe(v.correct.expect_contains_secret);
        expect(redactText(wrong)).toBe(v.wrong.expect_redacted);
        expect(containsSecret(wrong)).toBe(v.wrong.expect_contains_secret);
        // Belt + suspenders: the oracle's invariant on the flag.
        expect(v.correct.expect_contains_secret).toBe(true);
        expect(v.wrong.expect_contains_secret).toBe(!v.case_sensitive);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// leak_cases.json — auditManifest findings match expected [kind, location] in
// the oracle's emission order. Never throws on garbage manifests.
// ---------------------------------------------------------------------------

interface ExpectedFinding {
  kind: string;
  location: string;
}
interface LeakCase {
  name: string;
  manifest: unknown;
  expected_findings: ExpectedFinding[];
}
interface LeakCases {
  audit_schema_version: string;
  private_tag_families: string[];
  cases: LeakCase[];
}

const leak = readJson<LeakCases>("leak_cases.json");

describe("@getbourdon/redaction leak_cases parity", () => {
  it("audit schema version matches the oracle", () => {
    expect(AUDIT_SCHEMA_VERSION).toBe(leak.audit_schema_version);
  });

  it("loads the 12 leak cases", () => {
    expect(leak.cases.length).toBe(12);
  });

  for (const c of leak.cases) {
    it(`auditManifest: ${c.name}`, () => {
      const findings = auditManifest(c.manifest, `${c.name}.l5.yaml`);
      const got = findings.map((f) => ({ kind: f.kind as string, location: f.location }));
      expect(got).toEqual(c.expected_findings);
    });
  }
});
