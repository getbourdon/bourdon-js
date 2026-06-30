/**
 * The MCP-snapshot normalizer (codified canonicalizer). Mirrors
 * `normalize_snapshot()` in the Python generator and is fixture-tested
 * pair-for-pair against `conformance/mcp_snapshots/_normalizer.json`.
 *
 * Rules (applied recursively):
 *  - round floats to 4 dp (bools / strings untouched);
 *  - DROP null + empty-list dict fields (to_dict omission parity);
 *  - FREEZE non-deterministic fields by name {last_updated, generated_at,
 *    generated_from, path} -> "<frozen>";
 *  - DROP latency fields {recognition_latency_us, peer_latencies_us};
 *  - decode a base64 `next_cursor` to its `{offset:N}` payload (null cursor
 *    drops like any other null);
 *  - arrays keep order (sessions / matches / agents order is contract).
 */

import { decodeCursor } from "@getbourdon/federation";

const FREEZE_FIELDS = new Set(["generated_at", "generated_from", "last_updated", "path"]);
const DROP_LATENCY_FIELDS = new Set(["peer_latencies_us", "recognition_latency_us"]);
const CURSOR_FIELDS = new Set(["next_cursor"]);
const FROZEN = "<frozen>";

function roundFloat(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function normalizeSnapshot(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) return roundFloat(value);
  if (Array.isArray(value)) return value.map((v) => normalizeSnapshot(v));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_LATENCY_FIELDS.has(key)) continue;
    if (FREEZE_FIELDS.has(key)) {
      out[key] = FROZEN;
      continue;
    }
    if (CURSOR_FIELDS.has(key)) {
      if (typeof raw === "string") {
        out[key] = { offset: decodeCursor(raw) };
        continue;
      }
      if (raw === null) continue; // last page -> dropped like any null
      out[key] = normalizeSnapshot(raw);
      continue;
    }
    const v = normalizeSnapshot(raw);
    if (v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[key] = v;
  }
  return out;
}
