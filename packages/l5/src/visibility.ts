/**
 * Visibility model — faithful port of participants/base.py `Visibility`,
 * `apply_visibility`, and `filter_for_federation`.
 *
 * Precedence (highest first), VERIFIED against the Python oracle:
 *   1. entity.tags ∩ policy.private_tags non-empty -> PRIVATE
 *      (unconditional PII guardrail; overrides an explicit entity.visibility)
 *   2. entity.visibility set explicitly -> that value
 *   3. entity.tags ∩ policy.team_tags non-empty -> TEAM
 *   4. policy.default (or PUBLIC if policy is None)
 */

import type { EntityModel, VisibilityPolicyModel } from "./model.js";

/**
 * Where an entity is allowed to appear in federated stores. Members map to the
 * lowercase wire literals so serialization is just the value (no `.toLowerCase`).
 */
export const Visibility = {
  PUBLIC: "public",
  TEAM: "team",
  PRIVATE: "private",
} as const;

export type Visibility = (typeof Visibility)[keyof typeof Visibility];

function intersects(tags: Iterable<string>, against: readonly string[]): boolean {
  const set = against instanceof Set ? against : new Set(against);
  for (const t of tags) {
    if (set.has(t)) return true;
  }
  return false;
}

/**
 * Resolve an entity's effective visibility, applying policy tag rules.
 * Mirrors `participants/base.py::apply_visibility` exactly.
 */
export function applyVisibility(
  entity: EntityModel,
  policy?: VisibilityPolicyModel | null,
): Visibility {
  const privateTags = policy?.private_tags ?? [];
  const teamTags = policy?.team_tags ?? [];
  const defaultVis = policy?.default ?? Visibility.PUBLIC;
  const tagSet = new Set(entity.tags ?? []);

  // Private tags win unconditionally -- the PII-leak guardrail.
  if (intersects(tagSet, privateTags)) return Visibility.PRIVATE;

  // Explicit entity-level setting.
  if (entity.visibility != null) return entity.visibility;

  // Team tags.
  if (intersects(tagSet, teamTags)) return Visibility.TEAM;

  return defaultVis || Visibility.PUBLIC;
}

/**
 * Return only entities whose resolved visibility is not PRIVATE.
 * Mirrors `participants/base.py::filter_for_federation`. Operates on ENTITIES
 * only — sessions are not filtered at this participant-export layer.
 */
export function filterForFederation(
  entities: readonly EntityModel[],
  policy?: VisibilityPolicyModel | null,
): EntityModel[] {
  return entities.filter((e) => applyVisibility(e, policy) !== Visibility.PRIVATE);
}
