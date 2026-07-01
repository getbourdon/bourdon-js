/**
 * @getbourdon/participants — the external-agent → L5 reader layer (BUSL-1.1).
 *
 * Each participant normalizes a foreign agent's native memory store into a
 * visibility-filtered, redacted L5 manifest. Reader categories:
 *   - SQLite (read-only, better-sqlite3 mode=ro): {@link HermesParticipant},
 *     {@link CursorParticipant}, {@link CopilotCliParticipant}
 *   - file / convention:                          {@link ClaudeCodeParticipant},
 *     {@link CopilotParticipant}, {@link CascadeParticipant}
 *   - network (TTL cache + lazy AuthProvider):     {@link GitHubCopilotParticipant}
 *   - network + quarantined-class (handshake gate): {@link OpenClawParticipant}
 *
 * Four invariants enforced in code, not by trust: visibility-filter-before-
 * emission, deterministic exportL5, healthCheck never throws, redact every
 * native string. Discovery is a static registry ({@link discoverParticipants}).
 *
 * Python (`pip install bourdon`) is the oracle; this mirror asserts against the
 * @getbourdon/conformance `native_stores` fixtures (output shape only).
 * Still deferred: codex (the ~2.6k-line turn-compiler reader) lands in a
 * follow-on slice.
 */

// Contract surface: Protocol interface, errors, AgentStore + HealthStatus.
export {
  CONTRACT_VERSION,
  SPEC_VERSION,
  ParticipantError,
  ParticipantDiscoveryError,
  ParticipantExportError,
  ParticipantVersionMismatchError,
  isParticipant,
  type AgentStore,
  type BourdonParticipant,
  type HealthStatus,
} from "./base.js";

// SQLite read-only primitives.
export {
  sqliteAvailable,
  openReadonly,
  tryOpenReadonly,
  tableExists,
  tableColumns,
  epochToIsoDate,
  epochToIsoDatetime,
  projectKeyFromCwd,
  friendlyLabel,
  type OpenReadonlyOptions,
  type SqliteDatabase,
} from "./sqlite-base.js";

// Network base: TTL cache, AuthProvider, degrade-to-stale-cache, auth boundary.
export {
  NETWORK_CONTRACT_VERSION,
  DEFAULT_CACHE_TTL_SECONDS,
  NetworkUnavailable,
  ParticipantAuthError,
  NetworkParticipant,
  PayloadCache,
  CacheEntry,
  envAuthProvider,
  defaultCacheRoot,
  type AuthProvider,
  type NetworkParticipantOptions,
} from "./network-base.js";

// Readers.
export { HermesParticipant } from "./readers/hermes.js";
export { ClaudeCodeParticipant } from "./readers/claude-code.js";
export { GitHubCopilotParticipant, ghTokenProvider } from "./readers/github-copilot.js";
export { CursorParticipant } from "./readers/cursor.js";
export { CopilotParticipant } from "./readers/copilot.js";
export { CopilotCliParticipant } from "./readers/copilot-cli.js";
export { CascadeParticipant } from "./readers/cascade.js";
export {
  OpenClawParticipant,
  OpenClawApiClient,
  verifyInstance,
  MIN_PATCHED_VERSION,
} from "./readers/openclaw.js";
// Background-run "automations" variants (publish automation-run memory as L5 evidence).
export { ClaudeCodeAutomationsParticipant } from "./readers/claude-code-automations.js";
export { CodexAutomationsParticipant } from "./readers/codex-automations.js";
export { CopilotAutomationsParticipant } from "./readers/copilot-automations.js";
export { CursorAutomationsParticipant } from "./readers/cursor-automations.js";
// Claude desktop surfaces + VS Code Copilot.
export { ClaudeDesktopCodeParticipant } from "./readers/claude-desktop-code.js";
export { ClaudeDesktopCoworkParticipant } from "./readers/claude-desktop-cowork.js";
export { CopilotVscodeParticipant } from "./readers/copilot-vscode.js";

// Discovery (static registry).
export {
  FIRST_PARTY,
  discoverParticipants,
  resolvePluginParticipants,
  type ParticipantCtor,
} from "./registry.js";

// Re-exported from @getbourdon/l5 for convenience (the L5 model + serialization
// the readers build on; only this output shape is the parity contract).
export {
  Visibility,
  applyVisibility,
  filterForFederation,
  toDict,
  validateManifest,
  type EntityModel,
  type L5ManifestModel,
  type SessionModel,
  type VisibilityPolicyModel,
} from "@getbourdon/l5";
