/**
 * Participant-layer commands — `doctor`, `export-all`, `agents` (tray
 * contract), plus the per-reader `hermes {export,doctor}` and `claude-code
 * export`. Backed by @getbourdon/participants (+ federation for the doctor
 * federation-hygiene checks). The two `export` leaves are SessionEnd-hook-safe:
 * silent, never raise, always return 0.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_LIBRARY_PATH,
  FederationRegistry,
  listStaged,
} from "@getbourdon/federation";
import { filterManifestForAccess } from "@getbourdon/inference";
import { writeL5Dict } from "@getbourdon/l5";
import { exportLocalAgents, resolveLocalName } from "@getbourdon/mcp-server";
import {
  ClaudeCodeParticipant,
  HermesParticipant,
  ParticipantDiscoveryError,
  discoverParticipants,
  toDict,
} from "@getbourdon/participants";

import { type Dict, printYaml, writeYamlIfRequested, NOT_PORTED_MESSAGE } from "../util.js";

function agentLibraryAgents(): string {
  return join(homedir(), "agent-library", "agents");
}

/** v0.9.0 federation hygiene checks — faithful port of
 * `_doctor_federation_checks` in cli/main.py. */
function doctorFederationChecks(): Dict[] {
  const checks: Dict[] = [];
  const registry = new FederationRegistry();
  const members = registry.listAgents();
  const memberIds = Object.keys(members);
  const legacy = Boolean(process.env.BOURDON_PEER_TOKEN_SERVER);

  if (memberIds.length === 0 && !legacy) {
    checks.push({
      check: "auth",
      status: "info",
      reason:
        "no federation members registered and no legacy token set — " +
        "HTTP transport will refuse non-loopback binds",
    });
  } else if (legacy && memberIds.length === 0) {
    checks.push({
      check: "auth",
      status: "warn",
      reason:
        "running on the legacy shared token only (BOURDON_PEER_TOKEN_SERVER) — " +
        "migrate peers to per-agent tokens via `bourdon agent add` for tiered " +
        "access + revocation",
    });
  } else {
    checks.push({ check: "auth", status: "ok", reason: `${memberIds.length} registered member(s)` });
  }

  for (const agentId of memberIds) {
    const row = members[agentId]!;
    if (row.tier !== "trusted" && row.tier !== "quarantined") {
      checks.push({
        check: "tier",
        status: "warn",
        agent: agentId,
        reason: `member has invalid/missing tier ${JSON.stringify(row.tier)}`,
        proposed_fix: `bourdon agent set-tier ${agentId} quarantined`,
      });
    }
    if (row.revoked && row.has_token) {
      checks.push({
        check: "revoked-token-present",
        status: "warn",
        agent: agentId,
        reason:
          "revoked member still has a token hash on file (it cannot authenticate, " +
          "but consider pruning the row)",
      });
    }
  }

  let staged: ReturnType<typeof listStaged>;
  try {
    staged = listStaged(DEFAULT_LIBRARY_PATH);
  } catch {
    staged = [];
  }
  for (const item of staged) {
    if (item.ageDays > 7) {
      checks.push({
        check: "stale-staged-write",
        status: "warn",
        agent: item.agentId,
        reason: `staged write from ${JSON.stringify(item.caller)} is ${item.ageDays.toFixed(0)} days old`,
        proposed_fix: `bourdon staging promote ${item.agentId}  # or: bourdon staging reject ${item.agentId}`,
      });
    }
  }
  if (staged.length > 0 && staged.every((item) => item.ageDays <= 7)) {
    checks.push({ check: "staging", status: "info", reason: `${staged.length} staged write(s) awaiting review` });
  }
  return checks;
}

export function handleDoctor(opts: Dict, _args: string[]): number {
  const results: Dict[] = [];
  for (const participant of discoverParticipants()) {
    try {
      const health = participant.healthCheck();
      const row: Dict = {
        agent: participant.agentId,
        status: health.status,
        reason: health.reason,
        details: health.details,
      };
      if (health.proposedFix) row.proposed_fix = health.proposedFix;
      results.push(row);
    } catch (exc) {
      results.push({
        agent: participant.agentId,
        status: "error",
        reason: String(exc),
        details: {},
        proposed_fix:
          "Participant raised during health_check. Run `bourdon doctor --report-out " +
          "doctor.yaml` and file an issue with the traceback.",
      });
    }
  }
  const report: Dict = { participants: results, federation: doctorFederationChecks() };
  writeYamlIfRequested(report, opts.reportOut as string | undefined);
  printYaml(report);
  return 0;
}

export function handleExportAll(opts: Dict, _args: string[]): number {
  const accessLevel = String(opts.accessLevel ?? "team");
  const since = opts.since ? new Date(String(opts.since)) : undefined;
  const library = opts.library ? String(opts.library) : DEFAULT_LIBRARY_PATH;
  const results: Dict[] = [];

  for (const participant of discoverParticipants()) {
    try {
      const manifest = participant.exportL5(since);
      const data = filterManifestForAccess(toDict(manifest), accessLevel);
      const outPath = join(library, "agents", `${participant.agentId}.l5.yaml`);
      writeL5Dict(data, outPath);
      results.push({
        agent: participant.agentId,
        status: "ok",
        path: outPath,
        entities: Array.isArray(data.known_entities) ? data.known_entities.length : 0,
        sessions: Array.isArray(data.recent_sessions) ? data.recent_sessions.length : 0,
      });
    } catch (exc) {
      results.push({ agent: participant.agentId, status: "error", reason: String(exc) });
    }
  }
  const report: Dict = { exports: results };
  writeYamlIfRequested(report, opts.reportOut as string | undefined);
  printYaml(report);
  return 0;
}

export function handleAgents(opts: Dict, _args: string[]): number {
  const agentsDir = opts.agentsDir ? String(opts.agentsDir) : agentLibraryAgents();
  let isDir = false;
  try {
    isDir = statSync(agentsDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    process.stderr.write(`agents: agent-library directory not found: ${agentsDir}\n`);
    return 2;
  }

  if (opts.federated) {
    // The federated fan-out (L6Store.export_agents_federated) is not yet ported
    // to the TS mirror. Local enumeration is the stable tray contract; the
    // federated merge requires the peer client + store-side merge.
    process.stderr.write(`agents --federated: ${NOT_PORTED_MESSAGE}\n`);
    return 2;
  }

  const report = exportLocalAgents(agentsDir, resolveLocalName());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

function hermesDefaultOut(): string {
  return join(homedir(), "agent-library", "agents", "hermes.l5.yaml");
}

function claudeCodeDefaultOut(): string {
  return join(homedir(), "agent-library", "agents", "claude-code.l5.yaml");
}

/** `hermes export` — hook-safe: silent on success, returns 0 in every failure mode. */
export function handleHermesExport(opts: Dict, _args: string[]): number {
  const verbose = Boolean(opts.verbose);
  let participant: HermesParticipant;
  try {
    participant = new HermesParticipant((opts.hermesHome as string | undefined) ?? undefined);
  } catch (exc) {
    if (verbose) process.stderr.write(`bourdon hermes export: init failed: ${String(exc)}\n`);
    return 0;
  }
  let manifest;
  try {
    manifest = participant.exportL5(opts.since ? new Date(String(opts.since)) : undefined);
  } catch (exc) {
    if (verbose) {
      const kind = exc instanceof ParticipantDiscoveryError ? "no data" : "failed";
      process.stderr.write(`bourdon hermes export: ${kind} (${String(exc)}), skipping\n`);
    }
    return 0;
  }
  try {
    const data = filterManifestForAccess(toDict(manifest), String(opts.accessLevel ?? "team"));
    writeL5Dict(data, opts.out ? String(opts.out) : hermesDefaultOut());
    if (opts.print) printYaml(data);
  } catch (exc) {
    if (verbose) process.stderr.write(`bourdon hermes export: write failed: ${String(exc)}\n`);
    return 0;
  }
  return 0;
}

export function handleHermesDoctor(opts: Dict, _args: string[]): number {
  let report: Dict;
  try {
    const participant = new HermesParticipant((opts.hermesHome as string | undefined) ?? undefined);
    const health = participant.healthCheck();
    report = {
      health: {
        status: health.status,
        reason: health.reason,
        details: health.details,
        proposed_fix: health.proposedFix,
      },
      native_path: participant.nativePath,
    };
  } catch (exc) {
    report = {
      health: {
        status: "blocked",
        reason: String(exc),
        details: {},
        proposed_fix:
          "Hermes participant could not be initialized. Ensure ~/.hermes/ exists " +
          "(or set $HERMES_HOME).",
      },
      native_path: null,
    };
  }
  writeYamlIfRequested(report, opts.reportOut as string | undefined);
  printYaml(report);
  return 0;
}

/** `claude-code export` — SessionEnd-hook contract: silent, never raises, returns 0. */
export function handleClaudeCodeExport(opts: Dict, _args: string[]): number {
  const verbose = Boolean(opts.verbose);
  try {
    const participant = new ClaudeCodeParticipant();
    const manifest = participant.exportL5(opts.since ? new Date(String(opts.since)) : undefined);
    const data = filterManifestForAccess(toDict(manifest), String(opts.accessLevel ?? "team"));
    writeL5Dict(data, opts.out ? String(opts.out) : claudeCodeDefaultOut());
    if (opts.print) printYaml(data);
  } catch (exc) {
    if (verbose) process.stderr.write(`bourdon claude-code export: ${String(exc)}\n`);
    return 0;
  }
  return 0;
}
