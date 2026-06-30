/**
 * HTTP (streamable-HTTP) transport + Bearer auth — port of the HTTP half of
 * `core/l6_server.py` (`_build_auth_middleware`, `_build_operator_identity_middleware`,
 * the `run_l6_server` http branch, `_is_loopback_host`, `_normalized_legacy_token`).
 *
 * Security invariants preserved IN CODE (a miss here leaks PRIVATE memory or
 * escalates a quarantined caller to OPERATOR across machines):
 *  - Fail CLOSED: with no auth configured and not `--allow-unauthenticated`,
 *    every request gets 503.
 *  - Empty Bearer can NEVER authenticate as OPERATOR — the legacy compare
 *    requires BOTH a configured legacy token AND a non-empty presented token
 *    before the constant-time compare, and `normalizedLegacyToken()` maps a
 *    set-but-empty/whitespace `BOURDON_PEER_TOKEN_SERVER` to null (3-Star P1-1).
 *  - Per-agent `bdn_` tokens resolve via the registry (sha256-at-rest,
 *    constant-time; re-reads on mtime so `bourdon revoke` takes effect live).
 *  - A 401 does NOT distinguish invalid vs revoked and never echoes the token.
 *  - Default bind 127.0.0.1; a NON-LOOPBACK bind REFUSES TO START (throws, the
 *    CLI exits non-zero) with `--allow-unauthenticated` (anonymous = loopback
 *    only) OR with no auth configured.
 *  - On success the identity is bound for the request subtree via
 *    AsyncLocalStorage (`runWithCaller`), so the tool handlers observe the
 *    authenticated caller deterministically; an HTTP request that bypassed this
 *    middleware would resolve to OPERATOR only under stdio, never here.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  type AgentIdentity,
  FederationRegistry,
  OPERATOR,
  runWithCaller,
} from "@getbourdon/federation";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const DEFAULT_PORT = 7500;
export const DEFAULT_HOST = "127.0.0.1";

/**
 * The legacy shared peer token, with empty/whitespace normalized to null. A
 * set-but-empty `BOURDON_PEER_TOKEN_SERVER` (a routine .env slip) is treated as
 * "no token" everywhere — both the startup gate and per-request auth (P1-1).
 */
export function normalizedLegacyToken(): string | null {
  const value = process.env.BOURDON_PEER_TOKEN_SERVER;
  if (value !== undefined && value.trim() === "") return null;
  return value ?? null;
}

/** Constant-time string compare (mirrors Python `hmac.compare_digest`): false,
 * not throw, on a length mismatch; no early exit on equal length. */
function constantTimeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Whether a bind host is loopback-only. */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  // IPv4 loopback 127.0.0.0/8.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // IPv6 loopback ::1 (with optional brackets).
  const stripped = host.replace(/^\[/, "").replace(/\]$/, "");
  if (stripped === "::1" || stripped === "0:0:0:0:0:0:0:1") return true;
  return false;
}

export type AuthResult =
  | { kind: "unconfigured" } // 503
  | { kind: "unauthorized"; message: string } // 401
  | { kind: "ok"; identity: AgentIdentity };

/**
 * Resolve an `Authorization` header to an identity, reproducing the
 * `_BearerAuth.dispatch` decision exactly.
 */
export function authenticateBearer(
  registry: FederationRegistry,
  legacy: string | null,
  authHeader: string | null | undefined,
): AuthResult {
  if (legacy === null && !registry.isConfigured()) {
    return { kind: "unconfigured" };
  }
  const header = authHeader ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return { kind: "unauthorized", message: "missing Bearer token" };
  }
  // header.split(" ", 1)[1].strip() — everything after the first space, trimmed.
  const token = header.slice(header.indexOf(" ") + 1).trim();
  let identity: AgentIdentity | null = null;
  // Require BOTH a configured legacy token and a non-empty presented token
  // before the constant-time compare, so an empty Bearer can never match.
  if (legacy && token && constantTimeStringEqual(token, legacy)) {
    identity = OPERATOR;
  }
  if (identity === null) {
    identity = registry.authenticate(token);
  }
  if (identity === null) {
    // Deliberately does not distinguish invalid vs revoked; never echoes the token.
    return { kind: "unauthorized", message: "invalid or revoked Bearer token" };
  }
  return { kind: "ok", identity };
}

/** Error thrown when a non-loopback bind is refused. The CLI catches it and
 * exits non-zero (mirrors Python's `raise SystemExit`). */
export class BindRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindRefusedError";
  }
}

export interface RunHttpServerOptions {
  port?: number;
  host?: string;
  allowUnauthenticated?: boolean;
  registry?: FederationRegistry;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/**
 * Serve the L6 MCP server over STATELESS streamable-HTTP, always via our own
 * `node:http` server so the bind host is ours. Each request runs in its own
 * task with a fresh transport, so the bound caller identity deterministically
 * reaches the tool handlers.
 *
 * `createServer` is a factory so each request gets a fresh `McpServer`/transport
 * pair (stateless = no cross-request session state). Returns the listening
 * `http.Server`.
 *
 * v0.9.0 bind/auth contract: default bind 127.0.0.1; a non-loopback bind with
 * `--allow-unauthenticated` (anonymous is loopback-only) OR with no auth
 * configured throws `BindRefusedError` BEFORE listening (never serves-then-503).
 */
export function runHttpServer(
  createServer: () => McpServer,
  options: RunHttpServerOptions = {},
): import("node:http").Server {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const allowUnauthenticated = options.allowUnauthenticated ?? false;
  const registry = options.registry ?? new FederationRegistry();
  const legacy = normalizedLegacyToken();
  const authConfigured = legacy !== null || registry.hasActiveAgents();

  if (!isLoopbackHost(host)) {
    if (allowUnauthenticated) {
      throw new BindRefusedError(
        `refusing to start: --allow-unauthenticated with non-loopback bind '${host}'. ` +
          "Anonymous access is loopback-only; register an agent token " +
          "(`bourdon agent add <id>`) or set BOURDON_PEER_TOKEN_SERVER to serve on this interface.",
      );
    }
    if (!authConfigured) {
      throw new BindRefusedError(
        `refusing to start: bind '${host}' is network-reachable but no auth is configured. ` +
          "Register an agent token (`bourdon agent add <id>`) or set " +
          "BOURDON_PEER_TOKEN_SERVER, or bind 127.0.0.1.",
      );
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Resolve the caller identity for this request.
    let identity: AgentIdentity;
    if (allowUnauthenticated) {
      // Loopback-only operator-identity binding (matches stdio behavior).
      identity = OPERATOR;
    } else {
      const auth = authenticateBearer(registry, legacy, req.headers.authorization ?? null);
      if (auth.kind === "unconfigured") {
        sendJson(res, 503, {
          error:
            "Server has no auth configured (no registered agents via `bourdon agent add` " +
            "and no BOURDON_PEER_TOKEN_SERVER) and was launched without --allow-unauthenticated.",
        });
        return;
      }
      if (auth.kind === "unauthorized") {
        sendJson(res, 401, { error: auth.message });
        return;
      }
      identity = auth.identity;
    }

    const body = await readBody(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer();
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // Bind identity for the whole request subtree so the tool handlers see the
    // authenticated caller (AsyncLocalStorage = the contextvar analogue).
    await runWithCaller(identity, () => transport.handleRequest(req, res, body));
  };

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((exc) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(exc) });
    });
  });
  httpServer.listen(port, host);
  return httpServer;
}
