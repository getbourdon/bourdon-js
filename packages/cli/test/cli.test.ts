/**
 * `bourdon` CLI tests — the no-drift gate for the thin Apache-2.0 dispatch CLI.
 *
 * The gate is authored TS-side (not as an oracle byte fixture, per the
 * conformance generator's deliberate lightweight-import property): a generated
 * command/flag checklist over the commander tree, the load-bearing default
 * checks (the ones that silently break federation if they drift), the
 * agents --json tray-contract shape, the not-yet-ported non-zero exits, and the
 * non-loopback serve refusal.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildProgram, main, NOT_PORTED_EXIT, NOT_PORTED_MESSAGE } from "../src/index.js";
import type { Command } from "commander";

// -- tree walk --------------------------------------------------------------

interface Node {
  options: string[]; // long flags (incl. hidden)
  args: string[];
}

function walk(cmd: Command, prefix = ""): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const sub of cmd.commands) {
    const path = prefix ? `${prefix} ${sub.name()}` : sub.name();
    out.set(path, {
      options: sub.options.map((o) => o.long ?? o.short ?? "").filter(Boolean),
      // commander stores positional args on `registeredArguments` (v12).
      args: (sub as unknown as { registeredArguments: { name(): string }[] }).registeredArguments.map((a) =>
        a.name(),
      ),
    });
    for (const [k, v] of walk(sub, path)) out.set(k, v);
  }
  return out;
}

function findCommand(program: Command, path: string): Command {
  let cur = program;
  for (const part of path.split(" ")) {
    const next = cur.commands.find((c) => c.name() === part);
    if (!next) throw new Error(`command not found: ${path} (missing ${part})`);
    cur = next;
  }
  return cur;
}

function optionDefault(program: Command, path: string, long: string): unknown {
  const cmd = findCommand(program, path);
  const opt = cmd.options.find((o) => o.long === long);
  if (!opt) throw new Error(`option ${long} not found on ${path}`);
  return opt.defaultValue;
}

// -- captured-output harness ------------------------------------------------

let stdout = "";
let stderr = "";

function captureIo(): void {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    stdout += String(c);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
    stderr += String(c);
    return true;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// -- the expected top-level command surface (the checklist) -----------------

const TOP_LEVEL = [
  "prepare-turn",
  "deeper-context",
  "recognition",
  "cursor",
  "improve",
  "cursor-automations",
  "codex-automations",
  "copilot",
  "cascade",
  "hermes",
  "doctor",
  "export-all",
  "agents",
  "dogfood",
  "serve",
  "agent",
  "grant",
  "ungrant",
  "revoke",
  "staging",
  "audit",
  "audit-leaks",
  "openclaw",
  "codex",
  "claude-code",
  "claude-code-automations",
  "claude-desktop-cowork",
  "claude-desktop-code",
  "benchmark",
  "setup",
  "demo",
  "sync",
];

describe("command surface", () => {
  it("builds the program without error", () => {
    expect(() => buildProgram()).not.toThrow();
  });

  it("registers exactly the 32 top-level nodes in order", () => {
    const program = buildProgram();
    expect(program.commands.map((c) => c.name())).toEqual(TOP_LEVEL);
  });

  it("mirrors the full nested checklist (no dropped subcommand)", () => {
    const tree = walk(buildProgram());
    for (const path of [
      "recognition eval",
      "cursor export",
      "cursor doctor",
      "cursor compile-turn",
      "cursor sync-native",
      "cursor init",
      "improve sync",
      "cursor-automations export",
      "cursor-automations doctor",
      "cursor-automations ingest",
      "codex-automations export",
      "codex-automations doctor",
      "copilot export",
      "copilot doctor",
      "copilot init",
      "cascade export",
      "cascade doctor",
      "cascade init",
      "hermes export",
      "hermes doctor",
      "agent add",
      "agent list",
      "agent rotate",
      "agent set-tier",
      "staging list",
      "staging promote",
      "staging reject",
      "openclaw export",
      "openclaw doctor",
      "codex export",
      "codex build-context",
      "codex doctor",
      "codex sync-native",
      "codex recognize",
      "codex prepare-turn",
      "codex compile-turn",
      "codex hook",
      "codex hook user-prompt-submit",
      "codex eval",
      "claude-code export",
      "claude-code-automations export",
      "claude-code-automations doctor",
      "claude-code-automations ingest-github",
      "claude-desktop-cowork export",
      "claude-desktop-code export",
      "benchmark latency",
      "sync push",
      "sync pull",
    ]) {
      expect(tree.has(path), `missing command: ${path}`).toBe(true);
    }
  });

  it("preserves the hidden test-seam flags (parsed though SUPPRESSed)", () => {
    const tree = walk(buildProgram());
    expect(tree.get("cursor doctor")?.options).toContain("--cursor-dir");
    expect(tree.get("codex export")?.options).toContain("--codex-home");
    expect(tree.get("codex export")?.options).toContain("--codex-brain");
    expect(tree.get("agents")?.options).toContain("--agents-dir");
    expect(tree.get("agents")?.options).toContain("--peers-config");
    expect(tree.get("hermes export")?.options).toContain("--hermes-home");
    expect(tree.get("claude-desktop-code export")?.options).toContain("--store-dir");
  });
});

describe("load-bearing defaults (copied exactly from argparse)", () => {
  const program = buildProgram();

  it("serve: --port 7500, --host 127.0.0.1, --transport stdio", () => {
    expect(optionDefault(program, "serve", "--port")).toBe(7500);
    expect(optionDefault(program, "serve", "--host")).toBe("127.0.0.1");
    expect(optionDefault(program, "serve", "--transport")).toBe("stdio");
  });

  it("recognition eval: --min-micro-f1 / --min-macro-f1 default 0.0 (no gate)", () => {
    expect(optionDefault(program, "recognition eval", "--min-micro-f1")).toBe(0.0);
    expect(optionDefault(program, "recognition eval", "--min-macro-f1")).toBe(0.0);
  });

  it("audit: --limit 50", () => {
    expect(optionDefault(program, "audit", "--limit")).toBe(50);
  });

  it("max-items/max-chars/max-sessions/max-entities defaults", () => {
    expect(optionDefault(program, "codex compile-turn", "--max-items")).toBe(6);
    expect(optionDefault(program, "codex compile-turn", "--max-chars")).toBe(1800);
    expect(optionDefault(program, "cursor sync-native", "--max-sessions")).toBe(20);
    expect(optionDefault(program, "cursor sync-native", "--max-entities")).toBe(100);
  });

  it("codex hook diverges: --max-items 1 / --max-chars 500 (NOT 6 / 1800)", () => {
    expect(optionDefault(program, "codex hook user-prompt-submit", "--max-items")).toBe(1);
    expect(optionDefault(program, "codex hook user-prompt-submit", "--max-chars")).toBe(500);
  });

  it("access-level default split: team everywhere EXCEPT demo + sync push (public)", () => {
    expect(optionDefault(program, "prepare-turn", "--access-level")).toBe("team");
    expect(optionDefault(program, "export-all", "--access-level")).toBe("team");
    expect(optionDefault(program, "demo", "--access-level")).toBe("public");
    expect(optionDefault(program, "sync push", "--access-level")).toBe("public");
  });

  it("sync pull has NO --access-level", () => {
    const tree = walk(program);
    expect(tree.get("sync pull")?.options).not.toContain("--access-level");
  });

  it("agent add: --tier defaults quarantined (deny-by-default)", () => {
    expect(optionDefault(program, "agent add", "--tier")).toBe("quarantined");
  });

  it("codex build-context: --out-dir is required (the only required option)", () => {
    const cmd = findCommand(program, "codex build-context");
    const opt = cmd.options.find((o) => o.long === "--out-dir");
    expect(opt?.required || opt?.mandatory).toBeTruthy();
  });
});

describe("top-level dispatch", () => {
  it("--help exits 0", async () => {
    captureIo();
    expect(await main(["--help"])).toBe(0);
  });

  it("no args prints help and returns 1 (argparse no-func branch)", async () => {
    captureIo();
    expect(await main([])).toBe(1);
    expect(stdout + stderr).toContain("Bourdon CLI");
  });

  it("a bare group with no subcommand returns 1", async () => {
    captureIo();
    expect(await main(["cursor"])).toBe(1);
  });
});

describe("not-yet-ported commands exit non-zero with a clear message", () => {
  for (const cmd of [
    ["cursor", "export"],
    ["copilot", "export"],
    ["cascade", "export"],
    ["codex", "sync-native"],
    ["dogfood"],
    ["setup"],
    ["sync", "push", "/tmp/x"],
  ]) {
    it(`bourdon ${cmd.join(" ")}`, async () => {
      captureIo();
      const code = await main(cmd);
      expect(code).toBe(NOT_PORTED_EXIT);
      expect(stderr).toContain(NOT_PORTED_MESSAGE);
    });
  }
});

describe("agents --json tray contract", () => {
  it("missing agents dir exits 2", async () => {
    captureIo();
    const code = await main(["agents", "--json", "--agents-dir", join(tmpdir(), "bourdon-nope-xyz")]);
    expect(code).toBe(2);
  });

  it("emits a stable JSON object with a source-attributed agents array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bourdon-agents-"));
    try {
      writeFileSync(
        join(dir, "test.l5.yaml"),
        "agent:\n  id: test\n  type: assistant\nknown_entities: []\nrecent_sessions: []\n",
        "utf8",
      );
      captureIo();
      const code = await main(["agents", "--json", "--agents-dir", dir]);
      expect(code).toBe(0);
      const report = JSON.parse(stdout) as { agents: unknown[]; machine: string };
      expect(Array.isArray(report.agents)).toBe(true);
      expect(typeof report.machine).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--federated is not yet ported (exit 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bourdon-agents-fed-"));
    try {
      captureIo();
      const code = await main(["agents", "--federated", "--agents-dir", dir]);
      expect(code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("serve non-loopback bind refusal", () => {
  it("refuses to start on a non-loopback --host without auth (non-zero)", async () => {
    captureIo();
    // `--allow-unauthenticated` + a non-loopback bind ALWAYS refuses (anonymous is
    // loopback-only) regardless of registry state — a deterministic refusal that
    // exercises the CLI → runHttpServer guard without depending on the machine's
    // federation registry or starting a real listener.
    const code = await main([
      "serve",
      "--transport",
      "http",
      "--host",
      "0.0.0.0",
      "--allow-unauthenticated",
      "--quiet",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("refusing to start");
  });
});
