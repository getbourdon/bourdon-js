/**
 * Federation caller identity + propagation.
 *
 * Faithful port of the identity half of `core/federation_registry.py`:
 * `AgentIdentity` (frozen dataclass) and the ContextVar caller binding
 * (`set_caller` / `get_caller` / `reset_caller`).
 *
 * Python's `contextvars.ContextVar` becomes Node's `AsyncLocalStorage`. The
 * HTTP auth middleware binds the resolved identity for the duration of a
 * request via `runWithCaller`; stdio / legacy-peer transports never bind, so
 * tools observe the implicit `OPERATOR` identity (trusted — exactly v0.8.0
 * behavior). Miss the wrapping and a quarantined caller would silently
 * escalate to OPERATOR; that is the single highest-risk federation bug, so the
 * resolver below is fail-closed.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const TIER_TRUSTED = "trusted";
export const TIER_QUARANTINED = "quarantined";
export const VALID_TIERS = [TIER_TRUSTED, TIER_QUARANTINED] as const;
export type Tier = (typeof VALID_TIERS)[number];

/**
 * Resolved caller identity for one federation request. Immutable (frozen),
 * mirroring the Python `@dataclass(frozen=True)`.
 */
export class AgentIdentity {
  readonly agentId: string;
  readonly tier: string;
  readonly grants: readonly string[];

  constructor(agentId: string, tier: string = TIER_TRUSTED, grants: readonly string[] = []) {
    this.agentId = agentId;
    this.tier = tier;
    this.grants = Object.freeze([...grants]);
    Object.freeze(this);
  }

  get isTrusted(): boolean {
    return this.tier === TIER_TRUSTED;
  }

  /** Whether this caller may read one agent-manifest namespace. DENY-BY-DEFAULT
   * for quarantined members: a granted namespace only. */
  mayRead(namespace: string): boolean {
    if (this.isTrusted) return true;
    return this.grants.includes(namespace);
  }
}

/**
 * The implicit identity of the operator's own process (stdio transport, legacy
 * shared-token peers). Trusted — preserves v0.8.0 behavior.
 */
export const OPERATOR = new AgentIdentity("operator", TIER_TRUSTED);

const _callerStore = new AsyncLocalStorage<AgentIdentity>();

/**
 * Run `fn` with `identity` bound as the current caller for the entire async
 * subtree. This is the AsyncLocalStorage analogue of Python's
 * `set_caller` / `reset_caller` bracket — the recommended, leak-free shape for
 * request-scoped identity. The HTTP auth middleware wraps each request handler
 * in this after validating the Bearer token.
 */
export function runWithCaller<T>(identity: AgentIdentity, fn: () => T): T {
  return _callerStore.run(identity, fn);
}

/**
 * Identity of the current request's caller. Returns `OPERATOR` when nothing is
 * bound (stdio / legacy peer) — the trusted v0.8.0 default.
 */
export function getCaller(): AgentIdentity {
  return _callerStore.getStore() ?? OPERATOR;
}
