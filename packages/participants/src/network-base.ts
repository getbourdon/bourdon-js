/**
 * Network-shaped participant base — port of `participants/_network_base.py`
 * (v0.3 adapter contract). Same `exportL5` / `exportSessions` half as a file
 * participant; only the discovery half differs (fetch from an authenticated
 * API). The base provides the three guarantees so adapters don't reimplement:
 *
 *   1. Local TTL cache under `~/.cache/bourdon/<slug>/payload.json` storing ONLY
 *      `{fetched_at, payload}` — NEVER the token. A cache hit = zero network.
 *   2. Graceful degradation: network down → serve the most recent cached payload
 *      (even expired) and report `degraded` (not silence).
 *   3. Auth boundary: an injected lazy {@link AuthProvider} (env / keychain).
 *      An invalid token (401/403 non-ratelimit) ALWAYS propagates as `blocked`
 *      and is NEVER masked by stale cache; a missing token serves stale when a
 *      cache exists, else blocks; rate-limit degrades.
 *
 * A subclass sets `participantSlug` / `agentId` / `agentType` (+ `nativePath`)
 * and implements `fetchPayload(token)` + `payloadToL5(payload)` (pure, no I/O).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { L5ManifestModel, SessionModel } from "@getbourdon/l5";

import {
  ParticipantError,
  type AgentStore,
  type BourdonParticipant,
  type HealthStatus,
} from "./base.js";

export const NETWORK_CONTRACT_VERSION = "0.3";
/** Default cache TTL — adapters override via `cacheTtlSeconds`. */
export const DEFAULT_CACHE_TTL_SECONDS = 15 * 60; // 15 minutes

// -- Network-specific errors --------------------------------------------------

/** Transport failure / timeout / 5xx / rate-limit — recoverable via cache fallback. */
export class NetworkUnavailable extends ParticipantError {}

/** 401/403 / missing credential — NOT recoverable via cache. The user must fix
 * auth; surfaced as `blocked`, never silently served from stale cache (stale
 * data would mask a broken token indefinitely). */
export class ParticipantAuthError extends ParticipantError {}

// -- Auth provider ------------------------------------------------------------

/** A zero-arg callable returning the token string, or null if no credential is
 * available. Kept a callable (not a bare string) so the token is fetched lazily
 * at call time and never sits in the participant's fields or the cache. */
export type AuthProvider = () => string | null;

/** Auth provider that reads a token from an environment variable. */
export function envAuthProvider(varName: string): AuthProvider {
  return () => process.env[varName] || null;
}

// -- Cache --------------------------------------------------------------------

/** `$XDG_CACHE_HOME/bourdon` or `~/.cache/bourdon`. */
export function defaultCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg ? xdg : join(homedir(), ".cache");
  return join(base, "bourdon");
}

/** A cached payload + the wall-clock time it was fetched (epoch seconds). */
export class CacheEntry {
  constructor(
    readonly fetchedAt: number,
    readonly payload: Record<string, unknown>,
  ) {}

  get ageSeconds(): number {
    return Math.max(0, Date.now() / 1000 - this.fetchedAt);
  }

  isFresh(ttlSeconds: number): boolean {
    return this.ageSeconds < ttlSeconds;
  }
}

/**
 * A tiny JSON file cache, one file per participant slug. Stores only
 * `{fetched_at, payload}` — never the auth token. Read/write are best-effort: a
 * corrupt or unwritable cache degrades to "no cache", never raises.
 */
export class PayloadCache {
  readonly slug: string;
  readonly root: string;
  readonly path: string;

  constructor(slug: string, rootDir?: string) {
    this.slug = slug;
    this.root = join(rootDir ?? defaultCacheRoot(), slug);
    this.path = join(this.root, "payload.json");
  }

  read(): CacheEntry | null {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return null;
    }
    if (typeof raw !== "object" || raw === null || !("payload" in raw)) return null;
    const obj = raw as Record<string, unknown>;
    let fetchedAt = Number(obj["fetched_at"] ?? 0);
    if (!Number.isFinite(fetchedAt)) fetchedAt = 0;
    const payload = obj["payload"];
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    return new CacheEntry(fetchedAt, payload as Record<string, unknown>);
  }

  write(payload: Record<string, unknown>): void {
    try {
      mkdirSync(this.root, { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fetched_at: Date.now() / 1000, payload }), "utf8");
      renameSync(tmp, this.path); // atomic
    } catch {
      /* best-effort; a write failure degrades to "no cache" */
    }
  }
}

export interface NetworkParticipantOptions {
  authProvider?: AuthProvider | null;
  cacheRoot?: string;
}

// -- Base participant ---------------------------------------------------------

/**
 * Base for participants whose native state lives behind an authenticated API.
 * Caching, degradation, the auth boundary, and the
 * `discover`/`exportL5`/`exportSessions`/`healthCheck` plumbing live here;
 * subclasses provide only `fetchPayload` + `payloadToL5`.
 */
export abstract class NetworkParticipant implements BourdonParticipant {
  participantSlug = "network";
  agentId = "network";
  agentType = "other";
  cacheTtlSeconds: number = DEFAULT_CACHE_TTL_SECONDS;
  nativePath = "network://";

  protected readonly authProvider: AuthProvider | null;
  private readonly cacheRoot?: string;
  private cacheInstance?: PayloadCache;

  constructor(opts: NetworkParticipantOptions = {}) {
    this.authProvider = opts.authProvider ?? null;
    this.cacheRoot = opts.cacheRoot;
  }

  /** Lazily built so it reads the SUBCLASS's `participantSlug` — subclass field
   * initializers run after `super()`, so building the cache in the constructor
   * would capture the base "network" slug instead. */
  protected get cache(): PayloadCache {
    if (!this.cacheInstance) {
      this.cacheInstance = new PayloadCache(this.participantSlug, this.cacheRoot);
    }
    return this.cacheInstance;
  }

  // -- Subclass hooks ---------------------------------------------------------

  /** Do the authenticated API call; return a JSON-serializable dict. Raise
   * {@link NetworkUnavailable} on transport/5xx/rate-limit (→ cache fallback) or
   * {@link ParticipantAuthError} on 401/403 (→ blocked, no fallback). */
  abstract fetchPayload(token: string): Record<string, unknown>;

  /** Normalize a (fresh or cached) payload into an L5 manifest. Pure, no I/O. */
  abstract payloadToL5(payload: Record<string, unknown>): L5ManifestModel;

  // -- Core fetch-with-cache-and-degrade -------------------------------------

  /**
   * Resolve (payload, source) where source is 'cache' | 'network' | 'stale-cache'.
   *   1. Fresh cache hit           → 'cache'        (no network)
   *   2. Miss/expired + token      → 'network'      (fetch + refresh cache)
   *   3. Net fails + any cache     → 'stale-cache'  (serve last good payload)
   *   4. Net fails + no cache      → raise
   * Auth errors are never swallowed — they propagate so health surfaces
   * 'blocked' rather than serving stale data behind a dead token.
   */
  protected getPayload(): { payload: Record<string, unknown>; source: string } {
    const cached = this.cache.read();
    if (cached !== null && cached.isFresh(this.cacheTtlSeconds)) {
      return { payload: cached.payload, source: "cache" };
    }

    const token = this.authProvider ? this.authProvider() : null;
    if (!token) {
      // No credential: if we have any cache, serve it stale; else blocked.
      if (cached !== null) return { payload: cached.payload, source: "stale-cache" };
      throw new ParticipantAuthError(
        `${this.participantSlug}: no auth token available and no cache`,
      );
    }

    let payload: Record<string, unknown>;
    try {
      payload = this.fetchPayload(token);
    } catch (err) {
      if (err instanceof ParticipantAuthError) throw err; // never mask a bad token
      if (err instanceof NetworkUnavailable) {
        if (cached !== null) return { payload: cached.payload, source: "stale-cache" };
        throw err;
      }
      throw err;
    }

    this.cache.write(payload);
    return { payload, source: "network" };
  }

  // -- Participant protocol ---------------------------------------------------

  discover(): AgentStore {
    const { source } = this.getPayload();
    return {
      path: this.nativePath,
      version: `${this.participantSlug}-network-v1`,
      metadata: { source, contract_version: NETWORK_CONTRACT_VERSION },
    };
  }

  exportL5(_since?: Date): L5ManifestModel {
    const { payload } = this.getPayload();
    return this.payloadToL5(payload);
  }

  exportSessions(since?: Date, limit = 100): SessionModel[] {
    const manifest = this.exportL5(since);
    let sessions = manifest.recent_sessions ?? [];
    if (since) {
      const cutoff = since.toISOString().slice(0, 10);
      sessions = sessions.filter((s) => (s.date || "") >= cutoff);
    }
    return sessions.slice(0, limit);
  }

  healthCheck(): HealthStatus {
    let source: string;
    try {
      source = this.getPayload().source;
    } catch (err) {
      if (err instanceof ParticipantAuthError) {
        return {
          status: "blocked",
          reason: String(err.message),
          details: { participant: this.participantSlug },
          proposedFix:
            `Provide a valid credential for ${this.participantSlug} ` +
            "(see the adapter docs for the auth path) and re-run `bourdon export-all`.",
        };
      }
      if (err instanceof NetworkUnavailable) {
        return {
          status: "degraded",
          reason: `network unavailable and no cache: ${err.message}`,
          details: { participant: this.participantSlug },
          proposedFix: "Check connectivity, then re-run `bourdon export-all`.",
        };
      }
      // Defense in depth: health_check must NEVER raise. An adapter's
      // fetchPayload should only raise the two contract errors; anything else is
      // reported as blocked rather than propagated.
      return {
        status: "blocked",
        reason: `unexpected error resolving payload: ${String(err)}`,
        details: { participant: this.participantSlug },
        proposedFix:
          `${this.participantSlug} raised an unexpected error during healthCheck; ` +
          "its fetchPayload should only raise ParticipantAuthError / NetworkUnavailable.",
      };
    }

    const cached = this.cache.read();
    const details: Record<string, unknown> = { participant: this.participantSlug, source };
    if (cached !== null) {
      details["cache_age_seconds"] = Math.round(cached.ageSeconds * 10) / 10;
      details["cache_fetched_at"] = new Date(cached.fetchedAt * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "+00:00");
    }
    if (source === "stale-cache") {
      return {
        status: "degraded",
        reason: "serving stale cache (network unavailable or no token)",
        details,
        proposedFix: "Restore connectivity / refresh the token to update.",
      };
    }
    return { status: "ok", details };
  }
}
