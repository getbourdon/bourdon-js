/**
 * In-memory L5 dataclass model — direct port of the Python `@dataclass`es in
 * participants/base.py (AgentInfo, Entity, Session, VisibilityPolicy,
 * L5Manifest). These are the runtime objects that `toDict` serializes.
 *
 * The schema-faithful wire types live in `types.gen.ts` (generated from
 * schema/L5_schema.json). This file is the *builder* surface: the factories
 * establish the canonical key-insertion order — which IS the wire contract for
 * `toDict` (the L6 change-detection hash key) — and apply the dataclass field
 * defaults (empty-list factories + VisibilityPolicy.default = 'public').
 *
 * Per-dataclass field order (do not reorder — it is the hash key):
 *   L5Manifest      = [spec_version, agent, last_updated, capabilities,
 *                      recent_sessions, known_entities, visibility_policy]
 *   AgentInfo       = [id, type, instance, spec_version_compat, role_narrative]
 *   Entity          = [name, type, aliases, summary, last_touched, tags,
 *                      visibility, valid_from, valid_to]  (valid_* AFTER visibility)
 *   Session         = [date, cwd, project_focus, key_actions, files_touched, visibility]
 *   VisibilityPolicy= [default, private_tags, team_tags]
 */

import { Visibility } from "./visibility.js";

export interface AgentInfoModel {
  id: string;
  type: string;
  instance?: string | null;
  spec_version_compat?: string | null;
  role_narrative?: string | null;
}

export interface EntityModel {
  name: string;
  type?: string | null;
  aliases?: string[];
  summary?: string | null;
  last_touched?: string | null;
  tags?: string[];
  visibility?: Visibility | null;
  valid_from?: string | null;
  valid_to?: string | null;
}

export interface SessionModel {
  date: string;
  cwd?: string | null;
  project_focus?: string[];
  key_actions?: string[];
  files_touched?: string[];
  visibility?: Visibility | null;
}

export interface VisibilityPolicyModel {
  default?: Visibility;
  private_tags?: string[];
  team_tags?: string[];
}

export interface L5ManifestModel {
  spec_version: string;
  agent: AgentInfoModel;
  last_updated: string;
  capabilities?: string[];
  recent_sessions?: SessionModel[];
  known_entities?: EntityModel[];
  visibility_policy?: VisibilityPolicyModel | null;
}

// -- Factories (the canonical key order lives here, not in the interfaces) ------

export function makeAgentInfo(a: AgentInfoModel): AgentInfoModel {
  return {
    id: a.id,
    type: a.type,
    instance: a.instance ?? undefined,
    spec_version_compat: a.spec_version_compat ?? undefined,
    role_narrative: a.role_narrative ?? undefined,
  };
}

export function makeEntity(e: EntityModel): EntityModel {
  return {
    name: e.name,
    type: e.type ?? undefined,
    aliases: e.aliases ?? [],
    summary: e.summary ?? undefined,
    last_touched: e.last_touched ?? undefined,
    tags: e.tags ?? [],
    visibility: e.visibility ?? undefined,
    valid_from: e.valid_from ?? undefined,
    valid_to: e.valid_to ?? undefined,
  };
}

export function makeSession(s: SessionModel): SessionModel {
  return {
    date: s.date,
    cwd: s.cwd ?? undefined,
    project_focus: s.project_focus ?? [],
    key_actions: s.key_actions ?? [],
    files_touched: s.files_touched ?? [],
    visibility: s.visibility ?? undefined,
  };
}

/**
 * VisibilityPolicy with the Python NON-None default: `default` defaults to
 * 'public', so a present policy ALWAYS emits "default" even if the caller
 * omitted it. private_tags/team_tags default to [].
 */
export function makeVisibilityPolicy(p?: VisibilityPolicyModel | null): VisibilityPolicyModel {
  return {
    default: p?.default ?? Visibility.PUBLIC,
    private_tags: p?.private_tags ?? [],
    team_tags: p?.team_tags ?? [],
  };
}

export function makeManifest(m: L5ManifestModel): L5ManifestModel {
  return {
    spec_version: m.spec_version,
    agent: makeAgentInfo(m.agent),
    last_updated: m.last_updated,
    capabilities: m.capabilities ?? [],
    recent_sessions: (m.recent_sessions ?? []).map(makeSession),
    known_entities: (m.known_entities ?? []).map(makeEntity),
    visibility_policy: m.visibility_policy == null ? undefined : makeVisibilityPolicy(m.visibility_policy),
  };
}
