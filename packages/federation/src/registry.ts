/**
 * Bourdon federation identity registry — per-agent tokens + trust tiers.
 *
 * Faithful port of `core/federation_registry.py` (the registry half; the
 * identity half lives in `identity.ts`). Single-operator registry at
 * `~/.bourdon/federation.yaml` (override `BOURDON_FEDERATION_CONFIG`).
 *
 * Security invariants preserved IN CODE:
 *  - Tokens are `bdn_` + 24 random bytes hex (48 hex chars), returned ONCE and
 *    NEVER persisted/logged in plaintext; stored only as `token_sha256`.
 *  - `authenticate` hashes the presented token and compares against EVERY row
 *    with a constant-time compare (`crypto.timingSafeEqual`), no early exit, so
 *    timing never reveals which agent_id matched. Revoked rows are skipped.
 *  - An empty/falsy token authenticates NOWHERE (the P1-1 empty-Bearer guard).
 *  - Hot-reload staleness key is `(mtimeNs, size)` — NOT float mtime — so two
 *    writes within one coarse tick (Windows CI) plus a size tie-break never let
 *    a running server miss a `bourdon revoke` from another process.
 *  - `_load` fails CLOSED: a missing file or ANY parse error yields zero agents,
 *    so nothing authenticates off a corrupt registry.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { AgentIdentity, TIER_TRUSTED, VALID_TIERS } from "./identity.js";

export const DEFAULT_REGISTRY_PATH = join(homedir(), ".bourdon", "federation.yaml");

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Token prefix makes leaked tokens grep-able in secret scanners. */
const TOKEN_PREFIX = "bdn_";

export interface RegistryRow {
  tier?: string;
  token_sha256?: string;
  created_at?: string;
  revoked?: boolean;
  revoked_at?: string;
  rotated_at?: string;
  grants?: string[];
  [k: string]: unknown;
}

/** Row WITHOUT the token hash (safe to print), plus a `has_token` boolean. */
export type SafeRegistryRow = Omit<RegistryRow, "token_sha256"> & { has_token: boolean };

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function utcNowIso(): string {
  // "%Y-%m-%dT%H:%M:%SZ" — second precision, trailing Z.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Constant-time compare of two hex digests; false (not throw) on length
 * mismatch, mirroring Python's `hmac.compare_digest`. */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class FederationRegistry {
  readonly path: string;
  private _agents: Record<string, RegistryRow> = {};
  private _loadedStat: string | null = null;

  constructor(path?: string) {
    if (path === undefined) {
      const env = process.env.BOURDON_FEDERATION_CONFIG;
      path = env ? env : DEFAULT_REGISTRY_PATH;
    }
    this.path = path;
    this._load();
  }

  // -- persistence ---------------------------------------------------------

  /** Staleness key for cross-process reload detection: `${mtimeNs}:${size}`.
   * `mtimeNs` + `size` rather than float `mtime` — two writes within one
   * coarse tick (Windows CI) would otherwise be invisible to a running
   * server, which could miss a revocation. Size breaks the tie. */
  private _statKey(): string | null {
    try {
      const st = statSync(this.path, { bigint: true });
      return `${st.mtimeNs}:${st.size}`;
    } catch {
      return null;
    }
  }

  private _load(): void {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      // Missing file -> empty agents (fail closed, but "unconfigured").
      this._agents = {};
      this._loadedStat = null;
      return;
    }
    try {
      const data = (yamlParse(text) as { agents?: unknown }) || {};
      const agents = data.agents;
      this._agents =
        agents && typeof agents === "object" && !Array.isArray(agents)
          ? ({ ...(agents as Record<string, RegistryRow>) })
          : {};
      this._loadedStat = this._statKey();
    } catch (exc) {
      // Fail closed: no agents authenticate off a corrupt registry.
      console.error(`Failed to parse federation registry ${this.path}: ${String(exc)}`);
      this._agents = {};
      this._loadedStat = null;
    }
  }

  private _refreshIfStale(): void {
    if (this._statKey() !== this._loadedStat) {
      this._load();
    }
  }

  private _save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = { version: 1, agents: this._agents };
    const tmp = this.path.replace(/\.yaml$/, "") + ".yaml.tmp";
    // yaml.safe_dump(sort_keys=True) -> alphabetically sorted keys, recursively.
    writeFileSync(tmp, yamlStringify(payload, { sortMapEntries: true }), "utf8");
    renameSync(tmp, this.path);
    this._loadedStat = this._statKey();
  }

  // -- queries -------------------------------------------------------------

  /** Registry rows WITHOUT token hashes (safe to print), sorted by agent_id. */
  listAgents(): Record<string, SafeRegistryRow> {
    this._refreshIfStale();
    const out: Record<string, SafeRegistryRow> = {};
    for (const agentId of Object.keys(this._agents).sort()) {
      const row = this._agents[agentId]!;
      const safe: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k !== "token_sha256") safe[k] = v;
      }
      safe.has_token = Boolean(row.token_sha256);
      out[agentId] = safe as SafeRegistryRow;
    }
    return out;
  }

  get(agentId: string): RegistryRow | null {
    this._refreshIfStale();
    const row = this._agents[agentId];
    return row ? { ...row } : null;
  }

  /** True when at least one non-revoked member with a token exists. */
  hasActiveAgents(): boolean {
    this._refreshIfStale();
    return Object.values(this._agents).some((row) => row.token_sha256 && !row.revoked);
  }

  /** True when the operator has registered ANY member, even if all revoked.
   * Distinguishes "auth never set up" (middleware 503) from "your token is
   * invalid or revoked" (401). */
  isConfigured(): boolean {
    this._refreshIfStale();
    return Object.keys(this._agents).length > 0;
  }

  /**
   * Resolve a presented Bearer token to an identity, or `null`.
   *
   * Constant-time comparison over the stored hash, against EVERY row with no
   * early exit. Revoked members never authenticate. The token value itself is
   * never logged.
   */
  authenticate(token: string | null | undefined): AgentIdentity | null {
    if (!token) return null;
    this._refreshIfStale();
    const presented = hashToken(token);
    let matched: AgentIdentity | null = null;
    for (const [agentId, row] of Object.entries(this._agents)) {
      const stored = row.token_sha256 || "";
      // Compare against every row (no early exit) so timing doesn't reveal
      // which agent_id matched.
      if (stored && constantTimeHexEqual(presented, stored)) {
        if (row.revoked) continue;
        matched = new AgentIdentity(
          agentId,
          String(row.tier || TIER_TRUSTED),
          [...(row.grants || [])],
        );
      }
    }
    return matched;
  }

  // -- mutations -----------------------------------------------------------

  /** Register a member and return its plaintext token (shown ONCE). */
  addAgent(agentId: string, tier: string = "quarantined", grants: string[] | null = null): string {
    this._refreshIfStale();
    if (!AGENT_ID_RE.test(agentId || "")) {
      throw new RegistryError(
        `invalid agent_id ${JSON.stringify(agentId)}: must match ^[a-z0-9][a-z0-9_-]*$`,
      );
    }
    if (!(VALID_TIERS as readonly string[]).includes(tier)) {
      throw new RegistryError(`invalid tier ${JSON.stringify(tier)}: must be one of ${VALID_TIERS}`);
    }
    const existing = this._agents[agentId];
    if (existing && !existing.revoked) {
      throw new RegistryError(
        `agent ${JSON.stringify(agentId)} already registered; use \`bourdon agent rotate\` ` +
          "for a new token or `bourdon revoke` first",
      );
    }
    const token = TOKEN_PREFIX + randomBytes(24).toString("hex");
    this._agents[agentId] = {
      tier,
      token_sha256: hashToken(token),
      created_at: utcNowIso(),
      revoked: false,
      grants: [...(grants || [])],
    };
    this._save();
    return token;
  }

  /** Replace a member's token, keeping tier/grants. Returns new plaintext. */
  rotateToken(agentId: string): string {
    this._refreshIfStale();
    const row = this._require(agentId);
    if (row.revoked) {
      throw new RegistryError(`agent ${JSON.stringify(agentId)} is revoked; re-add it instead`);
    }
    const token = TOKEN_PREFIX + randomBytes(24).toString("hex");
    row.token_sha256 = hashToken(token);
    row.rotated_at = utcNowIso();
    this._save();
    return token;
  }

  /** Invalidate a member immediately. Token stops authenticating; audit
   * history remains queryable. */
  revoke(agentId: string): void {
    this._refreshIfStale();
    const row = this._require(agentId);
    row.revoked = true;
    row.revoked_at = utcNowIso();
    this._save();
  }

  setTier(agentId: string, tier: string): void {
    this._refreshIfStale();
    if (!(VALID_TIERS as readonly string[]).includes(tier)) {
      throw new RegistryError(`invalid tier ${JSON.stringify(tier)}: must be one of ${VALID_TIERS}`);
    }
    const row = this._require(agentId);
    row.tier = tier;
    this._save();
  }

  /** Allow a quarantined member to read one agent-manifest namespace. */
  grant(agentId: string, namespace: string): void {
    this._refreshIfStale();
    if (!AGENT_ID_RE.test(namespace || "")) {
      throw new RegistryError(`invalid namespace ${JSON.stringify(namespace)}`);
    }
    const row = this._require(agentId);
    const grants = (row.grants ??= []);
    if (!grants.includes(namespace)) grants.push(namespace);
    this._save();
  }

  ungrant(agentId: string, namespace: string): void {
    this._refreshIfStale();
    const row = this._require(agentId);
    const grants = (row.grants ??= []);
    const idx = grants.indexOf(namespace);
    if (idx !== -1) grants.splice(idx, 1);
    this._save();
  }

  private _require(agentId: string): RegistryRow {
    const row = this._agents[agentId];
    if (row === undefined) {
      throw new RegistryError(`unknown agent ${JSON.stringify(agentId)}`);
    }
    return row;
  }
}
