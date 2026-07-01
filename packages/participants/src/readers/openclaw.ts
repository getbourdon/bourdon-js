/**
 * OpenClaw participant — network-shaped, QUARANTINED-CLASS. Port of
 * `participants/openclaw.py` (v0.9.0, spec R4/D9).
 *
 * OpenClaw is the highest-demand adapter target in the ecosystem and also its
 * highest-risk agent class: CVE-2026-25253 (one-click RCE, CVSS 8.8, first
 * patched in 2026.1.29), tens of thousands of internet-exposed instances (~93%
 * without authentication), ClawHub's malicious-skill problem, and auth disabled
 * by default on port 8080. Bourdon therefore treats OpenClaw differently from
 * every on-disk participant:
 *
 *   1. **Network-shaped** — state is read from the OpenClaw instance's local
 *      HTTP API, not on-disk artifacts. Because the {@link BourdonParticipant}
 *      contract is SYNCHRONOUS (`discover`/`exportL5` return values, not
 *      Promises) and `fetch` is async, the reads go through a tiny synchronous
 *      `curl` shell-out (the same idiom as the github-copilot reader).
 *   2. **Hard handshake gate** — {@link OpenClawParticipant.discover} refuses to
 *      talk to an instance that is unpatched (< 2026.1.29) or has authentication
 *      disabled. These are refusals with exact reasons AND fixes, not warnings,
 *      and every read re-runs the gate.
 *   3. **Quarantined-class** — `quarantinedClass = true`: registering the agent
 *      trusted requires `--i-understand-the-risk`, and exports stage for
 *      operator review (spec D6: quarantine follows the content, not the
 *      invoker). Its content federates under TEAM, never PUBLIC.
 *
 * We gate on instance hygiene (version, auth) — NOT on auditing the user's
 * installed skills; that's ClawSecure et al.'s job (spec non-goal 3).
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  Visibility,
  filterForFederation,
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

import {
  ParticipantDiscoveryError,
  SPEC_VERSION,
  type AgentStore,
  type BourdonParticipant,
  type HealthStatus,
} from "../base.js";

// -- Constants -----------------------------------------------------------------

const AGENT_ID = "openclaw";
const AGENT_TYPE = "other";
const DISPLAY_NAME = "OpenClaw (quarantined)";
const ROLE_NARRATIVE =
  "OpenClaw personal AI assistant — federated as a QUARANTINED member: " +
  "its reads are limited to granted namespaces and its writes are staged " +
  "for operator review.";

/** First OpenClaw release that patches CVE-2026-25253 (one-click RCE). */
export const MIN_PATCHED_VERSION = "2026.1.29";

const DEFAULT_OPENCLAW_URL = "http://127.0.0.1:8080";

const SESSION_LIMIT = 50;
const ENTITY_LIMIT = 100;

// -- Helpers -------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `_safe_native_memory_text(v)` in Python == `redact_text(v, limit=180)`. The
 * TS redaction SSOT exposes `redactText(value, limit = 180)` (positional), so
 * we pass the cap explicitly to make the surface's 180-char limit load-bearing.
 */
function safeNativeMemoryText(value: string): string {
  return redactText(value, 180);
}

/**
 * `"2026.1.29"` -> `[2026, 1, 29]`. Tolerates suffixes like `"2026.1.29-beta"`;
 * returns null when nothing numeric parses. Faithful port of `_parse_version`.
 */
function parseVersion(value: string): number[] | null {
  const parts: number[] = [];
  for (const chunk of String(value ?? "").trim().split(".")) {
    const match = /^(\d+)/.exec(chunk);
    if (!match) break;
    parts.push(Number(match[1]));
  }
  return parts.length > 0 ? parts : null;
}

/** Tuple comparison mirroring Python's `tuple < tuple` (lexicographic, shorter
 * is smaller when it is a prefix). */
function versionLessThan(a: number[], b: number[]): boolean {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = i < a.length ? (a[i] as number) : undefined;
    const bv = i < b.length ? (b[i] as number) : undefined;
    if (av === undefined) return true; // a is a shorter prefix of b
    if (bv === undefined) return false; // b is a shorter prefix of a
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}

/** `_status_version`: first non-empty of version / openclaw_version / app_version. */
function statusVersion(status: Record<string, unknown>): string {
  for (const key of ["version", "openclaw_version", "app_version"]) {
    const value = status[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** `_status_auth_enabled`: auth_enabled / authEnabled / auth.enabled. */
function statusAuthEnabled(status: Record<string, unknown>): boolean {
  for (const key of ["auth_enabled", "authEnabled"]) {
    if (key in status) return Boolean(status[key]);
  }
  const auth = status["auth"];
  if (isRecord(auth)) return Boolean(auth["enabled"]);
  return false;
}

/**
 * Hard handshake preconditions (spec D9). Returns the version on success.
 * Raises {@link ParticipantDiscoveryError} with the exact reason AND the fix —
 * these are refusals, not warnings.
 */
export function verifyInstance(status: Record<string, unknown>, url: string): string {
  const version = statusVersion(status);
  const parsed = parseVersion(version);
  const minimum = parseVersion(MIN_PATCHED_VERSION) as number[];
  if (parsed === null) {
    throw new ParticipantDiscoveryError(
      `OpenClaw at ${url} did not report a parseable version ` +
        `(got ${JSON.stringify(version)}). Refusing handshake: cannot verify the ` +
        `CVE-2026-25253 patch level. Fix: upgrade OpenClaw to ` +
        `>= ${MIN_PATCHED_VERSION} and ensure /api/status reports it.`,
    );
  }
  if (versionLessThan(parsed, minimum)) {
    throw new ParticipantDiscoveryError(
      `OpenClaw at ${url} runs ${version}, which predates the ` +
        `CVE-2026-25253 patch (one-click RCE, CVSS 8.8). Refusing ` +
        `handshake. Fix: upgrade OpenClaw to >= ${MIN_PATCHED_VERSION}.`,
    );
  }
  if (!statusAuthEnabled(status)) {
    throw new ParticipantDiscoveryError(
      `OpenClaw at ${url} has authentication DISABLED (the exposed-` +
        "instance default). Refusing handshake. Fix: enable auth in " +
        "your OpenClaw config (set auth.enabled=true / OPENCLAW_AUTH=1), " +
        "restart the instance, and set OPENCLAW_TOKEN for Bourdon.",
    );
  }
  return version;
}

/**
 * Mirror `_before`: return true when `dateText` is strictly before `since`.
 * Reproduces `datetime.fromisoformat(dateText.replace("Z","+00:00"))` with the
 * naive→UTC coercion, and returns false on a parse (ValueError) miss so the
 * caller keeps the session.
 */
function before(dateText: string, since: Date): boolean {
  const parsed = fromIsoformatUtc(dateText.replace(/Z/g, "+00:00"));
  if (parsed === null) return false; // ValueError -> keep
  return parsed.getTime() < since.getTime();
}

/**
 * A best-effort `datetime.fromisoformat` for the two shapes OpenClaw emits
 * (date-only and datetime, with or without an offset). A naive value (no
 * offset) is interpreted as UTC — matching the Python `parsed.replace(
 * tzinfo=timezone.utc)`. Returns null on an unparseable value.
 */
function fromIsoformatUtc(text: string): Date | null {
  const value = text.trim();
  if (!value) return null;
  const hasOffset = /[+-]\d{2}:?\d{2}$/.test(value);
  // date-only ISO is already interpreted as UTC midnight by Date.parse;
  // a naive datetime ("...T..") must be pinned to UTC with a trailing Z.
  const normalized = hasOffset || !value.includes("T") ? value : `${value}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Python `str(now_utc, "%Y-%m-%dT%H:%M:%SZ")` — second precision, Z suffix. */
function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// -- HTTP ----------------------------------------------------------------------

interface CurlResponse {
  status: number;
  body: string;
}

/**
 * Synchronous GET via a tiny `curl` shell-out — the base contract is
 * synchronous (matching the Python `urllib` reference), so `fetch` cannot be
 * used. `-w` appends the HTTP status on a trailing sentinel line for parsing.
 * Throws when curl itself fails (connection refused / timeout / DNS), which the
 * caller maps to "instance unreachable".
 */
function curlGet(url: string, token: string | undefined, timeoutSec: number): CurlResponse {
  const args = ["-sS", "-o", "-", "--max-time", String(timeoutSec)];
  if (token) {
    args.push("-H", `Authorization: Bearer ${token}`);
  }
  args.push("-w", "\n__BOURDON_STATUS__%{http_code}", url);

  const raw = execFileSync("curl", args, {
    encoding: "utf8",
    timeout: (timeoutSec + 2) * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });

  const statusMatch = /\n__BOURDON_STATUS__(\d+)$/.exec(raw);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const body = statusMatch ? raw.slice(0, statusMatch.index) : raw;
  return { status, body };
}

/**
 * Minimal HTTP client for a local OpenClaw instance. Read-only: status,
 * sessions, memories. Failures raise {@link ParticipantDiscoveryError} with the
 * reason — the participant decides how to surface them.
 *
 * Error mapping (faithful to the Python `urllib` client): an HTTP >= 400
 * response -> "returned HTTP {code}"; a transport failure / timeout / non-JSON
 * body -> "instance unreachable at {url}".
 */
export class OpenClawApiClient {
  readonly url: string;
  private readonly token: string | undefined;
  readonly timeout: number;

  constructor(url: string, token?: string, timeout = 5.0) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.timeout = timeout;
  }

  private get(path: string): unknown {
    let resp: CurlResponse;
    try {
      resp = curlGet(this.url + path, this.token, this.timeout);
    } catch (err) {
      throw new ParticipantDiscoveryError(
        `OpenClaw instance unreachable at ${this.url} (${String(err)})`,
      );
    }
    if (resp.status >= 400) {
      throw new ParticipantDiscoveryError(
        `OpenClaw API ${path} returned HTTP ${resp.status}`,
      );
    }
    if (resp.status === 0) {
      throw new ParticipantDiscoveryError(
        `OpenClaw instance unreachable at ${this.url} (no HTTP response)`,
      );
    }
    try {
      return JSON.parse(resp.body);
    } catch (err) {
      throw new ParticipantDiscoveryError(
        `OpenClaw instance unreachable at ${this.url} (${String(err)})`,
      );
    }
  }

  status(): Record<string, unknown> {
    const data = this.get("/api/status");
    return isRecord(data) ? data : {};
  }

  sessions(): Record<string, unknown>[] {
    return this.readCollection("/api/sessions", "sessions");
  }

  memories(): Record<string, unknown>[] {
    return this.readCollection("/api/memories", "memories");
  }

  /** Shared `sessions()`/`memories()` body: try/except-returns-[], unwrap the
   * `{ "<key>": [...] }` envelope, and keep only object rows. */
  private readCollection(path: string, key: string): Record<string, unknown>[] {
    let data: unknown;
    try {
      data = this.get(path);
    } catch (err) {
      if (err instanceof ParticipantDiscoveryError) return [];
      throw err;
    }
    if (isRecord(data)) {
      data = data[key] || [];
    }
    if (!Array.isArray(data)) return [];
    return data.filter(isRecord);
  }
}

// -- Participant ---------------------------------------------------------------

/** Bourdon participant for OpenClaw (quarantined class). */
export class OpenClawParticipant implements BourdonParticipant {
  agentId = AGENT_ID;
  agentType = AGENT_TYPE;
  displayName = DISPLAY_NAME;
  /** Trust marker consumed by `bourdon agent add/set-tier` + export-all:
   * registering as trusted needs --i-understand-the-risk; exports stage. */
  quarantinedClass = true;

  readonly url: string;
  private readonly client: OpenClawApiClient;

  static defaultNativePath(home?: string): string {
    // Network-shaped: shown in the wizard for orientation only. The actual
    // store is the instance API (OPENCLAW_URL).
    return join(home ?? homedir(), ".openclaw");
  }

  constructor(url?: string, token?: string, client?: OpenClawApiClient) {
    this.url = (url || process.env.OPENCLAW_URL || DEFAULT_OPENCLAW_URL).replace(/\/+$/, "");
    this.client = client ?? new OpenClawApiClient(this.url, token ?? process.env.OPENCLAW_TOKEN);
  }

  get nativePath(): string {
    return this.url;
  }

  // -- protocol ----------------------------------------------------------------

  discover(): AgentStore {
    const status = this.client.status();
    const version = verifyInstance(status, this.url);
    return {
      path: this.url,
      version,
      metadata: { auth_enabled: true, transport: "http" },
    };
  }

  exportSessions(since?: Date, limit: number = SESSION_LIMIT): SessionModel[] {
    this.discover(); // handshake gate applies to every read
    const sessions: SessionModel[] = [];
    for (const row of this.client.sessions()) {
      const date = String(row["updated_at"] || row["started_at"] || row["date"] || "").trim();
      if (!date) continue;
      if (since !== undefined && before(date, since)) continue;
      const title = safeNativeMemoryText(String(row["title"] || row["summary"] || ""));
      const projects = Array.isArray(row["projects"]) ? row["projects"].slice(0, 5) : [];
      sessions.push(
        makeSession({
          date,
          cwd: undefined,
          project_focus: projects.map((p) => safeNativeMemoryText(String(p))),
          key_actions: title ? [title] : [],
        }),
      );
      if (sessions.length >= limit) break;
    }
    return sessions;
  }

  exportL5(since?: Date): L5ManifestModel {
    const store = this.discover();
    const entities: EntityModel[] = [];
    for (const row of this.client.memories().slice(0, ENTITY_LIMIT)) {
      const name = safeNativeMemoryText(String(row["name"] || row["title"] || ""));
      if (!name) continue;
      const tags = Array.isArray(row["tags"]) ? row["tags"].slice(0, 8) : [];
      entities.push(
        makeEntity({
          name,
          type: String(row["type"] || "topic"),
          summary: safeNativeMemoryText(String(row["summary"] || "")),
          tags: tags.map((t) => safeNativeMemoryText(String(t))),
        }),
      );
    }
    // Quarantined-class content defaults to TEAM, never PUBLIC: it only
    // federates beyond the local library after an explicit operator promotion
    // AND a team-level read.
    const policy: VisibilityPolicyModel = makeVisibilityPolicy({ default: Visibility.TEAM });
    return makeManifest({
      spec_version: SPEC_VERSION,
      agent: makeAgentInfo({
        id: AGENT_ID,
        type: AGENT_TYPE,
        instance: this.url,
        role_narrative: ROLE_NARRATIVE,
      }),
      last_updated: nowIsoSeconds(),
      capabilities: [`openclaw ${store.version}`],
      recent_sessions: this.exportSessions(since),
      known_entities: filterForFederation(entities, policy),
      visibility_policy: policy,
    });
  }

  healthCheck(): HealthStatus {
    let store: AgentStore;
    try {
      store = this.discover();
    } catch (exc) {
      if (exc instanceof ParticipantDiscoveryError) {
        const reason = exc.message;
        let fix = "see the refusal reason above";
        if (reason.includes("upgrade OpenClaw")) {
          fix = `upgrade the OpenClaw instance to >= ${MIN_PATCHED_VERSION}`;
        } else if (reason.includes("authentication DISABLED")) {
          fix = "enable auth on the OpenClaw instance, then set OPENCLAW_TOKEN";
        } else if (reason.includes("unreachable")) {
          fix =
            "start OpenClaw locally or set OPENCLAW_URL to the instance address";
        }
        return { status: "blocked", reason, proposedFix: fix, details: {} };
      }
      // health_check must never raise.
      return {
        status: "degraded",
        reason: exc instanceof Error ? exc.message : String(exc),
        details: {},
      };
    }
    return {
      status: "ok",
      details: { url: this.url, version: store.version, quarantined: true },
    };
  }
}
