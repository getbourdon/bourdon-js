/**
 * Federation leak auditor — static scan of published L5 manifests for leaks.
 *
 * Port of `core/leak_audit.py`. Visibility is enforced *inside each participant*
 * before emission; L6 trusts the manifest it receives. This module is the
 * library-wide backstop: a static auditor that walks every `*.l5.yaml` already
 * on disk (and every string in a single manifest tree) and flags two leak
 * classes:
 *
 *   1. CREDENTIAL — a field value that matches the canonical
 *      {@link containsSecret} patterns. Means a participant emitted raw text
 *      that should have been redacted.
 *   2. VISIBILITY — an entity or session whose resolved visibility is `private`
 *      but which is sitting in a federated manifest anyway.
 *
 * Read-only and side-effect-free: it reports, it never edits a manifest, and it
 * NEVER throws on a bad manifest. An unparseable file is itself a reported
 * finding, not a silent skip.
 *
 * Credential detection reuses {@link containsSecret} (the single source of
 * truth) and scans *every* federated string rather than a curated key list, so
 * it cannot silently forget a field as the schema grows.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as yamlParse } from "yaml";

import { containsSecret } from "./redaction.js";

export const AUDIT_SCHEMA_VERSION = "federation-leak-audit/v1";

export enum LeakKind {
  CREDENTIAL = "credential",
  VISIBILITY = "visibility",
}

/**
 * Tags that force an entity/session to PRIVATE regardless of declared
 * visibility. Mirrors the private-tag families participants apply, so the
 * auditor's notion of "should have been private" matches the emitters'.
 */
export const PRIVATE_TAG_FAMILIES: ReadonlySet<string> = new Set([
  "personal",
  "financial",
  "credential",
  "secret",
  "health",
  "family",
  "legal",
  "private",
]);

/**
 * Top-level manifest keys NOT walked for credential shapes. `visibility_policy`
 * legitimately enumerates private-tag *family names* (e.g. "credential",
 * "secret") and a custom policy could name a tag like "password" — those are
 * policy declarations, not federated content, so scanning them would be a false
 * positive. Everything else is fair game.
 */
const CREDENTIAL_SCAN_SKIP_KEYS: ReadonlySet<string> = new Set(["visibility_policy"]);

export interface Finding {
  kind: LeakKind;
  agentFile: string;
  /** json-path of the offending string, e.g. "known_entities[0].summary". */
  location: string;
  detail: string;
}

export function findingToDict(f: Finding): {
  kind: string;
  agent_file: string;
  location: string;
  detail: string;
} {
  return {
    kind: f.kind,
    agent_file: f.agentFile,
    location: f.location,
    detail: f.detail,
  };
}

export class AuditReport {
  constructor(
    readonly schemaVersion: string,
    readonly filesScanned: number,
    readonly findings: Finding[] = [],
  ) {}

  get clean(): boolean {
    return this.findings.length === 0;
  }

  byKind(kind: LeakKind): Finding[] {
    return this.findings.filter((f) => f.kind === kind);
  }

  toDict(): {
    schema_version: string;
    files_scanned: number;
    n_findings: number;
    n_credential: number;
    n_visibility: number;
    findings: ReturnType<typeof findingToDict>[];
  } {
    return {
      schema_version: this.schemaVersion,
      files_scanned: this.filesScanned,
      n_findings: this.findings.length,
      n_credential: this.byKind(LeakKind.CREDENTIAL).length,
      n_visibility: this.byKind(LeakKind.VISIBILITY).length,
      findings: this.findings.map(findingToDict),
    };
  }
}

// -- helpers -----------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// -- Visibility resolution (mirrors participant tag rules) -------------------

/**
 * True if a tag forces this entity/session to private, OR it self-declares
 * `visibility: "private"`. This is the condition under which it must NOT be in a
 * federated manifest. `privateTags` is the effective private-tag set (the
 * hardcoded families unioned with the manifest's own declared `private_tags`).
 * A non-object `thing` resolves to `false`.
 */
function resolvesPrivate(thing: unknown, privateTags: ReadonlySet<string>): boolean {
  if (!isPlainObject(thing)) {
    return false;
  }
  const tags = thing.tags;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (privateTags.has(String(t).toLowerCase())) {
        return true;
      }
    }
  }
  return String(thing.visibility || "").toLowerCase() === "private";
}

/**
 * The hardcoded private-tag families UNION the manifest's own declared
 * `visibility_policy.private_tags`. The backstop must not assume every emitter
 * uses the same tag vocabulary: a participant that declares a custom private
 * tag would otherwise sail past a hardcoded set.
 */
function effectivePrivateTags(manifest: Record<string, unknown>): Set<string> {
  const result = new Set(PRIVATE_TAG_FAMILIES);
  const policy = manifest.visibility_policy;
  if (isPlainObject(policy)) {
    const raw = policy.private_tags;
    if (Array.isArray(raw)) {
      for (const t of raw) {
        result.add(String(t).toLowerCase());
      }
    }
  }
  return result;
}

// -- Credential scanning -----------------------------------------------------

/**
 * Yield `[json-path, text]` for EVERY string anywhere in `obj`. A security
 * backstop must not be able to *forget* a field, so this walks the whole tree:
 *  - dict child path = `path ? `${path}.${key}` : key` (root key bare, no dot);
 *  - list child path = `${path}[${i}]`;
 *  - a bare string at the root yields location `<root>`.
 */
function* iterAllStrings(obj: unknown, path = ""): Generator<[string, string]> {
  if (typeof obj === "string") {
    yield [path || "<root>", obj];
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      yield* iterAllStrings(obj[i], `${path}[${i}]`);
    }
  } else if (isPlainObject(obj)) {
    for (const [key, val] of Object.entries(obj)) {
      const child = path ? `${path}.${key}` : String(key);
      yield* iterAllStrings(val, child);
    }
  }
}

function scanCredentials(
  manifest: Record<string, unknown>,
  agentFile: string,
  findings: Finding[],
): void {
  const scannable: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (!CREDENTIAL_SCAN_SKIP_KEYS.has(k)) {
      scannable[k] = v;
    }
  }
  for (const [location, text] of iterAllStrings(scannable)) {
    if (containsSecret(text)) {
      findings.push({
        kind: LeakKind.CREDENTIAL,
        agentFile,
        location,
        detail: "value matches a credential pattern (should have been redacted)",
      });
    }
  }
}

function scanVisibility(
  agentFile: string,
  collection: unknown,
  collectionName: string,
  privateTags: ReadonlySet<string>,
  findings: Finding[],
): void {
  if (!Array.isArray(collection)) {
    return;
  }
  for (let idx = 0; idx < collection.length; idx++) {
    const thing = collection[idx];
    if (!isPlainObject(thing)) {
      continue;
    }
    if (resolvesPrivate(thing, privateTags)) {
      const ident = thing.name || thing.date || "?";
      const singular = collectionName === "known_entities" ? "entity" : "session";
      findings.push({
        kind: LeakKind.VISIBILITY,
        agentFile,
        location: `${collectionName}[${idx}]`,
        detail: `${singular} ${JSON.stringify(ident)} resolves to PRIVATE but is present in a federated manifest`,
      });
    }
  }
}

/**
 * Scan a single parsed L5 manifest for both leak classes. NEVER raises.
 *
 * Emission order is contract: visibility(known_entities) → visibility(
 * recent_sessions) → credentials(whole tree). A non-dict manifest, or malformed
 * collections, yield `[]`.
 */
export function auditManifest(manifest: unknown, agentFile: string): Finding[] {
  const findings: Finding[] = [];
  if (!isPlainObject(manifest)) {
    return findings;
  }
  const privateTags = effectivePrivateTags(manifest);
  scanVisibility(agentFile, manifest.known_entities, "known_entities", privateTags, findings);
  scanVisibility(agentFile, manifest.recent_sessions, "recent_sessions", privateTags, findings);
  scanCredentials(manifest, agentFile, findings);
  return findings;
}

/**
 * Walk every `*.l5.yaml` under `libraryPath/agents` and audit each. A file that
 * fails to parse is itself reported as a credential-kind finding with detail
 * `unparseable manifest: ...` rather than silently skipped. A missing directory
 * yields an empty report (`filesScanned = 0`).
 *
 * This filesystem/YAML walk is the Node analogue of `audit_library`; the
 * unparseable-error text is implementation-specific and is intentionally NOT
 * part of the cross-impl parity fixture.
 */
export function auditLibrary(
  libraryPath: string,
  opts: { agentsSubdir?: string } = {},
): AuditReport {
  const agentsSubdir = opts.agentsSubdir ?? "agents";
  const agentsDir = join(libraryPath, agentsSubdir);
  const findings: Finding[] = [];

  let files: string[];
  try {
    files = readdirSync(agentsDir)
      .filter((name) => name.endsWith(".l5.yaml"))
      .sort()
      .map((name) => join(agentsDir, name));
  } catch {
    files = [];
  }

  for (const path of files) {
    let data: unknown;
    try {
      data = yamlParse(readFileSync(path, "utf8"));
    } catch (exc) {
      findings.push({
        kind: LeakKind.CREDENTIAL,
        agentFile: path,
        location: "<file>",
        detail: `unparseable manifest: ${String(exc)}`,
      });
      continue;
    }
    findings.push(...auditManifest(data, path));
  }

  return new AuditReport(AUDIT_SCHEMA_VERSION, files.length, findings);
}
