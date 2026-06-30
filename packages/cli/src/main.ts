/**
 * `bourdon` — the unscoped CLI. A commander.js tree mirroring
 * `cli/main.py::_build_parser` command-for-command. Thin dispatch only: every
 * leaf delegates to a `@getbourdon/*` engine package or, where the backing
 * reader is not yet ported to TS, registers the full parser surface and exits
 * non-zero with a clear pointer to the Python implementation (never silently
 * omitted).
 *
 * argparse → commander map: `choices()` → `Option.choices()`; `store_true` →
 * boolean flag; `append` → a collect reducer seeded `[]`; `REMAINDER` →
 * pass-through; `SUPPRESS` → `Option.hideHelp()`; `mutually_exclusive_group` →
 * manual validation. Non-obvious defaults are copied EXACTLY (see the inline
 * comments): `--port 7500`, `--host 127.0.0.1`, `--max-items 6` (but 1 on the
 * codex hook), `--max-chars 1800` (but 500 on the codex hook), `--max-sessions
 * 20`, `--max-entities 100`, recognition `--min-*-f1 0.0`, `audit --limit 50`,
 * and the access-level default split (`team` everywhere EXCEPT `public` on
 * `demo` and `sync push`).
 */

import { Argument, Command, Option } from "commander";

import { handleAuditLeaks } from "./commands/audit-leaks.js";
import {
  handleAgentAdd,
  handleAgentList,
  handleAgentRotate,
  handleAgentSetTier,
  handleAudit,
  handleGrant,
  handleRevoke,
  handleStagingList,
  handleStagingPromote,
  handleStagingReject,
  handleUngrant,
} from "./commands/federation.js";
import {
  handleAgents,
  handleClaudeCodeExport,
  handleDoctor,
  handleExportAll,
  handleHermesDoctor,
  handleHermesExport,
} from "./commands/participants.js";
import {
  handleCodexCompileTurn,
  handleDeeperContext,
  handlePrepareTurn,
} from "./commands/recognition-context.js";
import { handleRecognitionEval } from "./commands/recognition-eval.js";
import { handleServe } from "./commands/serve.js";
import { type Dict, notYetPorted } from "./util.js";

type Handler = (opts: Dict, args: string[]) => number | Promise<number>;

/** The captured exit code of the most recently dispatched leaf action. Reset by
 * {@link main} before each parse. `null` means no leaf action ran (a bare group
 * invocation), which {@link main} maps to print-help + exit 1 (the Python
 * `not hasattr(args, "func")` branch). */
let captured: number | null = null;

/** Wire a leaf's `.action()` so the handler's return value is captured as the
 * process exit code. */
function leaf(cmd: Command, handler: Handler): Command {
  cmd.action(async (...callArgs: unknown[]) => {
    const command = callArgs[callArgs.length - 1] as Command;
    captured = await handler(command.opts() as Dict, (command.processedArgs as string[]) ?? []);
  });
  return cmd;
}

/** Wire a not-yet-ported leaf: keeps the parser surface (help still lists it)
 * but exits non-zero pointing at the Python CLI. */
function stub(cmd: Command, name: string): Command {
  cmd.action(() => {
    captured = notYetPorted(name);
  });
  return cmd;
}

/** Reusable `--access-level {public,team,private}` option. */
function accessLevel(def = "team"): Option {
  return new Option("--access-level <level>", "Visibility level").choices([
    "public",
    "team",
    "private",
  ]).default(def);
}

/** A hidden (argparse.SUPPRESS) test-seam option — parsed but absent from help. */
function hidden(flags: string): Option {
  return new Option(flags).hideHelp();
}

const collect = (v: string, acc: string[]): string[] => [...acc, v];

export function buildProgram(): Command {
  const program = new Command();
  program.name("bourdon").description("Bourdon CLI");
  program.configureHelp({ showGlobalOptions: false });
  // A group invoked with no subcommand should NOT process.exit — fall through to
  // main()'s print-help + exit 1 (matching argparse's no-func branch).
  program.enablePositionalOptions();

  // 1. prepare-turn ---------------------------------------------------------
  leaf(
    program
      .command("prepare-turn")
      .description("Return L6 recognition context for a prompt")
      .argument("<prompt>")
      .option("--library <path>", "Path to agent-library")
      .addOption(accessLevel())
      .option("--report-out <path>"),
    handlePrepareTurn,
  );

  // 2. deeper-context -------------------------------------------------------
  leaf(
    program
      .command("deeper-context")
      .description("Return post-recognition L2 context for a prompt")
      .argument("<prompt>")
      .addOption(accessLevel())
      .option("--report-out <path>"),
    handleDeeperContext,
  );

  // 3. recognition eval -----------------------------------------------------
  const recognition = program.command("recognition").description("Recognition-runtime tools (eval harness)");
  leaf(
    recognition
      .command("eval")
      .description("Score recognition against a labeled golden dataset (precision/recall/F1)")
      .option("--dataset <path>")
      .option("--summary")
      .addOption(new Option("--min-micro-f1 <f>", "CI gate (default 0.0 = no gate)").default(0.0).argParser(Number))
      .addOption(new Option("--min-macro-f1 <f>", "CI gate (default 0.0 = no gate)").default(0.0).argParser(Number))
      .addOption(new Option("--max-p95-us <us>", "CI gate: max recognition p95 latency").argParser(Number))
      .option("--report-out <path>"),
    handleRecognitionEval,
  );

  // 4. cursor {export,doctor,compile-turn,sync-native,init} -----------------
  const cursor = program.command("cursor").description("Cursor-specific commands");
  stub(
    cursor
      .command("export")
      .description("Build a Cursor L5 manifest from native SQLite state")
      .option("--cursor-dir <dir>")
      .option("--out <path>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--print")
      .option("--verbose"),
    "cursor export",
  );
  stub(
    cursor
      .command("doctor")
      .description("Diagnose Cursor memory sources")
      .addOption(hidden("--cursor-dir <dir>"))
      .option("--report-out <path>"),
    "cursor doctor",
  );
  stub(
    cursor
      .command("compile-turn")
      .description("Compile a turn-scoped Cursor recognition brief")
      .argument("<prompt>")
      .option("--cwd <dir>")
      .addOption(accessLevel())
      .option("--library-path <path>")
      .addOption(new Option("--max-items <n>").default(6).argParser(Number)),
    "cursor compile-turn",
  );
  stub(
    cursor
      .command("sync-native")
      .description("Render federation content into a Cursor-readable markdown file")
      .option("--dry-run")
      .option("--write")
      .option("--out <path>")
      .addOption(hidden("--cursor-dir <dir>"))
      .addOption(new Option("--max-entities <n>").default(100).argParser(Number))
      .addOption(new Option("--max-sessions <n>").default(20).argParser(Number))
      .addOption(accessLevel())
      .option("--library-path <path>"),
    "cursor sync-native",
  );
  stub(
    cursor
      .command("init")
      .description("Create a starter ~/.cursor/automations/ directory")
      .addOption(hidden("--automations-dir <dir>"))
      .option("--automation-id <id>", "", "cursor-cloud-agent")
      .option("--force"),
    "cursor init",
  );

  // 5. improve sync ---------------------------------------------------------
  const improve = program.command("improve").description("shadcn/improve plan-backlog commands");
  stub(
    improve
      .command("sync")
      .description("Federate a repo's improve-format plans/ backlog into the L6 store")
      .argument("[path]", "Repo root containing a plans/ backlog", ".")
      .option("--library <path>")
      .option("--agent-id <id>", "", "improve")
      .option("--dry-run"),
    "improve sync",
  );

  // 6. cursor-automations {export,doctor,ingest} ----------------------------
  const cursorAuto = program.command("cursor-automations").description("Cursor Cloud Agent automation memory commands");
  stub(
    cursorAuto
      .command("export")
      .description("Build a Cursor automations L5 manifest")
      .addOption(hidden("--automations-dir <dir>"))
      .option("--out <path>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--print")
      .option("--verbose"),
    "cursor-automations export",
  );
  stub(
    cursorAuto
      .command("doctor")
      .description("Diagnose local Cursor automation memory coverage")
      .addOption(hidden("--automations-dir <dir>"))
      .option("--report-out <path>"),
    "cursor-automations doctor",
  );
  stub(
    cursorAuto
      .command("ingest")
      .description("Ingest an automations/ tree into the local Cursor automations")
      .option("--source <dir>")
      .option("--artifact-zip <zip>")
      .option("--dest <dir>")
      .option("--default-kind <kind>", "", "cursor-cloud-agent"),
    "cursor-automations ingest",
  );

  // 7. codex-automations {export,doctor} ------------------------------------
  const codexAuto = program.command("codex-automations").description("Codex automation memory commands");
  stub(
    codexAuto
      .command("export")
      .description("Build a Codex automations L5 manifest from local automation memory")
      .addOption(hidden("--automations-dir <dir>"))
      .option("--out <path>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--print"),
    "codex-automations export",
  );
  stub(
    codexAuto
      .command("doctor")
      .description("Diagnose local Codex automation memory coverage")
      .addOption(hidden("--automations-dir <dir>"))
      .option("--report-out <path>"),
    "codex-automations doctor",
  );

  // 8. copilot {export,doctor,init} -----------------------------------------
  const copilot = program.command("copilot").description("GitHub Copilot-specific commands");
  stub(
    copilot
      .command("export")
      .description("Build a Copilot L5 manifest from ~/.copilot-bourdon/memory.md")
      .addOption(hidden("--copilot-dir <dir>"))
      .option("--out <path>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--print"),
    "copilot export",
  );
  stub(
    copilot
      .command("doctor")
      .description("Diagnose the Copilot convention memory file")
      .addOption(hidden("--copilot-dir <dir>"))
      .option("--report-out <path>"),
    "copilot doctor",
  );
  stub(
    copilot
      .command("init")
      .description("Create ~/.copilot-bourdon/memory.md with a starter template")
      .addOption(hidden("--copilot-dir <dir>"))
      .option("--force"),
    "copilot init",
  );

  // 9. cascade {export,doctor,init} -----------------------------------------
  const cascade = program.command("cascade").description("Cascade (Windsurf)-specific commands");
  stub(
    cascade
      .command("export")
      .description("Build a Cascade L5 manifest from ~/.cascade-bourdon/memory.md")
      .addOption(hidden("--cascade-dir <dir>"))
      .option("--out <path>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--print"),
    "cascade export",
  );
  stub(
    cascade
      .command("doctor")
      .description("Diagnose the Cascade convention memory file")
      .addOption(hidden("--cascade-dir <dir>"))
      .option("--report-out <path>"),
    "cascade doctor",
  );
  stub(
    cascade
      .command("init")
      .description("Create ~/.cascade-bourdon/memory.md with a starter template")
      .addOption(hidden("--cascade-dir <dir>"))
      .option("--force"),
    "cascade init",
  );

  // 10. hermes {export,doctor} ----------------------------------------------
  const hermes = program.command("hermes").description("Hermes Agent-specific commands");
  leaf(
    hermes
      .command("export")
      .description("Build a Hermes L5 manifest from ~/.hermes (state.db + memories/)")
      .addOption(hidden("--hermes-home <dir>"))
      .option("--out <path>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--print")
      .option("--verbose"),
    handleHermesExport,
  );
  leaf(
    hermes
      .command("doctor")
      .description("Diagnose the Hermes home (state.db + memories/)")
      .addOption(hidden("--hermes-home <dir>"))
      .option("--report-out <path>"),
    handleHermesDoctor,
  );

  // 11. doctor --------------------------------------------------------------
  leaf(
    program
      .command("doctor")
      .description("Run health checks across all installed participants")
      .option("--report-out <path>"),
    handleDoctor,
  );

  // 12. export-all ----------------------------------------------------------
  leaf(
    program
      .command("export-all")
      .description("Export L5 manifests for all healthy participants")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--library <path>")
      .option("--report-out <path>"),
    handleExportAll,
  );

  // 13. agents (tray contract) ----------------------------------------------
  leaf(
    program
      .command("agents")
      .description("Enumerate L5 manifests as a redacted, source-attributed JSON object")
      .option("--json", "Emit JSON (the stable tray contract; currently the default)")
      .option("--federated", "Also fan out to configured L6 peers and merge their agents in")
      .addOption(hidden("--agents-dir <dir>"))
      .addOption(hidden("--peers-config <path>")),
    handleAgents,
  );

  // 14. dogfood -------------------------------------------------------------
  stub(
    program
      .command("dogfood")
      .description("End-to-end federation smoke test")
      .option("--keep-marker")
      .addOption(accessLevel())
      .option("--report-out <path>"),
    "dogfood",
  );

  // 15. serve ---------------------------------------------------------------
  leaf(
    program
      .command("serve")
      .description("Launch the L6 federation MCP server (stdio by default)")
      .option("--library <path>", "Path to agent-library")
      .addOption(new Option("--transport <t>", "MCP transport").choices(["stdio", "http"]).default("stdio"))
      .addOption(new Option("--port <n>", "Port for HTTP transport").default(7500).argParser(Number))
      .option("--host <host>", "Bind host for HTTP transport", "127.0.0.1")
      .option("--quiet", "Suppress the onboarding banner")
      .option("--peer <url>", "Peer L6 server URL to federate with (repeatable)", collect, [])
      .option("--peers-config <path>", "Path to a YAML file listing peer L6 servers")
      .option("--allow-unauthenticated", "Serve HTTP transport without Bearer-token auth"),
    handleServe,
  );

  // 16. agent {add,list,rotate,set-tier} ------------------------------------
  const agent = program.command("agent").description("Manage federation member identities (tokens + tiers)");
  leaf(
    agent
      .command("add")
      .description("Register a federation member; prints its token ONCE")
      .argument("<agent_id>")
      .addOption(new Option("--tier <tier>", "Trust tier").choices(["trusted", "quarantined"]).default("quarantined"))
      .option("--grant <namespace>", "Namespace this member may read (repeatable)", collect, [])
      .addOption(new Option("--i-understand-the-risk", "Required to register a quarantined-class agent as trusted"))
      .option("--print"),
    handleAgentAdd,
  );
  leaf(
    agent.command("list").description("List registered federation members (no token material)"),
    handleAgentList,
  );
  leaf(
    agent.command("rotate").description("Rotate a member's token; prints the new token ONCE").argument("<agent_id>"),
    handleAgentRotate,
  );
  leaf(
    agent
      .command("set-tier")
      .description("Change a member's trust tier")
      .argument("<agent_id>")
      .addArgument(new Argument("<tier>").choices(["trusted", "quarantined"]))
      .addOption(new Option("--i-understand-the-risk", "Required to promote a quarantined-class agent")),
    handleAgentSetTier,
  );

  // 17-19. grant / ungrant / revoke -----------------------------------------
  leaf(
    program
      .command("grant")
      .description("Grant a quarantined member read access to one namespace")
      .argument("<agent_id>")
      .argument("<namespace>"),
    handleGrant,
  );
  leaf(
    program
      .command("ungrant")
      .description("Remove a namespace grant from a member")
      .argument("<agent_id>")
      .argument("<namespace>"),
    handleUngrant,
  );
  leaf(
    program
      .command("revoke")
      .description("Immediately invalidate a member's token and federation access")
      .argument("<agent_id>"),
    handleRevoke,
  );

  // 20. staging {list,promote,reject} ---------------------------------------
  const staging = program.command("staging").description("Review quarantined writes awaiting promotion");
  leaf(staging.command("list").description("List staged writes").option("--library <path>"), handleStagingList);
  leaf(
    staging
      .command("promote")
      .description("Merge a staged write into the live federation store")
      .argument("<agent_id>")
      .option("--library <path>"),
    handleStagingPromote,
  );
  leaf(
    staging
      .command("reject")
      .description("Delete a staged write without promoting it")
      .argument("<agent_id>")
      .option("--library <path>"),
    handleStagingReject,
  );

  // 21. audit ---------------------------------------------------------------
  leaf(
    program
      .command("audit")
      .description("Query the append-only federation audit log")
      .option("--agent <id>", "Filter to one member")
      .option("--denials", "Show only denied operations")
      .addOption(new Option("--limit <n>").default(50).argParser(Number))
      .option("--export", "Emit raw JSONL instead of the table"),
    handleAudit,
  );

  // 22. audit-leaks ---------------------------------------------------------
  leaf(
    program
      .command("audit-leaks")
      .description("Static scan of published L5 manifests for credential + visibility leaks")
      .option("--library <path>")
      .option("--strict", "Exit 1 if any leak is found")
      .option("--summary", "Omit per-finding detail")
      .option("--require-files", "Exit 1 if zero manifests were scanned")
      .option("--report-out <path>"),
    handleAuditLeaks,
  );

  // 23. openclaw {export,doctor} --------------------------------------------
  const openclaw = program.command("openclaw").description("OpenClaw adapter (quarantined class)");
  stub(
    openclaw
      .command("export")
      .description("Export the OpenClaw instance's L5 manifest into staging")
      .option("--url <url>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--library <path>"),
    "openclaw export",
  );
  stub(
    openclaw.command("doctor").description("Health-check the OpenClaw instance (handshake gate)").option("--url <url>"),
    "openclaw doctor",
  );

  // 24. codex {…} -----------------------------------------------------------
  registerCodex(program);

  // 25. claude-code export --------------------------------------------------
  const cc = program.command("claude-code").description("Claude Code-specific commands");
  leaf(
    cc
      .command("export")
      .description("Build a Claude Code L5 manifest (silent + never raises; SessionEnd-hook safe)")
      .option("--since <iso>")
      .option("--out <path>")
      .addOption(accessLevel())
      .option("--print")
      .option("--verbose"),
    handleClaudeCodeExport,
  );

  // 26. claude-code-automations {export,doctor,ingest-github} ---------------
  const cca = program.command("claude-code-automations").description("Claude Code automation memory commands");
  stub(
    cca
      .command("export")
      .description("Build a Claude Code automations L5 manifest")
      .addOption(hidden("--automations-dir <dir>"))
      .option("--out <path>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--print")
      .option("--verbose"),
    "claude-code-automations export",
  );
  stub(
    cca
      .command("doctor")
      .description("Diagnose local Claude Code automation memory coverage")
      .addOption(hidden("--automations-dir <dir>"))
      .option("--report-out <path>"),
    "claude-code-automations doctor",
  );
  stub(
    cca
      .command("ingest-github")
      .description("Ingest an automations/ tree produced by a claude-code-action GitHub Actions run")
      .option("--source <dir>")
      .option("--artifact-zip <zip>")
      .option("--repo <owner/name>")
      .option("--run <id>")
      .option("--artifact-name <name>", "", "claude-code-automations")
      .option("--dest <dir>")
      .option("--default-kind <kind>", "", "github-action")
      .option("--gh-issue <ref>")
      .option("--automation-id <id>"),
    "claude-code-automations ingest-github",
  );

  // 27. claude-desktop-cowork export ----------------------------------------
  const cdcw = program.command("claude-desktop-cowork").description("Claude desktop app Co-Work memory commands");
  stub(
    cdcw
      .command("export")
      .description("Build a Claude Desktop Co-Work L5 manifest (metadata only)")
      .addOption(hidden("--store-dir <dir>"))
      .option("--out <path>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--print")
      .option("--verbose"),
    "claude-desktop-cowork export",
  );

  // 28. claude-desktop-code export ------------------------------------------
  const cdco = program.command("claude-desktop-code").description("Claude desktop app GUI Claude Code memory commands");
  stub(
    cdco
      .command("export")
      .description("Build a Claude Desktop Code L5 manifest (metadata only)")
      .addOption(hidden("--store-dir <dir>"))
      .option("--out <path>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--print")
      .option("--verbose"),
    "claude-desktop-code export",
  );

  // 29. benchmark latency ---------------------------------------------------
  const benchmark = program.command("benchmark").description("Bourdon benchmarks");
  stub(
    benchmark
      .command("latency")
      .description("Run the first-turn recognition latency harness")
      .argument("[harness_args...]", "Arguments forwarded to scripts/latency_harness.py"),
    "benchmark latency",
  );

  // 30. setup ---------------------------------------------------------------
  stub(
    program
      .command("setup")
      .description("Interactive post-install wizard")
      .option("--library-path <path>")
      .option("--non-interactive")
      .option("--dry-run"),
    "setup",
  );

  // 31. demo ----------------------------------------------------------------
  stub(
    program
      .command("demo")
      .description("Self-contained cross-machine recognition walkthrough")
      .addOption(accessLevel("public")) // demo defaults access_level=public (NOT team)
      .option("--no-keep"),
    "demo",
  );

  // 32. sync {push,pull} ----------------------------------------------------
  const sync = program.command("sync").description("Push/pull the agent-library across machines via rsync");
  stub(
    sync
      .command("push")
      .description("Push the local agent-library to <dest>, filtered by visibility")
      .argument("<dest>")
      .addOption(accessLevel("public")) // sync push defaults access_level=public (opt-in team/private)
      .option("--library-path <path>")
      .option("--dry-run")
      .option("--delete")
      .option("--verbose"),
    "sync push",
  );
  stub(
    sync
      .command("pull")
      .description("Pull a remote agent-library into the local one") // NB: no --access-level
      .argument("<src>")
      .option("--library-path <path>")
      .option("--dry-run")
      .option("--delete")
      .option("--verbose"),
    "sync pull",
  );

  // exitOverride on every command so help/parse-errors throw (never
  // process.exit) and main() can map them to a return code.
  applyExitOverride(program);
  return program;
}

/** Recursively make every command throw on exit instead of calling
 * process.exit, so {@link main} owns the exit code. */
function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub);
}

/** Register the `codex` group. Only `compile-turn` is wired live (via the
 * ported @getbourdon/inference turn compiler); the rest keep the parser surface
 * but defer to the Python CLI. Watch the hook's hidden default divergence:
 * `--max-items 1` / `--max-chars 500` vs `6` / `1800` everywhere else. */
function registerCodex(program: Command): void {
  const codex = program.command("codex").description("Codex-specific commands");

  stub(
    codex
      .command("export")
      .description("Build a Codex L5 manifest")
      .option("--since <iso>")
      .option("--out <path>")
      .addOption(accessLevel())
      .addOption(hidden("--codex-home <dir>"))
      .addOption(hidden("--codex-brain <dir>")),
    "codex export",
  );
  stub(
    codex
      .command("build-context")
      .description("Generate Codex L0/L1 artifacts")
      .requiredOption("--out-dir <dir>") // the ONLY required option in the tree
      .option("--since <iso>")
      .addOption(hidden("--codex-home <dir>"))
      .addOption(hidden("--codex-brain <dir>")),
    "codex build-context",
  );
  stub(
    codex
      .command("doctor")
      .description("Diagnose Codex memory sources")
      .option("--report-out <path>")
      .addOption(hidden("--codex-home <dir>"))
      .addOption(hidden("--codex-brain <dir>")),
    "codex doctor",
  );
  stub(
    codex
      .command("sync-native")
      .description("Render Bourdon fallback recall into a Codex-native memory file")
      .option("--dry-run") // mutex with --write; default is dry-run
      .option("--write")
      .option("--out <path>")
      .addOption(new Option("--max-sessions <n>").default(20).argParser(Number))
      .option("--memory-md")
      .option("--from-library")
      .option("--include-local")
      .addOption(accessLevel())
      .option("--library-path <path>")
      .addOption(hidden("--codex-home <dir>"))
      .addOption(hidden("--codex-brain <dir>")),
    "codex sync-native",
  );
  stub(
    codex
      .command("recognize")
      .description("Run the Codex recognition layer for one prompt")
      .argument("<prompt>")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--report-out <path>")
      .option("--prompt-context")
      .addOption(hidden("--codex-home <dir>"))
      .addOption(hidden("--codex-brain <dir>")),
    "codex recognize",
  );
  stub(
    codex
      .command("prepare-turn")
      .description("Refresh Codex memory surfaces and return recognition context")
      .argument("<prompt>")
      .option("--write")
      .option("--memory-md")
      .option("--native-out <path>")
      .option("--l5-out <path>")
      .addOption(new Option("--max-sessions <n>").default(20).argParser(Number))
      .addOption(new Option("--strategy <s>").choices(["legacy", "turn-compiled"]).default("legacy"))
      .option("--cwd <dir>")
      .option("--library-path <path>")
      .addOption(new Option("--max-items <n>").default(6).argParser(Number))
      .addOption(new Option("--max-chars <n>").default(1800).argParser(Number))
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--report-out <path>")
      .addOption(hidden("--codex-home <dir>"))
      .addOption(hidden("--codex-brain <dir>")),
    "codex prepare-turn",
  );
  // codex compile-turn — LIVE (via @getbourdon/inference).
  leaf(
    codex
      .command("compile-turn")
      .description("Compile a turn-scoped Codex recognition brief")
      .argument("<prompt>")
      .option("--cwd <dir>")
      .option("--library-path <path>")
      .addOption(hidden("--codex-home <dir>"))
      .addOption(accessLevel())
      .addOption(new Option("--max-items <n>").default(6).argParser(Number))
      .addOption(new Option("--max-chars <n>").default(1800).argParser(Number))
      .addOption(new Option("--format <fmt>").choices(["yaml", "json"]).default("yaml"))
      .addOption(
        new Option("--delivery <d>").choices(["explicit", "mcp", "memory-md", "fallback", "all"]).default("all"),
      )
      .option("--report-out <path>"),
    handleCodexCompileTurn,
  );
  const hook = codex.command("hook").description("Codex CLI hook handlers");
  stub(
    hook
      .command("user-prompt-submit")
      .description("Inject a Codex UserPromptSubmit recognition brief")
      .option("--cwd <dir>")
      .option("--library-path <path>")
      .addOption(hidden("--codex-home <dir>"))
      .addOption(accessLevel())
      // Hidden divergence: the hook caps at 1 item / 500 chars, NOT 6 / 1800.
      .addOption(new Option("--max-items <n>").default(1).argParser(Number))
      .addOption(new Option("--max-chars <n>").default(500).argParser(Number))
      .option("--verbose"),
    "codex hook user-prompt-submit",
  );
  stub(
    codex
      .command("eval")
      .description("Evaluate Codex sources")
      .option("--fixtures") // mutex with --live
      .option("--live")
      .option("--since <iso>")
      .addOption(accessLevel())
      .option("--report-out <path>")
      .addOption(hidden("--codex-home <dir>"))
      .addOption(hidden("--codex-brain <dir>"))
      .option("--recognition")
      .option("--turn-compiler")
      .option("--cwd <dir>")
      .option("--library-path <path>")
      .addOption(new Option("--max-items <n>").default(6).argParser(Number))
      .addOption(new Option("--max-chars <n>").default(1800).argParser(Number)),
    "codex eval",
  );
}

/**
 * Parse `argv` (already sliced — no node/script prefix) and dispatch. Mirrors
 * `cli/main.py::main`: a parse with no leaf `func` prints help and returns 1;
 * otherwise the leaf handler's return value is the exit code.
 */
export async function main(argv: string[]): Promise<number> {
  captured = null;
  const program = buildProgram();
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    const e = err as { code?: string; exitCode?: number };
    // Explicit `--help` / `--version`: commander threw to avoid process.exit. Clean.
    if (e.code === "commander.helpDisplayed" || e.code === "commander.version") {
      return 0;
    }
    // Auto-help because no leaf command ran (bare `bourdon` or a bare group):
    // mirror argparse's no-func branch → exit 1.
    if (e.code === "commander.help") return 1;
    // Parse errors (unknown command/option, missing required arg): argparse-style
    // usage exit. Commander already wrote the message to stderr.
    return e.exitCode ?? 2;
  }
  if (captured !== null) return captured;
  // No leaf action ran — a bare group (e.g. `bourdon cursor`). Mirror argparse's
  // no-func branch: print top-level help, exit 1.
  program.outputHelp();
  return 1;
}
