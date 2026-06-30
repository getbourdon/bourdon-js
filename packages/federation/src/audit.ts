/**
 * Bourdon federation audit log — append-only JSONL.
 *
 * Faithful port of `core/federation_audit.py`. Every federation operation (tool
 * call, allow or deny, any transport) is one line in `~/.bourdon/audit.jsonl`
 * (override `BOURDON_AUDIT_PATH`).
 *
 * Invariants preserved IN CODE:
 *  - Append-only. Nothing rewrites or truncates this file.
 *  - NEVER token material — the layer only sees the resolved AgentIdentity's
 *    `agent_id`, never a token.
 *  - An audit-write failure must NEVER break a federation call: the append is
 *    wrapped, a failure logs a warning and continues (forensics, not a gate).
 *  - A revoked agent's history stays queryable (revocation flips a registry
 *    flag, never touches this file).
 *
 * Wire-byte parity: the committed bytes use Python `json.dumps`'s DEFAULT
 * separators (`", "` and `": "`, WITH spaces), key order
 * `ts, agent, op, namespace, decision, [detail]`, `detail` omitted when falsy,
 * and a MICROSECOND-precision `ts` (`...SSSSSSZ`). `serializeEntry` reproduces
 * that exact serialization (JSON.stringify is compact, so we join manually).
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_AUDIT_PATH = join(homedir(), ".bourdon", "audit.jsonl");

export const DECISION_ALLOW = "allow";
export const DECISION_DENY = "deny";

export interface AuditEntry {
  ts: string;
  agent: string;
  op: string;
  namespace: string;
  decision: string;
  detail?: string;
}

/**
 * Microsecond-precision UTC timestamp, trailing Z, matching Python's
 * `strftime("%Y-%m-%dT%H:%M:%S.%fZ")`. JS clocks are millisecond-resolution, so
 * the low 3 digits are zero-padded — exactly what the on-disk fixture freezes.
 */
export function auditTimestamp(now: Date = new Date()): string {
  // toISOString() -> "2026-06-29T12:00:00.123Z"; pad ms -> µs.
  return now.toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
}

/**
 * Serialize one entry to a single JSON line byte-identical to Python's
 * `json.dumps(entry, ensure_ascii=False)` (default `", "` / `": "` separators).
 * Key order is the insertion order of `entry`.
 */
export function serializeEntry(entry: AuditEntry): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(entry)) {
    parts.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  }
  return `{${parts.join(", ")}}`;
}

export class FederationAudit {
  readonly path: string;

  constructor(path?: string) {
    if (path === undefined) {
      const env = process.env.BOURDON_AUDIT_PATH;
      path = env ? env : DEFAULT_AUDIT_PATH;
    }
    this.path = path;
  }

  /** Append one audit record. Never throws — a write failure logs + continues. */
  record(
    agent: string,
    op: string,
    namespace = "*",
    decision: string = DECISION_ALLOW,
    detail: string | null = null,
  ): void {
    // Build the entry preserving key order. `detail` omitted when falsy.
    const entry: AuditEntry = {
      ts: auditTimestamp(),
      agent,
      op,
      namespace,
      decision,
    };
    if (detail) entry.detail = detail;
    const line = serializeEntry(entry);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, line + "\n", "utf8");
    } catch (exc) {
      // Audit must never break a call.
      console.warn(`audit write failed (${this.path}): ${String(exc)}`);
    }
  }

  /** Most-recent-LAST list of entries matching the filters. */
  entries(
    agent: string | null = null,
    denialsOnly = false,
    limit: number | null = null,
  ): AuditEntry[] {
    let rows = [...this._iterEntries()].filter(
      (e) =>
        (agent === null || e.agent === agent) &&
        (!denialsOnly || e.decision === DECISION_DENY),
    );
    if (limit !== null && limit >= 0) {
      rows = limit === 0 ? [] : rows.slice(-limit);
    }
    return rows;
  }

  private *_iterEntries(): Generator<AuditEntry> {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // tolerate a torn tail line; never abort a query
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        yield entry as AuditEntry;
      }
    }
  }
}
