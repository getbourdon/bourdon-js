import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assembleSecret,
  conformanceDir,
  loadManifest,
  loadRedactionBattery,
} from "../src/index.js";

describe("@getbourdon/conformance", () => {
  it("loads the manifest including the redaction fixture", () => {
    const manifest = loadManifest();
    expect(manifest.conformance_version).toBeTruthy();
    expect(manifest.produced_against.bourdon_version).toBeTruthy();
    expect(manifest.fixtures.some((f) => f.path === "redaction_battery.json")).toBe(true);
  });

  it("each fixture's bytes match its stamped sha256 (cross-repo drift check)", () => {
    const manifest = loadManifest();
    for (const fixture of manifest.fixtures) {
      const bytes = readFileSync(resolve(conformanceDir(), fixture.path));
      const sha = createHash("sha256").update(bytes).digest("hex");
      expect(sha, `sha256 mismatch for ${fixture.path} — fixtures are stale`).toBe(fixture.sha256);
    }
  });

  it("redaction battery is well-formed (21 secrets, 5 benign, sentinel)", () => {
    const battery = loadRedactionBattery();
    expect(battery.redacted_sentinel).toBe("[redacted credential-like text]");
    expect(battery.secrets.length).toBeGreaterThanOrEqual(21);
    expect(battery.benign.length).toBeGreaterThanOrEqual(5);

    for (const secret of battery.secrets) {
      expect(assembleSecret(secret).length).toBeGreaterThan(0);
      expect(secret.expect_redacted).toBe(battery.redacted_sentinel);
      expect(secret.expect_contains_secret).toBe(true);
    }
    for (const benign of battery.benign) {
      expect(benign.expect_contains_secret).toBe(false);
      expect(benign.expect_redacted).not.toBe(battery.redacted_sentinel);
    }
  });
});
