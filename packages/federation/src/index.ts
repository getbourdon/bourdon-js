/**
 * @getbourdon/federation — Bourdon L6, the cross-machine trust boundary (BUSL-1.1).
 *
 * The in-memory L6Store (visibility-filtered query primitives, base64url
 * cursors, async-mutex commitL5, Promise.allSettled peer fan-out), the
 * single-operator trust registry (bdn_ tokens, sha256 hash-only at rest,
 * constant-time compare, trust tiers), the AsyncLocalStorage caller identity,
 * the append-only audit log, quarantined staging, the tier-matrix enforcement
 * + egress/ingress clamps, and the depth-1 RemoteL6Client.
 *
 * Every invariant is enforced IN CODE, not by trust — a missed clamp leaks
 * PRIVATE data across machines. Python (`pip install bourdon`) is the oracle;
 * this mirror asserts against @getbourdon/conformance fed_seed_library /
 * tier_matrix / on_disk fixtures.
 */

// L6Store + query result types + cursor/visibility helpers.
export {
  L6Store,
  EntityMatch,
  SessionRef,
  PaginatedSessions,
  ProjectSummary,
  encodeCursor,
  decodeCursor,
  isVisible,
  resolveAccessLevel,
  ALLOWED_AGENT_TYPES,
  DEFAULT_LIBRARY_PATH,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_SINCE_DAYS,
  type CommitL5Options,
} from "./l6-store.js";

// Caller identity (frozen AgentIdentity + AsyncLocalStorage propagation).
export {
  AgentIdentity,
  OPERATOR,
  runWithCaller,
  getCaller,
  TIER_TRUSTED,
  TIER_QUARANTINED,
  VALID_TIERS,
  type Tier,
} from "./identity.js";

// Trust registry.
export {
  FederationRegistry,
  RegistryError,
  DEFAULT_REGISTRY_PATH,
  type RegistryRow,
  type SafeRegistryRow,
} from "./registry.js";

// Audit log.
export {
  FederationAudit,
  DEFAULT_AUDIT_PATH,
  DECISION_ALLOW,
  DECISION_DENY,
  auditTimestamp,
  serializeEntry,
  type AuditEntry,
} from "./audit.js";

// Quarantined staging.
export {
  StagedWrite,
  STAGING_DIRNAME,
  stagingRoot,
  stageManifest,
  mergeIntoStaged,
  listStaged,
  findStaged,
  promote,
  reject,
} from "./staging.js";

// Enforcement + clamps.
export {
  clampPeerAccess,
  exportEgressAccess,
  enforceToolAccess,
  type Denial,
  type EnforcementDecision,
} from "./enforcement.js";

// Remote peer client.
export {
  RemoteL6Client,
  type RemoteL6ClientOptions,
  type PeerTransport,
} from "./remote-client.js";

// Async mutex (the commitL5 RLock equivalent).
export { Mutex } from "./mutex.js";
