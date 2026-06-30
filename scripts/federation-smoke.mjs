/**
 * Live mixed-language federation smoke: the TS @getbourdon/client federating with
 * the REAL Python L6 server (`python -m core.l6_server`) over MCP/stdio.
 *
 * This is the load-bearing "the mirror actually interoperates" check — run in CI
 * (the `federation` job) so the bidirectional guarantee is continuously enforced,
 * not just verified once by hand.
 *
 * Requires: the Python oracle installed (`pip install -e '.[server]'`) so
 * `python -m core.l6_server` runs, and BOURDON_CONFORMANCE_DIR pointing at the
 * oracle's conformance/ (we federate over its fed_seed_library, a 2-agent corpus).
 */
import assert from "node:assert/strict";
import { join } from "node:path";

// Import the built ESM directly (this script runs from the repo root, where the
// workspace package isn't symlinked). CI builds packages/client first.
import { BourdonL6Client } from "../packages/client/dist/index.js";

const conformance = process.env.BOURDON_CONFORMANCE_DIR;
if (!conformance) {
  console.error("BOURDON_CONFORMANCE_DIR is required (the oracle's conformance/ dir)");
  process.exit(2);
}
const library = join(conformance, "fed_seed_library");
const python = process.env.BOURDON_PYTHON ?? "python";

const client = new BourdonL6Client({ transport: "stdio", command: python, library });
try {
  const agents = await client.listAgents();
  console.log("list_agents ->", JSON.stringify(agents));
  assert.deepEqual(
    [...agents.agents].sort(),
    ["claude-code", "codex"],
    "expected the 2 seed agents",
  );

  const bourdon = await client.findEntity({ name: "Bourdon", access_level: "public" });
  console.log("find_entity(Bourdon) ->", JSON.stringify(bourdon));
  assert.ok(
    bourdon.matches?.some((m) => m.name === "Bourdon"),
    "expected to find the public Bourdon entity across agents",
  );

  // Egress: a PRIVATE entity must NOT cross the wire (the client clamps + the
  // server enforces). find_entity over a public/team request returns nothing.
  const priv = await client.findEntity({ name: "Quarterly Revenue", access_level: "public" });
  console.log("find_entity(Quarterly Revenue, PRIVATE) ->", JSON.stringify(priv));
  assert.equal(priv.matches?.length ?? 0, 0, "PRIVATE entity must not federate outward");

  console.log("✅ live TS-client → Python-server federation OK (incl. egress clamp)");
} finally {
  await client.close();
}
