/**
 * GitHub-embedded Copilot participant — the v0.3 network-adapter reference.
 * Port of `participants/github_copilot.py`.
 *
 * Cloud-side Copilot (PR review, `@copilot` comments) persists nothing on the
 * user's machine — its state lives on github.com. This adapter federates it by
 * reading the user's GitHub activity over the REST API. The
 * {@link NetworkParticipant} base provides the cache, degradation, and auth
 * boundary; this class provides only the GitHub-specific fetch + payload→L5.
 *
 * Auth: a token with `repo` + `read:user` scope, sourced from `$GITHUB_TOKEN` /
 * `$GH_TOKEN`, else `gh auth token`. Fetched lazily; never stored in the cache
 * or the manifest.
 */

import { execFileSync } from "node:child_process";

import {
  Visibility,
  makeAgentInfo,
  makeEntity,
  makeManifest,
  makeSession,
  makeVisibilityPolicy,
  type EntityModel,
  type L5ManifestModel,
  type SessionModel,
  type VisibilityPolicyModel,
} from "@getbourdon/l5";
import { redactText } from "@getbourdon/redaction";

import { SPEC_VERSION } from "../base.js";
import {
  NetworkParticipant,
  NetworkUnavailable,
  ParticipantAuthError,
  type AuthProvider,
  type NetworkParticipantOptions,
} from "../network-base.js";

const AGENT_ID = "github-copilot";
const AGENT_TYPE = "code-assistant";
const PARTICIPANT_SLUG = "github-copilot";
const DISPLAY_NAME = "GitHub Copilot (cloud)";
const ROLE_NARRATIVE =
  "Cloud-side GitHub Copilot: PR review and @copilot-authored comments/" +
  "suggestions that live on github.com, not on the user's machine. Federated " +
  "via the GitHub REST API rather than a local artifact.";

const GITHUB_API_ROOT = "https://api.github.com";

const DEFAULT_POLICY: VisibilityPolicyModel = makeVisibilityPolicy({
  default: Visibility.TEAM,
  private_tags: ["personal", "financial", "credential", "secret"],
  team_tags: ["github-copilot", "pull-request"],
});

// -- Auth resolution ----------------------------------------------------------

/** Resolve a GitHub token: env var first, then the `gh` CLI keychain. */
export function ghTokenProvider(): string | null {
  for (const varName of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const val = process.env[varName];
    if (val) return val;
  }
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const token = out.trim();
    if (token) return token;
  } catch {
    /* gh missing / not logged in */
  }
  return null;
}

// -- HTTP ---------------------------------------------------------------------

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Synchronous GET via a tiny `curl` shell-out (the base class's fetch contract
 * is synchronous, matching the Python urllib reference). Returns parsed JSON.
 * Classifies failures into the two contract errors: rate-limit / 5xx /
 * transport / non-JSON → {@link NetworkUnavailable}; 401/403 →
 * {@link ParticipantAuthError}. Never raises anything else.
 */
function githubGet(path: string, token: string, timeoutSec = 10): unknown {
  const url = path.startsWith("http") ? path : `${GITHUB_API_ROOT}${path}`;
  let resp: HttpResponse;
  try {
    resp = curlGet(url, token, timeoutSec);
  } catch (err) {
    throw new NetworkUnavailable(`GitHub API unreachable: ${String(err)}`);
  }

  const remaining = resp.headers["x-ratelimit-remaining"];
  if (resp.status === 429 || (resp.status === 403 && String(remaining) === "0")) {
    throw new NetworkUnavailable(`GitHub API ${resp.status}: rate-limited`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new ParticipantAuthError(`GitHub API ${resp.status}: token invalid or lacks scope`);
  }
  if (resp.status >= 500) {
    throw new NetworkUnavailable(`GitHub API ${resp.status}`);
  }
  if (resp.status >= 400) {
    throw new NetworkUnavailable(`GitHub API ${resp.status}`);
  }
  try {
    return JSON.parse(resp.body);
  } catch (err) {
    // A 200 with a non-JSON body (captive portal / proxy splash) is a degraded
    // condition, not a hard crash.
    throw new NetworkUnavailable(`GitHub API returned a non-JSON body: ${String(err)}`);
  }
}

function curlGet(url: string, token: string, timeoutSec: number): HttpResponse {
  // `-sS` quiet but show errors; `-D -` dumps headers to stdout before the body;
  // `-w` appends the status code on its own trailing line for parsing.
  const raw = execFileSync(
    "curl",
    [
      "-sS",
      "-D",
      "-",
      "-o",
      "-",
      "--max-time",
      String(timeoutSec),
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      "-H",
      "User-Agent: bourdon-github-copilot-participant",
      "-w",
      "\n__BOURDON_STATUS__%{http_code}",
      url,
    ],
    { encoding: "utf8", timeout: (timeoutSec + 2) * 1000, maxBuffer: 8 * 1024 * 1024 },
  );

  const statusMatch = /\n__BOURDON_STATUS__(\d+)$/.exec(raw);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const withoutStatus = statusMatch ? raw.slice(0, statusMatch.index) : raw;

  // Split header block from body (last header section before body).
  const headerBodySplit = withoutStatus.indexOf("\r\n\r\n");
  let headerBlock = "";
  let body = withoutStatus;
  if (headerBodySplit >= 0) {
    headerBlock = withoutStatus.slice(0, headerBodySplit);
    body = withoutStatus.slice(headerBodySplit + 4);
  } else {
    const lfSplit = withoutStatus.indexOf("\n\n");
    if (lfSplit >= 0) {
      headerBlock = withoutStatus.slice(0, lfSplit);
      body = withoutStatus.slice(lfSplit + 2);
    }
  }

  const headers: Record<string, string> = {};
  for (const line of headerBlock.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return { status, headers, body };
}

// -- Participant --------------------------------------------------------------

/** Federates cloud-side GitHub Copilot activity via the GitHub REST API. */
export class GitHubCopilotParticipant extends NetworkParticipant {
  override participantSlug = PARTICIPANT_SLUG;
  override agentId = AGENT_ID;
  override agentType = AGENT_TYPE;
  override nativePath = GITHUB_API_ROOT;
  displayName = DISPLAY_NAME;

  private readonly maxResults: number;

  constructor(opts: NetworkParticipantOptions & { maxResults?: number } = {}) {
    super({
      authProvider: opts.authProvider ?? ghTokenProvider,
      cacheRoot: opts.cacheRoot,
    });
    this.maxResults = opts.maxResults ?? 50;
  }

  static defaultNativePath(): string {
    return GITHUB_API_ROOT;
  }

  override fetchPayload(token: string): Record<string, unknown> {
    // Identify the authenticated user (also validates the token early).
    const me = githubGet("/user", token);
    const login = me && typeof me === "object" ? (me as Record<string, unknown>)["login"] : null;

    // PRs that involve the user where Copilot is a commenter/reviewer.
    const q = "is:pr involves:@me commenter:copilot";
    const encoded = encodeURIComponent(q);
    const search = githubGet(
      `/search/issues?q=${encoded}&sort=updated&per_page=${this.maxResults}`,
      token,
    );
    const items =
      search && typeof search === "object"
        ? ((search as Record<string, unknown>)["items"] ?? [])
        : [];

    return {
      fetched_user: login ?? null,
      fetched_at: new Date().toISOString(),
      items,
    };
  }

  override payloadToL5(payload: Record<string, unknown>): L5ManifestModel {
    const items = Array.isArray(payload["items"]) ? (payload["items"] as unknown[]) : [];
    const sessions: SessionModel[] = [];
    const entities = new Map<string, EntityModel>();

    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      const repo = repoFromItem(it);
      const title = redactText(String(it["title"] ?? ""), 160);
      const number = it["number"];
      const updated = isoDate(it["updated_at"]);
      const focus = repo ? [repo] : [];

      sessions.push(
        makeSession({
          date: updated || "1970-01-01",
          cwd: repo ? `github.com/${repo}` : undefined,
          project_focus: focus,
          key_actions: number != null ? [`PR #${String(number)}: ${title}`] : [title],
          visibility: Visibility.TEAM,
        }),
      );

      if (repo && !entities.has(repo)) {
        entities.set(
          repo,
          makeEntity({
            name: repo,
            type: "repository",
            summary: "GitHub repo with Copilot PR activity.",
            aliases: repo.includes("/") ? [repo.split("/").pop() ?? ""] : [],
            last_touched: updated ?? undefined,
            tags: ["github-copilot", "pull-request"],
            visibility: Visibility.TEAM,
          }),
        );
      }
    }

    // Keep sessions newest-first, bounded.
    sessions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    return makeManifest({
      spec_version: SPEC_VERSION,
      agent: makeAgentInfo({
        id: this.agentId,
        type: this.agentType,
        role_narrative: ROLE_NARRATIVE,
        instance: (payload["fetched_user"] as string | null | undefined) ?? undefined,
      }),
      last_updated: new Date().toISOString(),
      capabilities: ["github-search", "pull-request-comments"],
      recent_sessions: sessions.slice(0, this.maxResults),
      known_entities: [...entities.values()],
      visibility_policy: DEFAULT_POLICY,
    });
  }
}

// -- Helpers ------------------------------------------------------------------

function repoFromItem(item: Record<string, unknown>): string | null {
  const repoUrl = item["repository_url"];
  if (typeof repoUrl === "string" && repoUrl.includes("/repos/")) {
    return repoUrl.split("/repos/")[1] ?? null;
  }
  return null;
}

function isoDate(value: unknown): string | null {
  if (typeof value === "string" && value.length >= 10) return value.slice(0, 10);
  return null;
}

// Re-export the provider type for adapters/tests that inject auth.
export type { AuthProvider };
