import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { conformanceDir } from "@getbourdon/conformance";
import { parse as yamlParse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  applyVisibility,
  filterForFederation,
  makeEntity,
  makeManifest,
  readL5Dict,
  toDict,
  validateManifest,
  Visibility,
  writeL5,
  type EntityModel,
  type L5ManifestModel,
  type VisibilityPolicyModel,
} from "../src/index.js";

const dir = conformanceDir();
const here = dirname(fileURLToPath(import.meta.url));

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(dir, rel), "utf8")) as T;
}

interface ToDictCase {
  name: string;
  input: L5ManifestModel;
  expected: Record<string, unknown>;
}
interface ReasonExpect {
  valid: boolean;
  expected: { keyword: string; instancePath: string };
  errors: { keyword: string; instancePath: string; message: string }[];
}

describe("@getbourdon/l5 schema parity", () => {
  it("bundled schema is byte-identical to the conformance oracle schema", () => {
    const bundled = readFileSync(resolve(here, "..", "schema", "L5_schema.json"));
    const oracle = readFileSync(resolve(dir, "l5_schema.json"));
    expect(bundled.equals(oracle)).toBe(true);
  });

  it("schema $id is the pinned L5 manifest id", () => {
    const schema = readJson<{ $id: string; $schema: string }>("l5_schema.json");
    expect(schema.$id).toBe("https://bourdon.ai/schema/L5_manifest_v0.1.json");
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });
});

describe("@getbourdon/l5 validation (ajv 2020-12)", () => {
  it("every valid/* manifest passes ajv", () => {
    const validDir = resolve(dir, "l5_manifests", "valid");
    const files = readdirSync(validDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const data = JSON.parse(readFileSync(resolve(validDir, f), "utf8"));
      const res = validateManifest(data);
      expect(res.valid, `${f} should be valid; errors: ${JSON.stringify(res.errors)}`).toBe(true);
      expect(res.errors).toHaveLength(0);
    }
  });

  it("every invalid/* manifest fails with the expected keyword + instancePath", () => {
    const reasons = readJson<{ reasons: Record<string, ReasonExpect> }>(
      "l5_manifests/invalid/reasons.json",
    ).reasons;
    expect(Object.keys(reasons).length).toBeGreaterThanOrEqual(5);
    for (const [file, reason] of Object.entries(reasons)) {
      const data = JSON.parse(
        readFileSync(resolve(dir, "l5_manifests", "invalid", file), "utf8"),
      );
      const res = validateManifest(data);
      expect(res.valid, `${file} should be invalid`).toBe(false);
      const hit = res.errors.some(
        (e) =>
          e.keyword === reason.expected.keyword &&
          e.instancePath === reason.expected.instancePath,
      );
      expect(
        hit,
        `${file}: expected (${reason.expected.keyword} @ '${reason.expected.instancePath}') in ${JSON.stringify(res.errors.map((e) => ({ k: e.keyword, p: e.instancePath })))}`,
      ).toBe(true);
    }
  });
});

describe("@getbourdon/l5 toDict parity", () => {
  const cases = readJson<{ cases: ToDictCase[] }>("l5_todict.json").cases;

  it("loads all 5 to_dict cases", () => {
    expect(cases.map((c) => c.name)).toEqual([
      "drops_empty_lists_and_none",
      "visibility_lowercased",
      "entity_empty_inner_lists_dropped",
      "policy_default_injected",
      "full_key_order",
    ]);
  });

  for (const c of cases) {
    it(`to_dict: ${c.name} (value + key order)`, () => {
      const actual = toDict(makeManifest(c.input));
      // toEqual asserts structural value equality...
      expect(actual).toEqual(c.expected);
      // ...and JSON.stringify asserts key-insertion order (the L6 hash key) —
      // this is where the valid_from/valid_to-after-visibility and
      // always-emit-default gotchas would surface.
      expect(JSON.stringify(actual)).toBe(JSON.stringify(c.expected));
    });
  }
});

describe("@getbourdon/l5 visibility precedence", () => {
  const policy: VisibilityPolicyModel = {
    default: Visibility.PUBLIC,
    private_tags: ["financial"],
    team_tags: ["team"],
  };

  it("private_tags override an explicit non-private visibility (PII guardrail)", () => {
    const e: EntityModel = { name: "X", tags: ["financial"], visibility: Visibility.PUBLIC };
    expect(applyVisibility(e, policy)).toBe(Visibility.PRIVATE);
  });

  it("explicit visibility beats team_tags", () => {
    const e: EntityModel = { name: "X", tags: ["team"], visibility: Visibility.PUBLIC };
    expect(applyVisibility(e, policy)).toBe(Visibility.PUBLIC);
  });

  it("team_tags beat the default", () => {
    const e: EntityModel = { name: "X", tags: ["team"] };
    expect(applyVisibility(e, policy)).toBe(Visibility.TEAM);
  });

  it("falls back to policy.default", () => {
    const e: EntityModel = { name: "X" };
    expect(applyVisibility(e, { default: Visibility.TEAM })).toBe(Visibility.TEAM);
  });

  it("no policy -> PUBLIC", () => {
    expect(applyVisibility({ name: "X" })).toBe(Visibility.PUBLIC);
    expect(applyVisibility({ name: "X" }, null)).toBe(Visibility.PUBLIC);
  });

  it("filterForFederation drops only entities resolving to PRIVATE", () => {
    const entities: EntityModel[] = [
      makeEntity({ name: "Public Blog", visibility: Visibility.PUBLIC }),
      makeEntity({ name: "Roadmap", tags: ["team"], visibility: Visibility.TEAM }),
      makeEntity({ name: "Quarterly Revenue", tags: ["financial"], visibility: Visibility.PRIVATE }),
    ];
    const kept = filterForFederation(entities, policy);
    expect(kept.map((e) => e.name)).toEqual(["Public Blog", "Roadmap"]);
  });

  it("matches the team-and-private conformance fixture entity resolutions", () => {
    const m = readJson<L5ManifestModel>("l5_manifests/valid/team-and-private.json");
    const pol = m.visibility_policy ?? undefined;
    const byName = Object.fromEntries((m.known_entities ?? []).map((e) => [e.name, e]));
    expect(applyVisibility(byName["Quarterly Revenue"]!, pol)).toBe(Visibility.PRIVATE);
    expect(applyVisibility(byName["Roadmap"]!, pol)).toBe(Visibility.TEAM);
    expect(applyVisibility(byName["Public Blog"]!, pol)).toBe(Visibility.PUBLIC);
    // Private entity must be omitted from federation.
    expect(filterForFederation(m.known_entities ?? [], pol).map((e) => e.name)).toEqual([
      "Roadmap",
      "Public Blog",
    ]);
  });
});

describe("@getbourdon/l5 atomic I/O round-trip", () => {
  it("writeL5 -> readL5Dict yields the toDict structure (YAML, order-preserved)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "l5-io-"));
    try {
      const manifest = makeManifest(
        readJson<L5ManifestModel>("l5_manifests/valid/full.json"),
      );
      const target = join(tmp, "nested", "agents", "claude-code.yaml");
      writeL5(manifest, target);
      const back = readL5Dict(target);
      expect(back).toEqual(toDict(manifest));
      // YAML preserves key order on write; re-parse confirms it round-trips.
      const reparsed = yamlParse(readFileSync(target, "utf8"));
      expect(reparsed).toEqual(toDict(manifest));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("readL5Dict is lenient: missing file -> undefined", () => {
    expect(readL5Dict(join(tmpdir(), "definitely-missing-l5-xyz.yaml"))).toBeUndefined();
  });
});
