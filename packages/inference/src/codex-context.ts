/**
 * Generate Codex-oriented L0/L1 timing artifacts from an L5 manifest. Pure
 * transform — faithful port of `core/codex_context.py`. No I/O except
 * {@link writeCodexContextArtifacts}.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stringify as yamlStringify } from "yaml";

type Dict = Record<string, unknown>;

const VISIBILITY_RANK: Readonly<Record<string, number>> = { public: 0, team: 1, private: 2 };

function normalizeVisibility(value: unknown): string {
  const normalized = String(value ?? "public")
    .trim()
    .toLowerCase();
  return normalized in VISIBILITY_RANK ? normalized : "public";
}

function visibilityRank(value: unknown): number {
  return VISIBILITY_RANK[normalizeVisibility(value)] ?? 0;
}

function isVisible(item: Dict, accessLevel: string): boolean {
  return visibilityRank(item.visibility) <= visibilityRank(accessLevel);
}

/**
 * Slugify a string: collapse non-alphanumeric runs to `-`, trim leading/trailing
 * `-`, fall back to `entity`, cap at `maxLen`, then re-strip a trailing `-`.
 * Mirrors `_slugify` (ASCII `[^a-zA-Z0-9]+` regex — NOT Unicode-aware).
 */
export function slugify(value: string, maxLen = 80): string {
  let slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  slug = slug || "entity";
  return slug.slice(0, maxLen).replace(/-+$/g, "");
}

function asDictList(value: unknown): Dict[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v));
}

function manifestDict(manifest: unknown): Dict {
  if (manifest !== null && typeof manifest === "object") {
    const m = manifest as { toDict?: () => Dict };
    if (typeof m.toDict === "function") return m.toDict();
    return { ...(manifest as Dict) };
  }
  return {};
}

/** Filter sessions/entities to the requested visibility level. */
export function filterManifestForAccess(manifest: unknown, accessLevel = "team"): Dict {
  const data = manifestDict(manifest);
  const filtered: Dict = { ...data };
  filtered.known_entities = asDictList(data.known_entities).filter((e) => isVisible(e, accessLevel));
  filtered.recent_sessions = asDictList(data.recent_sessions).filter((s) =>
    isVisible(s, accessLevel),
  );
  return filtered;
}

/** Build an orchestrator-compatible L0 hot-cache payload. */
export function buildL0Payload(manifest: unknown, accessLevel = "team"): Dict {
  const data = filterManifestForAccess(manifest, accessLevel);
  const entities = asDictList(data.known_entities);
  const sessions = asDictList(data.recent_sessions);
  const projects = entities.filter((e) => e.type === "project");
  const latestSession: Dict = sessions[0] ?? {};

  const providerCounts = new Map<string, number>();
  for (const session of sessions) {
    const provider = session.model_provider;
    if (typeof provider === "string" && provider) {
      providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
    }
  }
  let dominantProvider = "openai";
  let best = -1;
  for (const [provider, count] of providerCounts) {
    if (count > best) {
      best = count;
      dominantProvider = provider;
    }
  }

  const firstOf = (value: unknown): unknown =>
    Array.isArray(value) && value.length > 0 ? value[0] : null;
  const primaryFocus =
    firstOf(latestSession.key_actions) ?? firstOf(latestSession.project_focus) ?? "Recent Codex work";
  const lastTopic = firstOf(latestSession.key_actions) ?? primaryFocus;

  return {
    identity: { user: "Codex user", alias: "Codex", company: "OpenAI", role: "Collaborator" },
    projects: projects
      .slice(0, 10)
      .map((project, index) => ({ name: project.name, priority: index + 1 })),
    hardware: { local_model: "Codex CLI", inference: titleCase(String(dominantProvider)) },
    current_focus: {
      primary: primaryFocus,
      last_session: latestSession.date ?? "",
      last_topic: lastTopic,
    },
    entities: entities.map((entity) => ({
      keyword: entity.name,
      type: entity.type ?? "topic",
    })),
  };
}

/** Build markdown synopses keyed by slugified entity name. */
export function buildL1Documents(manifest: unknown, accessLevel = "team"): Record<string, string> {
  const data = filterManifestForAccess(manifest, accessLevel);
  const docs: Record<string, string> = {};
  for (const entity of asDictList(data.known_entities)) {
    const slug = slugify(String(entity.name ?? "entity") || "entity");
    const tags = asStringList(entity.tags).join(", ");
    const aliases = asStringList(entity.aliases).join(", ");
    const summary = String(entity.summary ?? "") || "No summary available.";
    const bodyLines = [
      `# ${entity.name}`,
      "",
      `- Type: ${entity.type ?? "topic"}`,
      `- Visibility: ${normalizeVisibility(entity.visibility)}`,
      `- Last touched: ${entity.last_touched ?? "unknown"}`,
    ];
    if (tags) bodyLines.push(`- Tags: ${tags}`);
    if (aliases) bodyLines.push(`- Aliases: ${aliases}`);
    bodyLines.push("", summary.trim());
    docs[slug] = `${bodyLines.join("\n").trim()}\n`;
  }
  return docs;
}

/** Write `l0/hot_cache.yaml` plus `l1/*.md` files to `outDir`. */
export function writeCodexContextArtifacts(
  manifest: unknown,
  outDir: string,
  accessLevel = "team",
): Dict {
  const l0Dir = join(outDir, "l0");
  const l1Dir = join(outDir, "l1");
  mkdirSync(l0Dir, { recursive: true });
  mkdirSync(l1Dir, { recursive: true });

  const l0Payload = buildL0Payload(manifest, accessLevel);
  const l1Docs = buildL1Documents(manifest, accessLevel);

  const l0Path = join(l0Dir, "hot_cache.yaml");
  writeFileSync(l0Path, yamlStringify(l0Payload, { sortMapEntries: false }), "utf8");
  for (const [slug, body] of Object.entries(l1Docs)) {
    writeFileSync(join(l1Dir, `${slug}.md`), body, "utf8");
  }

  return {
    l0_path: l0Path,
    l1_dir: l1Dir,
    l1_count: Object.keys(l1Docs).length,
    l0_generated: true,
    l1_generated: Object.keys(l1Docs).length > 0,
  };
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function titleCase(value: string): string {
  return value.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
