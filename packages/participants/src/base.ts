/**
 * Bourdon participant base — the Protocol → TS interface, errors, and the
 * AgentStore / HealthStatus types. Faithful port of `participants/base.py`.
 *
 * The L5 dataclass model (AgentInfo/Entity/Session/VisibilityPolicy/L5Manifest),
 * the `toDict` omission rules, and the visibility helpers all live in
 * `@getbourdon/l5` and are reused verbatim — only THAT output shape is the parity
 * contract. This module owns the participant CONTRACT surface around them.
 *
 * Contract semantics (enforced by every reader, asserted by the conformance
 * fixtures, never by trust):
 *   1. visibility filter BEFORE emission (`filterForFederation`) — private wins.
 *   2. deterministic / idempotent `exportL5` — same store → identical `toDict`.
 *   3. `healthCheck` NEVER throws — catch-all → degraded/blocked.
 *   4. every native string through `@getbourdon/redaction` before it enters L5.
 */

import type { L5ManifestModel, SessionModel } from "@getbourdon/l5";

/** Tied to Bourdon spec v0.1 — same literals as the Python oracle. */
export const CONTRACT_VERSION = "0.1";
export const SPEC_VERSION = "0.1";

// -- Errors -------------------------------------------------------------------

/** Base class for participant errors. */
export class ParticipantError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Raised by `discover()` when the native store cannot be found or read.
 * Non-fatal: L6 skips this agent rather than aborting the whole export. */
export class ParticipantDiscoveryError extends ParticipantError {}

/** Raised by `exportL5()` / `exportSessions()` when an export fails mid-op
 * (the store WAS present — distinct from a discovery miss). */
export class ParticipantExportError extends ParticipantError {}

/** Raised when the native store's version is outside the supported range.
 * Subtype of discovery error (a version mismatch is a discovery-time miss). */
export class ParticipantVersionMismatchError extends ParticipantDiscoveryError {}

// -- Data types ---------------------------------------------------------------

/** Metadata describing the native agent store. Returned by `discover()`. */
export interface AgentStore {
  path: string;
  version: string;
  metadata: Record<string, unknown>;
}

/** Returned by `healthCheck()`. Consumed by the `bourdon doctor` CLI. */
export interface HealthStatus {
  status: "ok" | "degraded" | "blocked";
  reason?: string;
  details: Record<string, unknown>;
  /** A human-runnable command to remedy a non-ok status. */
  proposedFix?: string;
}

// -- Protocol -----------------------------------------------------------------

/**
 * Structural interface every participant must satisfy (the Python
 * `@runtime_checkable Protocol`). Duck-typed at registration: a class is a
 * participant iff it has `agentId` + `agentType` + `exportL5` + `healthCheck`.
 *
 * Optional members (`displayName`, a `defaultNativePath` static) are documented
 * here as in the Python Protocol; discovery + the setup wizard fall back to
 * sensible defaults when absent.
 */
export interface BourdonParticipant {
  agentId: string;
  agentType: string;
  nativePath: string;

  /** Human-friendly label (e.g. "GitHub Copilot"). Optional. */
  displayName?: string;

  /** Confirm the native store exists; return metadata. Throws
   * {@link ParticipantDiscoveryError} when missing/unreadable. */
  discover(): AgentStore;

  /** Build the L5 manifest from native memory, applying the visibility filter
   * BEFORE return. Deterministic — same store yields the same manifest. */
  exportL5(since?: Date): L5ManifestModel;

  /** Export recent sessions in normalized schema. */
  exportSessions(since?: Date, limit?: number): SessionModel[];

  /** Return ok / degraded / blocked with a reason. MUST NOT throw. */
  healthCheck(): HealthStatus;
}

/**
 * Tiny structural guard mirroring Python's `_PARTICIPANT_MARKER_ATTRS`
 * duck-type: a value is a participant iff it carries the four marker members.
 */
export function isParticipant(obj: unknown): obj is BourdonParticipant {
  if (obj === null || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o["agentId"] === "string" &&
    typeof o["agentType"] === "string" &&
    typeof o["exportL5"] === "function" &&
    typeof o["healthCheck"] === "function"
  );
}
