/* GENERATED from schema/L5_schema.json via json-schema-to-typescript. Do NOT edit by hand: run `pnpm --filter @getbourdon/l5 gen`. */

/**
 * public = published to all L6 stores | team = team L6 only | private = local L6 only, never federated outward
 */
export type Visibility = "public" | "team" | "private";

/**
 * A per-agent public memory glossary. L5 is a projection of L0-L4 personal memory into a standardized, agent-readable form with visibility filtering applied. L6 (the federation library) aggregates L5 manifests across agents.
 */
export interface BourdonL5AgentMemoryManifest {
  /**
   * Bourdon spec version this manifest conforms to (semver). L6 warns when reading a manifest with an incompatible version.
   */
  spec_version: string;
  agent: {
    /**
     * Unique slug for this agent. Used as the L6 filename and cross-agent reference key.
     */
    id: string;
    /**
     * Agent category. Informs L6 query routing and UI grouping.
     */
    type:
      | "code-assistant"
      | "note-capture"
      | "local-swarm"
      | "customer-support"
      | "research-assistant"
      | "creative-collaborator"
      | "project-manager"
      | "tutor"
      | "other";
    /**
     * Optional machine/deployment identifier. Helps federate memory across multiple instances of the same agent on different machines.
     */
    instance?: string;
    /**
     * Version range of Bourdon specs this manifest is compatible with. Uses npm-style semver ranges. If omitted, assumed equal to spec_version.
     */
    spec_version_compat?: string;
    /**
     * Free-text description of the agent's role within a fleet. Differentiates agents that share the same `type` slug (e.g. multiple code-assistants playing different roles like manager, lead author, debugger, throwaway). Used by L6 to answer 'who should I ask about X?' style queries.
     */
    role_narrative?: string;
    [k: string]: unknown;
  };
  /**
   * ISO 8601 UTC timestamp of when this manifest was last regenerated.
   */
  last_updated: string;
  /**
   * Optional list of capabilities this agent offers. Enables L6 queries like 'which agent can analyze images?' Free-text slugs; no central registry (yet).
   *
   * @maxItems 64
   */
  capabilities?: string[];
  /**
   * Rolling window of recent sessions. Typical retention: 30 days or 100 sessions, whichever is greater. Older sessions should be rolled up into L3/L4 personal memory and omitted from L5.
   *
   * @maxItems 500
   */
  recent_sessions?: Session[];
  /**
   * The glossary surface. Each entity is something this agent knows about and can provide context on. L6 uses this for cross-agent entity lookup. Respect visibility_policy when emitting.
   *
   * @maxItems 1000
   */
  known_entities?: Entity[];
  /**
   * Default visibility rules applied when an entity does not declare its own visibility.
   */
  visibility_policy?: {
    default?: Visibility;
    /**
     * Entity tags that auto-mark the entity as private (overriding any explicit visibility setting).
     */
    private_tags?: string[];
    /**
     * Entity tags that mark entities as team-visibility (shared with team L6 but not public).
     */
    team_tags?: string[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
export interface Session {
  /**
   * ISO 8601 date the session occurred (date-only, no time).
   */
  date: string;
  /**
   * Working directory of the session. Optional but highly useful for developer-tool participants.
   */
  cwd?: string;
  /**
   * Entity IDs the session focused on. Cross-references known_entities.
   */
  project_focus?: string[];
  /**
   * Brief list of what happened. 1-5 short strings.
   *
   * @maxItems 10
   */
  key_actions?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
  /**
   * Paths or patterns modified during the session. Optional.
   *
   * @maxItems 50
   */
  files_touched?: string[];
  visibility?: Visibility;
  [k: string]: unknown;
}
export interface Entity {
  /**
   * Human-readable entity name. Used for L0 keyword matching.
   */
  name: string;
  /**
   * Semantic category. Extensible free-text; common values: project, product, person, customer, ticket, concept, compound, draft, site, client, decision.
   */
  type?: string;
  /**
   * Alternative names or abbreviations that should also match for L0 detection.
   *
   * @maxItems 16
   */
  aliases?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  /**
   * Short description (~1-3 sentences, <500 chars). L6 consumers see this as the entity's 'glossary entry.'
   */
  summary?: string;
  last_touched?: string;
  /**
   * ISO 8601 date this entity became active in the agent's worldview. When omitted, the entity has either always been valid or its start date is unknown. L6 queries can filter on this to answer 'what was active in Q1 2026?' style questions. Inspired by Zep's Graphiti temporal validity model.
   */
  valid_from?: string;
  /**
   * ISO 8601 date this entity stopped being active. Participants typically populate this when an entity is tagged 'archived' or 'canceled'. Absent (or null) means the entity is still active as of last_updated. Federation queries that filter by current time treat missing valid_to as 'still valid'.
   */
  valid_to?: string;
  /**
   * Free-text tags. Used for visibility_policy.private_tags/team_tags matching and for filtering in L6 queries.
   */
  tags?: string[];
  /**
   * public = published to all L6 stores | team = team L6 only | private = local L6 only, never federated outward
   */
  visibility?: "public" | "team" | "private";
  [k: string]: unknown;
}
