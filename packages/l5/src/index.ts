/**
 * @getbourdon/l5 — Bourdon L5 agent-memory manifest.
 *
 * Schema-generated types (`types.gen.ts` from schema/L5_schema.json), ajv
 * (2020-12) validation, the visibility model, and the byte-faithful `toDict` +
 * atomic YAML writer. Python (`pip install bourdon`) is the oracle; this mirror
 * asserts against @getbourdon/conformance fixtures.
 */

// Validation (ajv 2020-12) + the loaded schema object.
export {
  l5Schema,
  validateManifest,
  type ValidationError,
  type ValidationResult,
} from "./validate.js";

// Visibility model + precedence helpers.
export { Visibility, applyVisibility, filterForFederation } from "./visibility.js";

// In-memory dataclass model + builder factories (canonical key order).
export {
  makeAgentInfo,
  makeEntity,
  makeManifest,
  makeSession,
  makeVisibilityPolicy,
  type AgentInfoModel,
  type EntityModel,
  type L5ManifestModel,
  type SessionModel,
  type VisibilityPolicyModel,
} from "./model.js";

// to_dict + atomic I/O.
export { readL5Dict, toDict, writeL5, writeL5Dict } from "./l5-io.js";

// Schema-faithful wire types (generated). `Visibility` is exported above as the
// runtime const+type, so it is intentionally not re-exported from here.
export type {
  BourdonL5AgentMemoryManifest as L5Manifest,
  Entity,
  Session,
} from "./types.gen.js";
