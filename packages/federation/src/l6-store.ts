/**
 * Bourdon L6 — Federation Library Store.
 *
 * Faithful port of `core/l6_store.py`. The cross-agent federation aggregator
 * over `<library>/agents/*.l5.yaml`. Pure store; the MCP wrapper lives in
 * `@getbourdon/mcp-server`.
 *
 * Security/parity invariants preserved IN CODE:
 *  - base64url cursor encode/decode (urlsafe, compact JSON `{"offset":N}`); a
 *    non-empty unreadable cursor THROWS (never a silent offset-0).
 *  - `listRecentWork` stable total order `(date desc, agent desc)` — cursor
 *    reliability across paginated calls depends on it.
 *  - `commitL5` runs behind an ASYNC MUTEX (the `threading.RLock` equivalent):
 *    Node interleaves at every `await`, so a read-modify-write-RELOAD without
 *    serialization is a lost-update race (3-Star P1-3).
 *  - `*Federated` fan out via `Promise.allSettled` (allSettled = graceful
 *    degrade): a raising / null / empty peer is warn-logged and dropped, never
 *    crashing the merge. Peer rows tagged `peer:<name>:<agent>` (idempotent).
 *  - Visibility filtering (`isVisible` + access-level precedence) on every read.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeL5Dict } from "@getbourdon/l5";
import { redactText } from "@getbourdon/redaction";
import { parse as yamlParse } from "yaml";

import type { AgentIdentity } from "./identity.js";
import type { RemoteL6Client } from "./remote-client.js";

export const DEFAULT_LIBRARY_PATH = join(homedir(), "agent-library");

// Pagination bounds for listRecentWork (see Python docstrings).
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_SINCE_DAYS = 14;

// -- Cursor helpers ------------------------------------------------------------

/** Encode a pagination offset as a base64url JSON `{"offset":N}` token
 * (compact separators), URL-safe + debuggable. */
export function encodeCursor(offset: number): string {
  const payload = JSON.stringify({ offset });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/** Decode a cursor to its offset. Returns 0 for null/"". THROWS on a non-empty
 * unreadable cursor (surfaced to the caller, never silently reset to 0). */
export function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor === "") return 0;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const data = JSON.parse(raw) as { offset?: unknown };
    if (data === null || typeof data !== "object" || !("offset" in data)) {
      throw new Error("missing offset");
    }
    const offset = Number(data.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("invalid offset");
    }
    return offset;
  } catch (exc) {
    throw new Error(`invalid cursor: ${JSON.stringify(cursor)} (${String(exc)})`);
  }
}

// -- Result types --------------------------------------------------------------

export class EntityMatch {
  name: string;
  agents: string[];
  types: string[];
  summaries: Record<string, string>;
  tags: string[];

  constructor(
    name: string,
    agents: string[] = [],
    types: string[] = [],
    summaries: Record<string, string> = {},
    tags: string[] = [],
  ) {
    this.name = name;
    this.agents = agents;
    this.types = types;
    this.summaries = summaries;
    this.tags = tags;
  }

  toDict(): Record<string, unknown> {
    return {
      name: this.name,
      agents: this.agents,
      types: this.types,
      summaries: this.summaries,
      tags: this.tags,
    };
  }
}

export class SessionRef {
  agent: string;
  date: string;
  cwd: string | null;
  projectFocus: string[];
  keyActions: string[];
  filesTouched: string[];

  constructor(
    agent: string,
    date: string,
    cwd: string | null = null,
    projectFocus: string[] = [],
    keyActions: string[] = [],
    filesTouched: string[] = [],
  ) {
    this.agent = agent;
    this.date = date;
    this.cwd = cwd;
    this.projectFocus = projectFocus;
    this.keyActions = keyActions;
    this.filesTouched = filesTouched;
  }

  toDict(summary = false): Record<string, unknown> {
    const base: Record<string, unknown> = {
      agent: this.agent,
      date: this.date,
      cwd: this.cwd,
      project_focus: this.projectFocus,
    };
    if (!summary) {
      base.key_actions = this.keyActions;
      base.files_touched = this.filesTouched;
    }
    return base;
  }
}

export class PaginatedSessions {
  sessions: SessionRef[];
  nextCursor: string | null;
  hasMore: boolean;

  constructor(sessions: SessionRef[] = [], nextCursor: string | null = null, hasMore = false) {
    this.sessions = sessions;
    this.nextCursor = nextCursor;
    this.hasMore = hasMore;
  }

  toDict(summary = false): Record<string, unknown> {
    return {
      sessions: this.sessions.map((s) => s.toDict(summary)),
      next_cursor: this.nextCursor,
      has_more: this.hasMore,
    };
  }

  get length(): number {
    return this.sessions.length;
  }

  [Symbol.iterator](): Iterator<SessionRef> {
    return this.sessions[Symbol.iterator]();
  }
}

export class ProjectSummary {
  project: string;
  agents: string[];
  recentSessions: SessionRef[];
  entities: EntityMatch[];

  constructor(
    project: string,
    agents: string[] = [],
    recentSessions: SessionRef[] = [],
    entities: EntityMatch[] = [],
  ) {
    this.project = project;
    this.agents = agents;
    this.recentSessions = recentSessions;
    this.entities = entities;
  }

  toDict(): Record<string, unknown> {
    return {
      project: this.project,
      agents: this.agents,
      recent_sessions: this.recentSessions.map((s) => s.toDict()),
      entities: this.entities.map((e) => e.toDict()),
    };
  }
}

type Dict = Record<string, unknown>;

// -- Visibility helpers (module-local, independent of l5/visibility) -----------

const VISIBILITY_RANK: Record<string, number> = { public: 0, team: 1, private: 2 };

function entityVisibility(entity: Dict): string {
  const explicit = entity.visibility;
  if (typeof explicit === "string") return explicit.toLowerCase();
  return "public";
}

function sessionVisibility(session: Dict): string {
  const explicit = session.visibility;
  if (typeof explicit === "string") return explicit.toLowerCase();
  return "public";
}

/**
 * Resolve access level. Precedence:
 *   1. explicit `accessLevel` argument (invalid -> throws)
 *   2. `includePrivate === true` -> "private"
 *   3. `BOURDON_DEFAULT_ACCESS_LEVEL` env (invalid -> warn + "public")
 *   4. "public" (most restrictive)
 */
export function resolveAccessLevel(includePrivate = false, accessLevel: string | null = null): string {
  if (accessLevel !== null && accessLevel !== undefined) {
    const normalized = accessLevel.trim().toLowerCase();
    if (!(normalized in VISIBILITY_RANK)) {
      throw new Error(`unsupported access_level: ${accessLevel}`);
    }
    return normalized;
  }
  if (includePrivate) return "private";
  const envDefault = process.env.BOURDON_DEFAULT_ACCESS_LEVEL;
  if (envDefault) {
    const normalized = envDefault.trim().toLowerCase();
    if (normalized in VISIBILITY_RANK) return normalized;
    console.warn(
      `BOURDON_DEFAULT_ACCESS_LEVEL=${JSON.stringify(envDefault)} is not ` +
        "public/team/private; falling back to public.",
    );
  }
  return "public";
}

/** Visible iff the thing's own visibility rank <= the requested level. Unknown
 * visibility normalizes to public. Entities use `name in thing` to pick the
 * entity-vs-session visibility reader, exactly like the Python. */
export function isVisible(thing: Dict, accessLevel: string): boolean {
  const vis = "name" in thing ? entityVisibility(thing) : sessionVisibility(thing);
  const normalized = vis in VISIBILITY_RANK ? vis : "public";
  return VISIBILITY_RANK[normalized]! <= VISIBILITY_RANK[accessLevel]!;
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function parseIsoDate(s: string): string | null {
  // Mirror `date.fromisoformat` for our fixtures: a plain YYYY-MM-DD. Unparseable
  // strings drop when a cutoff is set. Lexicographic compare is chronological
  // for this zero-padded format.
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Mirrors the agent.type enum in spec/L5_schema.json. */
export const ALLOWED_AGENT_TYPES: ReadonlySet<string> = new Set([
  "code-assistant",
  "note-capture",
  "local-swarm",
  "customer-support",
  "research-assistant",
  "creative-collaborator",
  "project-manager",
  "tutor",
  "other",
]);

const ENTITY_LIST_FIELDS = ["tags", "aliases"] as const;
const SESSION_LIST_FIELDS = ["project_focus", "key_actions", "files_touched"] as const;

function coerceList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function unionListField(target: Dict, fieldName: string, value: unknown): void {
  const current = coerceList(target[fieldName]);
  target[fieldName] = current;
  for (const item of coerceList(value)) {
    if (!current.includes(item)) current.push(item);
  }
}

function normalizedRow(row: Dict, listFields: readonly string[]): Dict {
  const out: Dict = { ...row };
  for (const fieldName of listFields) {
    if (fieldName in out) out[fieldName] = coerceList(out[fieldName]);
  }
  return out;
}

function mergeEntities(existing: Dict[], incoming: Dict[]): [number, number] {
  const byKey = new Map<string, Dict>();
  for (const e of existing) {
    const name = e.name;
    if (typeof name === "string") byKey.set(name.trim().toLowerCase(), e);
  }
  let added = 0;
  let updated = 0;
  for (const inc of incoming) {
    const key = String(inc.name).trim().toLowerCase();
    const target = byKey.get(key);
    if (target) {
      for (const [fieldName, value] of Object.entries(inc)) {
        if ((ENTITY_LIST_FIELDS as readonly string[]).includes(fieldName)) {
          unionListField(target, fieldName, value);
        } else if (value !== null && value !== undefined) {
          target[fieldName] = value;
        }
      }
      updated += 1;
    } else {
      const row = normalizedRow(inc, ENTITY_LIST_FIELDS);
      existing.push(row);
      byKey.set(key, row);
      added += 1;
    }
  }
  return [added, updated];
}

function mergeSessions(existing: Dict[], incoming: Dict[]): [number, number] {
  const keyOf = (s: Dict): string =>
    `${String(s.date ?? "")} ${String(s.cwd ?? "")}`;
  const byKey = new Map<string, Dict>();
  for (const s of existing) byKey.set(keyOf(s), s);
  let added = 0;
  let updated = 0;
  for (const inc of incoming) {
    const key = keyOf(inc);
    const target = byKey.get(key);
    if (target) {
      for (const [fieldName, value] of Object.entries(inc)) {
        if ((SESSION_LIST_FIELDS as readonly string[]).includes(fieldName)) {
          unionListField(target, fieldName, value);
        } else if (value !== null && value !== undefined) {
          target[fieldName] = value;
        }
      }
      updated += 1;
    } else {
      const row = normalizedRow(inc, SESSION_LIST_FIELDS);
      existing.push(row);
      byKey.set(key, row);
      added += 1;
    }
  }
  return [added, updated];
}

function asDictList(value: unknown): Dict[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is Dict => x !== null && typeof x === "object" && !Array.isArray(x));
}

export interface CommitL5Options {
  agentType?: string | null;
  instance?: string | null;
  roleNarrative?: string | null;
  entities?: Dict[] | null;
  sessions?: Dict[] | null;
  mode?: "merge" | "replace";
}

// -- Store ---------------------------------------------------------------------

export class L6Store {
  readonly libraryPath: string;
  peers: RemoteL6Client[];
  private _manifests = new Map<string, Dict>();
  private _entityIndex = new Map<string, Set<string>>();
  private _writeChain: Promise<unknown> = Promise.resolve();

  constructor(libraryPath?: string, peers: RemoteL6Client[] = []) {
    this.libraryPath = libraryPath ? libraryPath : DEFAULT_LIBRARY_PATH;
    this.peers = [...peers];
    this.reloadAll();
  }

  // -- Load / reload -------------------------------------------------------

  private _agentsDir(): string {
    return join(this.libraryPath, "agents");
  }

  reloadAll(): void {
    this._manifests.clear();
    this._entityIndex.clear();
    let files: string[];
    try {
      files = readdirSync(this._agentsDir());
    } catch {
      return; // agents dir absent -> empty store
    }
    const manifestFiles = files.filter((f) => f.endsWith(".l5.yaml")).sort();
    for (const f of manifestFiles) {
      this._loadOne(join(this._agentsDir(), f), f);
    }
  }

  reloadAgent(agentId: string): boolean {
    const fname = `${agentId}.l5.yaml`;
    const path = join(this._agentsDir(), fname);
    this._dropAgent(agentId);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return false; // agent removed -> dropped from memory
    }
    return this._loadOneFromText(text, path, fname);
  }

  private _dropAgent(agentId: string): void {
    this._manifests.delete(agentId);
    for (const [k, v] of [...this._entityIndex.entries()]) {
      if (v.has(agentId)) {
        v.delete(agentId);
        if (v.size === 0) this._entityIndex.delete(k);
      }
    }
  }

  private _loadOne(path: string, fname: string): boolean {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      console.warn(`Failed to load L5 manifest ${path}: ${String(e)}`);
      return false;
    }
    return this._loadOneFromText(text, path, fname);
  }

  private _loadOneFromText(text: string, path: string, fname: string): boolean {
    let data: unknown;
    try {
      data = yamlParse(text);
    } catch (e) {
      console.warn(`Failed to load L5 manifest ${path}: ${String(e)}`);
      return false;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      console.warn(`L5 manifest ${path} is not a dict, skipping`);
      return false;
    }
    const manifest = data as Dict;
    const agent = (manifest.agent as Dict) || {};
    let agentId = agent.id as string | undefined;
    if (!agentId) {
      // Fall back to filename (strip .l5.yaml) so bare files still load.
      agentId = fname.replace(/\.l5\.yaml$/, "").replace(/\.l5$/, "");
    }
    this._manifests.set(agentId, manifest);

    for (const entity of asDictList(manifest.known_entities)) {
      const name = entity.name;
      if (typeof name !== "string" || !name.trim()) continue;
      this._indexAdd(name.trim().toLowerCase(), agentId);
      for (const alias of coerceList(entity.aliases)) {
        if (typeof alias === "string" && alias.trim()) {
          this._indexAdd(alias.trim().toLowerCase(), agentId);
        }
      }
    }
    return true;
  }

  private _indexAdd(key: string, agentId: string): void {
    let set = this._entityIndex.get(key);
    if (!set) {
      set = new Set();
      this._entityIndex.set(key, set);
    }
    set.add(agentId);
  }

  // -- Query primitives ----------------------------------------------------

  listAgents(): string[] {
    return [...this._manifests.keys()].sort();
  }

  getAgentManifest(
    agentId: string,
    includePrivate = false,
    accessLevel: string | null = null,
  ): Dict | null {
    const manifest = this._manifests.get(agentId);
    if (manifest === undefined) return null;
    const resolved = resolveAccessLevel(includePrivate, accessLevel);
    const filtered: Dict = { ...manifest };
    filtered.known_entities = asDictList(manifest.known_entities).filter((e) =>
      isVisible(e, resolved),
    );
    filtered.recent_sessions = asDictList(manifest.recent_sessions).filter((s) =>
      isVisible(s, resolved),
    );
    return filtered;
  }

  buildRecognitionManifest(includePrivate = false, accessLevel: string | null = null): Dict {
    const resolved = resolveAccessLevel(includePrivate, accessLevel);
    const entitiesByKey = new Map<string, Dict>();
    const recentSessions: Dict[] = [];

    for (const agentId of [...this._manifests.keys()].sort()) {
      const manifest = this._manifests.get(agentId)!;
      for (const entity of asDictList(manifest.known_entities)) {
        if (!isVisible(entity, resolved)) continue;
        const name = entity.name;
        if (typeof name !== "string" || !name.trim()) continue;
        const entityType = String(entity.type || "topic");
        const key = name.trim().toLowerCase();
        let merged = entitiesByKey.get(key);
        if (!merged) {
          merged = {
            name: name.trim(),
            type: entityType,
            types: [],
            aliases: [],
            summary: String(entity.summary || ""),
            summaries: {},
            source_agents: [],
            tags: [],
            visibility: resolved,
          };
          entitiesByKey.set(key, merged);
        }
        appendUnique(merged.types as string[], entityType);
        appendUnique(merged.source_agents as string[], agentId);
        for (const alias of coerceList(entity.aliases)) {
          if (typeof alias === "string" && alias.trim()) {
            appendUnique(merged.aliases as string[], alias.trim());
          }
        }
        for (const tag of coerceList(entity.tags)) {
          if (typeof tag === "string" && tag.trim()) {
            appendUnique(merged.tags as string[], tag.trim());
          }
        }
        const summary = entity.summary;
        if (typeof summary === "string" && summary.trim()) {
          if (!merged.summary) merged.summary = summary.trim();
          (merged.summaries as Record<string, string>)[agentId] = summary.trim();
        }
      }

      for (const session of asDictList(manifest.recent_sessions)) {
        if (!isVisible(session, resolved)) continue;
        const copy: Dict = { ...session, agent: agentId };
        recentSessions.push(copy);
      }
    }

    recentSessions.sort((a, b) => {
      const da = String(a.date ?? "");
      const db = String(b.date ?? "");
      return da < db ? 1 : da > db ? -1 : 0; // date desc, stable for ties
    });

    return {
      spec_version: "0.1",
      agent: { id: "bourdon-l6", type: "federation" },
      last_updated: new Date().toISOString(),
      known_entities: [...entitiesByKey.values()],
      recent_sessions: recentSessions,
    };
  }

  findEntity(
    name: string,
    includePrivate = false,
    accessLevel: string | null = null,
  ): EntityMatch[] {
    const key = name.trim().toLowerCase();
    if (!key) return [];
    const resolved = resolveAccessLevel(includePrivate, accessLevel);
    const agentIds = [...(this._entityIndex.get(key) ?? new Set<string>())].sort();
    if (agentIds.length === 0) return [];

    const byExactName = new Map<string, EntityMatch>();
    for (const agentId of agentIds) {
      const manifest = this._manifests.get(agentId) ?? {};
      for (const entity of asDictList((manifest as Dict).known_entities)) {
        const entName = String(entity.name ?? "").trim();
        if (!entName || entName.toLowerCase() !== key) {
          const aliases = coerceList(entity.aliases);
          const aliasHit = aliases.some(
            (a) => typeof a === "string" && a.trim().toLowerCase() === key,
          );
          if (!aliasHit) continue;
        }
        if (!isVisible(entity, resolved)) continue;
        let match = byExactName.get(entName);
        if (!match) {
          match = new EntityMatch(entName);
          byExactName.set(entName, match);
        }
        if (!match.agents.includes(agentId)) match.agents.push(agentId);
        if (entity.type) {
          const t = String(entity.type);
          if (!match.types.includes(t)) match.types.push(t);
        }
        const summary = entity.summary;
        if (summary) match.summaries[agentId] = String(summary);
        for (const tag of coerceList(entity.tags)) {
          if (typeof tag === "string" && !match.tags.includes(tag)) match.tags.push(tag);
        }
      }
    }
    return [...byExactName.values()];
  }

  listRecentWork(opts: {
    since?: Date | null;
    agent?: string | null;
    includePrivate?: boolean;
    accessLevel?: string | null;
    limit?: number | null;
    cursor?: string | null;
  } = {}): PaginatedSessions {
    let since = opts.since ?? null;
    const agent = opts.agent ?? null;
    const cursor = opts.cursor ?? null;

    // Default-since window only on a fresh first call (no since AND no cursor).
    if (since === null && cursor === null) {
      since = new Date(Date.now() - DEFAULT_SINCE_DAYS * 86400_000);
    }

    let effectiveLimit = opts.limit === null || opts.limit === undefined ? DEFAULT_LIMIT : Math.trunc(opts.limit);
    if (effectiveLimit < 1) effectiveLimit = 1;
    if (effectiveLimit > MAX_LIMIT) effectiveLimit = MAX_LIMIT;

    const cutoff = since !== null ? since.toISOString().slice(0, 10) : null;
    const resolved = resolveAccessLevel(opts.includePrivate ?? false, opts.accessLevel ?? null);

    const allResults: SessionRef[] = [];
    const entries: [string, Dict][] =
      agent && this._manifests.has(agent)
        ? [[agent, this._manifests.get(agent)!]]
        : agent
          ? []
          : [...this._manifests.entries()];

    for (const [agentId, manifest] of entries) {
      for (const session of asDictList(manifest.recent_sessions)) {
        if (!isVisible(session, resolved)) continue;
        const sessionDate = session.date;
        if (cutoff !== null && typeof sessionDate === "string") {
          const parsed = parseIsoDate(sessionDate);
          if (parsed === null || parsed < cutoff) continue;
        }
        allResults.push(
          new SessionRef(
            agentId,
            String(sessionDate ?? ""),
            (session.cwd as string | null | undefined) ?? null,
            coerceList(session.project_focus) as string[],
            coerceList(session.key_actions) as string[],
            coerceList(session.files_touched) as string[],
          ),
        );
      }
    }

    // Stable sort: date desc, agent desc (tuple reverse). Cursor reliability
    // depends on this being stable across reloads of the same contents.
    allResults.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.agent !== b.agent) return a.agent < b.agent ? 1 : -1;
      return 0;
    });

    const offset = decodeCursor(cursor);
    const page = allResults.slice(offset, offset + effectiveLimit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < allResults.length;
    const nextCursor = hasMore ? encodeCursor(nextOffset) : null;

    return new PaginatedSessions(page, nextCursor, hasMore);
  }

  getCrossAgentSummary(
    project: string,
    includePrivate = false,
    accessLevel: string | null = null,
  ): ProjectSummary {
    const key = project.trim();
    const lowered = key.toLowerCase();
    const resolved = resolveAccessLevel(includePrivate, accessLevel);
    const entities = this.findEntity(key, includePrivate, resolved);
    const sessions: SessionRef[] = [];
    const agentSet = new Set<string>();
    for (const e of entities) for (const a of e.agents) agentSet.add(a);
    for (const [agentId, manifest] of this._manifests.entries()) {
      for (const session of asDictList(manifest.recent_sessions)) {
        const focus = coerceList(session.project_focus);
        const focusHit = focus.some(
          (p) => typeof p === "string" && p.trim().toLowerCase() === lowered,
        );
        if (!focusHit) continue;
        if (!isVisible(session, resolved)) continue;
        sessions.push(
          new SessionRef(
            agentId,
            String(session.date ?? ""),
            (session.cwd as string | null | undefined) ?? null,
            focus as string[],
            coerceList(session.key_actions) as string[],
            coerceList(session.files_touched) as string[],
          ),
        );
        agentSet.add(agentId);
      }
    }
    sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return new ProjectSummary(key, [...agentSet].sort(), sessions, entities);
  }

  /**
   * Source-attributed local agent export for the desktop tray / `export_agents`
   * tool, with the egress visibility clamp + credential redaction applied.
   *
   * EGRESS CLAMP (3-Star P0-1): PRIVATE session/entity content NEVER crosses
   * the wire. A trusted caller sees up to TEAM; a quarantined caller only
   * PUBLIC, and only the namespaces it `mayRead`. Every emitted string is run
   * through the redaction SSOT so a credential that slipped into a summary /
   * role_narrative is scrubbed before it leaves the machine.
   */
  exportAgents(caller: AgentIdentity, machine = "local"): Dict {
    const egress = caller.isTrusted ? "team" : "public";
    const agents: Dict[] = [];
    for (const agentId of this.listAgents()) {
      if (!caller.isTrusted && !caller.mayRead(agentId)) continue;
      const manifest = this.getAgentManifest(agentId, false, egress);
      if (manifest === null) continue;
      const agentBlock = (manifest.agent as Dict) || {};
      const row: Dict = {
        id: agentId,
        type: agentBlock.type ?? null,
        source: machine,
        source_kind: "local",
        last_updated: manifest.last_updated ?? "",
      };
      if (agentBlock.instance !== undefined) row.instance = agentBlock.instance;
      if (typeof agentBlock.role_narrative === "string") {
        row.role_narrative = redactText(agentBlock.role_narrative);
      }
      row.known_entities = asDictList(manifest.known_entities).map((e) => {
        const copy: Dict = { ...e };
        if (typeof copy.summary === "string") copy.summary = redactText(copy.summary);
        return copy;
      });
      row.recent_sessions = asDictList(manifest.recent_sessions).map((s) => {
        const copy: Dict = { ...s };
        if (Array.isArray(copy.key_actions)) {
          copy.key_actions = (copy.key_actions as unknown[]).map((k) =>
            typeof k === "string" ? redactText(k) : k,
          );
        }
        return copy;
      });
      agents.push(row);
    }
    return { schema: "bourdon.agents/v1", machine, agents };
  }

  // -- Federated async surfaces (Phase 1.6) --------------------------------

  async listAgentsFederated(): Promise<string[]> {
    const agents = new Set(this.listAgents());
    if (this.peers.length === 0) return [...agents].sort();
    const results = await Promise.allSettled(this.peers.map((p) => p.listAgents()));
    results.forEach((res, i) => {
      const peer = this.peers[i]!;
      if (res.status === "rejected") {
        console.warn(`peer ${peer.name} list_agents raised: ${String(res.reason)}`);
        return;
      }
      for (const a of res.value || []) if (typeof a === "string") agents.add(a);
    });
    return [...agents].sort();
  }

  async findEntityFederated(
    name: string,
    includePrivate = false,
    accessLevel: string | null = null,
  ): Promise<EntityMatch[]> {
    const local = this.findEntity(name, includePrivate, accessLevel);
    if (this.peers.length === 0) return local;
    const egressLevel = accessLevel ?? (includePrivate ? "private" : "public");
    const results = await Promise.allSettled(
      this.peers.map((p) => p.findEntity(name, egressLevel, includePrivate)),
    );
    const byKey = new Map<string, EntityMatch>();
    for (const m of local) byKey.set(m.name.toLowerCase(), m);
    results.forEach((res, i) => {
      const peer = this.peers[i]!;
      if (res.status === "rejected") {
        console.warn(`peer ${peer.name} find_entity raised: ${String(res.reason)}`);
        return;
      }
      for (const entry of res.value || []) {
        if (entry === null || typeof entry !== "object") continue;
        const entName = String((entry as Dict).name ?? "").trim();
        if (!entName) continue;
        const key = entName.toLowerCase();
        let target = byKey.get(key);
        if (!target) {
          target = new EntityMatch(entName);
          byKey.set(key, target);
        }
        for (const a of coerceList((entry as Dict).agents)) {
          if (typeof a === "string") {
            const tagged = a.startsWith("peer:") ? a : `peer:${peer.name}:${a}`;
            if (!target.agents.includes(tagged)) target.agents.push(tagged);
          }
        }
        for (const t of coerceList((entry as Dict).types)) {
          if (typeof t === "string" && !target.types.includes(t)) target.types.push(t);
        }
        for (const tag of coerceList((entry as Dict).tags)) {
          if (typeof tag === "string" && !target.tags.includes(tag)) target.tags.push(tag);
        }
        const summaries = (entry as Dict).summaries;
        if (summaries && typeof summaries === "object") {
          for (const [aid, summary] of Object.entries(summaries as Dict)) {
            if (typeof aid === "string" && typeof summary === "string") {
              const tagged = aid.startsWith("peer:") ? aid : `peer:${peer.name}:${aid}`;
              if (!(tagged in target.summaries)) target.summaries[tagged] = summary;
            }
          }
        }
      }
    });
    return [...byKey.values()];
  }

  async listRecentWorkFederated(opts: {
    since?: Date | null;
    agent?: string | null;
    includePrivate?: boolean;
    accessLevel?: string | null;
    limit?: number | null;
    cursor?: string | null;
  } = {}): Promise<PaginatedSessions> {
    const local = this.listRecentWork(opts);
    if (this.peers.length === 0) return local;
    const includePrivate = opts.includePrivate ?? false;
    const accessLevel = opts.accessLevel ?? null;
    const sinceStr = opts.since ? opts.since.toISOString() : null;
    const egressLevel = accessLevel ?? (includePrivate ? "private" : "public");
    const results = await Promise.allSettled(
      this.peers.map((p) =>
        p.listRecentWork({
          since: sinceStr,
          agent: opts.agent ?? null,
          accessLevel: egressLevel,
          includePrivate,
          limit: opts.limit ?? null,
          cursor: opts.cursor ?? null,
        }),
      ),
    );
    const seen = new Set<string>();
    const merged: SessionRef[] = [];
    const keyOf = (date: string, cwd: string | null, agent: string): string =>
      `${date} ${cwd ?? ""} ${agent}`;
    for (const s of local.sessions) {
      seen.add(keyOf(s.date, s.cwd, s.agent));
      merged.push(s);
    }
    results.forEach((res, i) => {
      const peer = this.peers[i]!;
      if (res.status === "rejected") {
        console.warn(`peer ${peer.name} list_recent_work raised: ${String(res.reason)}`);
        return;
      }
      const sessions = asDictList((res.value || {}).sessions);
      for (const s of sessions) {
        const rawAgent = String(s.agent ?? "");
        const taggedAgent = rawAgent.startsWith("peer:") ? rawAgent : `peer:${peer.name}:${rawAgent}`;
        const dateStr = String(s.date ?? "");
        const cwd = (s.cwd as string | null | undefined) ?? null;
        const key = keyOf(dateStr, cwd, taggedAgent);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(
          new SessionRef(
            taggedAgent,
            dateStr,
            cwd,
            coerceList(s.project_focus) as string[],
            coerceList(s.key_actions) as string[],
            coerceList(s.files_touched) as string[],
          ),
        );
      }
    });
    merged.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.agent !== b.agent) return a.agent < b.agent ? 1 : -1;
      return 0;
    });
    const effectiveLimit =
      opts.limit === null || opts.limit === undefined
        ? DEFAULT_LIMIT
        : Math.max(1, Math.min(Math.trunc(opts.limit), MAX_LIMIT));
    const page = merged.slice(0, effectiveLimit);
    return new PaginatedSessions(page, null, merged.length > page.length);
  }

  async getCrossAgentSummaryFederated(
    project: string,
    includePrivate = false,
    accessLevel: string | null = null,
  ): Promise<ProjectSummary> {
    const local = this.getCrossAgentSummary(project, includePrivate, accessLevel);
    if (this.peers.length === 0) return local;
    const egressLevel = accessLevel ?? (includePrivate ? "private" : "public");
    const results = await Promise.allSettled(
      this.peers.map((p) => p.getCrossAgentSummary(project, egressLevel, includePrivate)),
    );
    const agentSet = new Set(local.agents);
    const seen = new Set<string>();
    const mergedSessions: SessionRef[] = [];
    const keyOf = (date: string, cwd: string | null, agent: string): string =>
      `${date} ${cwd ?? ""} ${agent}`;
    for (const s of local.recentSessions) {
      seen.add(keyOf(s.date, s.cwd, s.agent));
      mergedSessions.push(s);
    }
    const mergedEntities = new Map<string, EntityMatch>();
    for (const m of local.entities) mergedEntities.set(m.name.toLowerCase(), m);
    results.forEach((res, i) => {
      const peer = this.peers[i]!;
      if (res.status === "rejected") {
        console.warn(`peer ${peer.name} get_cross_agent_summary raised: ${String(res.reason)}`);
        return;
      }
      const payload = res.value;
      if (payload === null || typeof payload !== "object") return;
      for (const a of coerceList((payload as Dict).agents)) {
        if (typeof a === "string") {
          agentSet.add(a.startsWith("peer:") ? a : `peer:${peer.name}:${a}`);
        }
      }
      for (const s of asDictList((payload as Dict).recent_sessions)) {
        const rawAgent = String(s.agent ?? "");
        const taggedAgent = rawAgent.startsWith("peer:") ? rawAgent : `peer:${peer.name}:${rawAgent}`;
        const cwd = (s.cwd as string | null | undefined) ?? null;
        const key = keyOf(String(s.date ?? ""), cwd, taggedAgent);
        if (seen.has(key)) continue;
        seen.add(key);
        mergedSessions.push(
          new SessionRef(
            taggedAgent,
            String(s.date ?? ""),
            cwd,
            coerceList(s.project_focus) as string[],
            coerceList(s.key_actions) as string[],
            coerceList(s.files_touched) as string[],
          ),
        );
      }
      for (const entry of asDictList((payload as Dict).entities)) {
        const entName = String(entry.name ?? "").trim();
        if (!entName) continue;
        const key2 = entName.toLowerCase();
        let target = mergedEntities.get(key2);
        if (!target) {
          target = new EntityMatch(entName);
          mergedEntities.set(key2, target);
        }
        for (const a of coerceList(entry.agents)) {
          if (typeof a === "string") {
            const tagged = a.startsWith("peer:") ? a : `peer:${peer.name}:${a}`;
            if (!target.agents.includes(tagged)) target.agents.push(tagged);
          }
        }
        for (const t of coerceList(entry.types)) {
          if (typeof t === "string" && !target.types.includes(t)) target.types.push(t);
        }
        for (const tag of coerceList(entry.tags)) {
          if (typeof tag === "string" && !target.tags.includes(tag)) target.tags.push(tag);
        }
        const summaries = entry.summaries;
        if (summaries && typeof summaries === "object") {
          for (const [aid, summary] of Object.entries(summaries as Dict)) {
            if (typeof aid === "string" && typeof summary === "string") {
              const tagged = aid.startsWith("peer:") ? aid : `peer:${peer.name}:${aid}`;
              if (!(tagged in target.summaries)) target.summaries[tagged] = summary;
            }
          }
        }
      }
    });
    mergedSessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return new ProjectSummary(project, [...agentSet].sort(), mergedSessions, [
      ...mergedEntities.values(),
    ]);
  }

  // -- Write surface -------------------------------------------------------

  /**
   * Serialize the read-modify-write-RELOAD behind an async mutex (3-Star
   * P1-3). Two concurrent commits to the same agent would otherwise both read
   * the same cached manifest, each build a merge missing the other's rows, and
   * the second write would silently drop the first's contribution (and could
   * corrupt the shared entity index). The chain makes the whole op atomic.
   */
  async commitL5(agentId: string, options: CommitL5Options = {}): Promise<Dict> {
    const run = this._writeChain.then(() => this._commitL5Impl(agentId, options));
    // Keep the chain alive even if this commit rejects, so a failed commit
    // never wedges subsequent ones.
    this._writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private _commitL5Impl(agentId: string, options: CommitL5Options): Dict {
    const mode = options.mode ?? "merge";
    if (!AGENT_ID_RE.test(agentId || "")) {
      throw new Error(`invalid agent_id ${JSON.stringify(agentId)}: must match ${AGENT_ID_RE.source}`);
    }
    if (mode !== "merge" && mode !== "replace") {
      throw new Error(`invalid mode ${JSON.stringify(mode)}: must be 'merge' or 'replace'`);
    }

    const newEntities = [...(options.entities ?? [])];
    const newSessions = [...(options.sessions ?? [])];
    for (const ent of newEntities) {
      if (ent === null || typeof ent !== "object" || Array.isArray(ent)) {
        throw new Error(`entity is not a dict: ${JSON.stringify(ent)}`);
      }
      const name = ent.name;
      if (typeof name !== "string" || !name.trim()) {
        throw new Error(`entity missing non-empty 'name': ${JSON.stringify(ent)}`);
      }
    }
    for (const ses of newSessions) {
      if (ses === null || typeof ses !== "object" || Array.isArray(ses)) {
        throw new Error(`session is not a dict: ${JSON.stringify(ses)}`);
      }
      const d = ses.date;
      if (typeof d !== "string" || !d.trim()) {
        throw new Error(`session missing non-empty 'date': ${JSON.stringify(ses)}`);
      }
    }

    const existing = mode === "merge" ? this._manifests.get(agentId) : undefined;

    let existingType: unknown = null;
    if (existing) existingType = ((existing.agent as Dict) || {}).type;
    const resolvedType = options.agentType ?? (existingType as string | null | undefined) ?? null;
    if (resolvedType === null || resolvedType === undefined) {
      throw new Error(
        `agent_type is required for a new manifest (agent_id=${JSON.stringify(agentId)}, mode=${JSON.stringify(mode)})`,
      );
    }
    if (!ALLOWED_AGENT_TYPES.has(resolvedType)) {
      throw new Error(
        `agent_type ${JSON.stringify(resolvedType)} is not in the L5 schema enum: ${JSON.stringify([...ALLOWED_AGENT_TYPES].sort())}`,
      );
    }

    let manifest: Dict;
    if (mode === "replace" || !existing) {
      manifest = {
        spec_version: "0.1",
        agent: { id: agentId, type: resolvedType },
        last_updated: new Date().toISOString(),
        recent_sessions: [],
        known_entities: [],
      };
    } else {
      manifest = JSON.parse(JSON.stringify(existing)) as Dict;
      const agentBlock = (manifest.agent = (manifest.agent as Dict) || {});
      agentBlock.id = agentId;
      agentBlock.type = resolvedType;
      manifest.spec_version ??= "0.1";
      manifest.last_updated = new Date().toISOString();
      manifest.known_entities ??= [];
      manifest.recent_sessions ??= [];
    }

    const agentBlock = manifest.agent as Dict;
    if (options.instance !== null && options.instance !== undefined) agentBlock.instance = options.instance;
    if (options.roleNarrative !== null && options.roleNarrative !== undefined) {
      agentBlock.role_narrative = options.roleNarrative;
    }

    const knownEntities = manifest.known_entities as Dict[];
    const recentSessions = manifest.recent_sessions as Dict[];
    const [entAdded, entUpdated] = mergeEntities(knownEntities, newEntities);
    const [sesAdded, sesUpdated] = mergeSessions(recentSessions, newSessions);

    recentSessions.sort((a, b) => {
      const da = String(a.date ?? "");
      const db = String(b.date ?? "");
      return da < db ? 1 : da > db ? -1 : 0;
    });

    const target = join(this._agentsDir(), `${agentId}.l5.yaml`);
    writeL5Dict(manifest, target);
    this.reloadAgent(agentId);

    return {
      agent_id: agentId,
      path: target,
      mode,
      entities_added: entAdded,
      entities_updated: entUpdated,
      sessions_added: sesAdded,
      sessions_updated: sesUpdated,
      total_entities: knownEntities.length,
      total_sessions: recentSessions.length,
      last_updated: manifest.last_updated,
    };
  }
}
