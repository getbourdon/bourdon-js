/**
 * Participant discovery — a STATIC TS registry replacing Python's `pkgutil`
 * package scan + entry-point duck-type (`participants/__init__.py`).
 *
 * Python scans the `participants/` package at runtime and duck-types each class
 * by `_PARTICIPANT_MARKER_ATTRS`. A filesystem package scan does not survive
 * bundling (`npx bourdon` is a single file), so the JS side declares an explicit
 * {@link FIRST_PARTY} array. The three preserved invariants:
 *   - output sorted by `agentId`
 *   - first-wins dedupe on `agentId`
 *   - log-and-skip a participant that throws on construction (one broken reader
 *     must NOT abort discovery / crash the CLI)
 *
 * The marker-attr duck-typing collapses into the {@link BourdonParticipant}
 * interface conformance (checked structurally via {@link isParticipant}).
 */

import { isParticipant, type BourdonParticipant } from "./base.js";
import { CascadeParticipant } from "./readers/cascade.js";
import { ClaudeCodeParticipant } from "./readers/claude-code.js";
import { ClaudeCodeAutomationsParticipant } from "./readers/claude-code-automations.js";
import { ClaudeDesktopCodeParticipant } from "./readers/claude-desktop-code.js";
import { ClaudeDesktopCoworkParticipant } from "./readers/claude-desktop-cowork.js";
import { CodexAutomationsParticipant } from "./readers/codex-automations.js";
import { CopilotParticipant } from "./readers/copilot.js";
import { CopilotAutomationsParticipant } from "./readers/copilot-automations.js";
import { CopilotCliParticipant } from "./readers/copilot-cli.js";
import { CopilotVscodeParticipant } from "./readers/copilot-vscode.js";
import { CursorParticipant } from "./readers/cursor.js";
import { CursorAutomationsParticipant } from "./readers/cursor-automations.js";
import { GitHubCopilotParticipant } from "./readers/github-copilot.js";
import { HermesParticipant } from "./readers/hermes.js";
import { OpenClawParticipant } from "./readers/openclaw.js";

/** A zero-arg-constructible participant class. */
export type ParticipantCtor = new () => BourdonParticipant;

/**
 * The first-party reader registry. Order here is irrelevant — discovery sorts by
 * `agentId`. Covers the base agents, their background-run "automations" variants,
 * the Claude-desktop surfaces, and the quarantined-class openclaw network reader.
 * codex — the ~2.6k-line turn-compiler reader — is the only one still deferred.
 */
export const FIRST_PARTY: ParticipantCtor[] = [
  CascadeParticipant as unknown as ParticipantCtor,
  ClaudeCodeParticipant as unknown as ParticipantCtor,
  ClaudeCodeAutomationsParticipant as unknown as ParticipantCtor,
  ClaudeDesktopCodeParticipant as unknown as ParticipantCtor,
  ClaudeDesktopCoworkParticipant as unknown as ParticipantCtor,
  CodexAutomationsParticipant as unknown as ParticipantCtor,
  CopilotParticipant as unknown as ParticipantCtor,
  CopilotAutomationsParticipant as unknown as ParticipantCtor,
  CopilotCliParticipant as unknown as ParticipantCtor,
  CopilotVscodeParticipant as unknown as ParticipantCtor,
  CursorParticipant as unknown as ParticipantCtor,
  CursorAutomationsParticipant as unknown as ParticipantCtor,
  GitHubCopilotParticipant as unknown as ParticipantCtor,
  HermesParticipant as unknown as ParticipantCtor,
  OpenClawParticipant as unknown as ParticipantCtor,
];

/** Minimal logger so a skipped participant is visible without a dep. */
const logger = {
  warn(msg: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[bourdon.participants] ${msg}`);
  },
};

/**
 * Instantiate each registered participant, duck-type the contract, sort by
 * `agentId`, and first-wins dedupe. A class that throws on construction is
 * logged and skipped — never propagated.
 */
export function discoverParticipants(
  ctors: ParticipantCtor[] = FIRST_PARTY,
): BourdonParticipant[] {
  const found = new Map<string, BourdonParticipant>();
  for (const Ctor of [...ctors, ...resolvePluginParticipants()]) {
    let instance: BourdonParticipant;
    try {
      instance = new Ctor();
    } catch (err) {
      logger.warn(
        `Skipping participant ${Ctor.name || "<anonymous>"}: construction failed: ${String(err)}`,
      );
      continue;
    }
    if (!isParticipant(instance)) continue;
    if (!found.has(instance.agentId)) found.set(instance.agentId, instance);
  }
  return [...found.values()].sort((a, b) =>
    a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0,
  );
}

/**
 * Optional Layer 2: third-party plugins declared via a `package.json`
 * `"bourdon": { participants: { ... } }` field. Gated behind `BOURDON_PLUGINS=1`
 * and a no-op today (no external participant exists yet) — the resolver ships so
 * the seam is wired, defaulted off so `npx bourdon` stays predictable.
 */
export function resolvePluginParticipants(): ParticipantCtor[] {
  if (process.env.BOURDON_PLUGINS !== "1") return [];
  // No external participant package exists yet; the resolver is intentionally a
  // no-op stub. When one ships, resolve its declared ctors here.
  return [];
}
