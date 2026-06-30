/**
 * Bourdon recognition-FIRST runtime — ported from `core/recognition_runtime.py`.
 *
 * The recognition string is computed SYNCHRONOUSLY: zero I/O, zero model call.
 * It is emitted in ~0ms while the model's first token is ~1s behind. L1
 * hydration runs in parallel and NEVER blocks the first response, NEVER raises
 * (timeout/error → '' → degrade to L0-only).
 *
 * TS mapping of Python's un-started coroutine: `result.hydration` is a LAZY
 * THUNK `() => Promise<string>` (NOT an eager Promise). The caller controls
 * start; the eval harness simply discards it (no unhandled rejection). It must
 * NOT execute during `recognitionFirst`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  buildRecognitionString,
  detectEntities,
  filterManifestForAccess,
  recognitionConfidence,
  type ConfidenceBucket,
  type EntityDict,
} from "./contract.js";

/**
 * Seconds. Past this budget, hydration is dropped for the current turn. Tuned
 * for the thesis: the first response sentence should be ready in ~0-200ms, so
 * hydration has 2-3s of LLM-generation overlap to land before the next turn.
 */
export const DEFAULT_HYDRATION_TIMEOUT = 3.0;

/** Output of a recognition-first dispatch. */
export interface RecognitionResult {
  /** Immediate, no-retrieval acknowledgment. Empty when nothing matched. */
  recognition: string;
  /** The entity dicts that triggered recognition. */
  matchedEntities: EntityDict[];
  /** Top-anchor confidence bucket (tier-driven, cross-surface parity). */
  confidence: ConfidenceBucket;
  /** Per-entity confidence buckets, keyed by entity name (top == confidence). */
  entityConfidences: Record<string, ConfidenceBucket>;
  /**
   * LAZY THUNK resolving to the L1-hydrated detail string. The caller invokes
   * it in parallel with their own streaming work. NEVER blocks recognition,
   * NEVER rejects (timeout/error → ''). Mirrors Python's un-started coroutine.
   */
  hydration: () => Promise<string>;
  /** For interrupt-first dispatches: slot to continue on. null otherwise. */
  recommendedSlotId: number | null;
}

export interface RecognitionOptions {
  l1Dir?: string | null;
  accessLevel?: string;
  hydrationTimeout?: number;
}

/**
 * Load L1 synopsis documents for matched entities, in parallel. Empty string
 * when no `l1Dir`, the dir is missing, or no matching files are present. NEVER
 * raises — failures degrade to L0-only behavior.
 */
export async function hydrateL1(
  matches: EntityDict[],
  l1Dir: string | null = null,
): Promise<string> {
  if (matches.length === 0 || l1Dir == null) return "";
  try {
    const st = await stat(l1Dir);
    if (!st.isDirectory()) return "";
  } catch {
    return "";
  }

  const readOne = async (entity: EntityDict): Promise<string> => {
    const name = entity.name;
    if (typeof name !== "string" || !name) return "";
    let path = join(l1Dir, `${name}.md`);
    let exists = false;
    try {
      exists = (await stat(path)).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      // Case-insensitive scan: alt.stem.lower() == name.lower()
      const target = name.toLowerCase();
      let found: string | null = null;
      try {
        const entries = await readdir(l1Dir);
        for (const entry of entries) {
          if (!entry.toLowerCase().endsWith(".md")) continue;
          const stem = entry.slice(0, entry.length - 3);
          if (stem.toLowerCase() === target) {
            found = join(l1Dir, entry);
            break;
          }
        }
      } catch {
        return "";
      }
      if (found == null) return "";
      path = found;
    }
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "";
    }
  };

  let docs: string[];
  try {
    docs = await Promise.all(matches.map((e) => readOne(e)));
  } catch {
    // never crash hydration
    return "";
  }
  const blocks = docs.map((d) => d.trim()).filter((d) => d);
  if (blocks.length === 0) return "";
  return blocks.join("\n\n---\n\n");
}

/** Wrap hydration in a timeout that resolves '' on overrun. Never rejects. */
function hydrationWithTimeout(
  matches: EntityDict[],
  l1Dir: string | null,
  timeoutSeconds: number,
): Promise<string> {
  const work = hydrateL1(matches, l1Dir).catch(() => "");
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), Math.max(0, timeoutSeconds) * 1000);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Compose an immediate recognition response and a lazy hydration thunk. The
 * recognition string is computed synchronously (no I/O, no model call, no
 * retrieval). Visibility-filtered BEFORE detection, so a private entity can
 * never surface.
 */
export function recognitionFirst(
  userMsg: string,
  manifest: unknown,
  options: RecognitionOptions = {},
): RecognitionResult {
  const {
    l1Dir = null,
    accessLevel = "team",
    hydrationTimeout = DEFAULT_HYDRATION_TIMEOUT,
  } = options;

  const filtered = filterManifestForAccess(manifest, accessLevel);
  const matches = detectEntities(userMsg, filtered);
  const recognition = buildRecognitionString(matches);

  if (matches.length === 0) {
    return {
      recognition,
      matchedEntities: [],
      confidence: "none",
      entityConfidences: {},
      // No matches → no point hydrating nothing. Thunk resolves '' and never runs eagerly.
      hydration: () => Promise.resolve(""),
      recommendedSlotId: null,
    };
  }

  const top = matches[0] as EntityDict;
  const anchorNames = [String(top.name ?? "")].concat(
    (Array.isArray(top.aliases) ? top.aliases : []).map((a) => String(a)),
  );
  const confidence = recognitionConfidence(userMsg, anchorNames);

  const entityConfidences: Record<string, ConfidenceBucket> = {};
  for (const ent of matches) {
    const name = String(ent.name ?? "");
    if (!name) continue;
    const names = [name].concat(
      (Array.isArray(ent.aliases) ? ent.aliases : []).map((a) => String(a)),
    );
    entityConfidences[name] = recognitionConfidence(userMsg, names);
  }

  return {
    recognition,
    matchedEntities: matches,
    confidence,
    entityConfidences,
    hydration: () => hydrationWithTimeout(matches, l1Dir, hydrationTimeout),
    recommendedSlotId: null,
  };
}

/** Minimal backend contract used by `interruptFirst` (cancel only). */
export interface InferenceBackend {
  cancel(slotId: number): Promise<void> | void;
}

/**
 * Cancel an in-flight generation, THEN compute a fresh recognition for a new
 * message, THEN stamp `recommendedSlotId`. The cancel-then-recognize order is
 * locked (recognizing first would add ms to the emit — the entire latency
 * budget the thesis is built on).
 */
export async function interruptFirst(
  newUserMsg: string,
  manifest: unknown,
  options: RecognitionOptions & {
    backend: InferenceBackend;
    slotToCancel: number;
  },
): Promise<RecognitionResult> {
  const { backend, slotToCancel, ...rest } = options;
  await backend.cancel(slotToCancel);
  const result = recognitionFirst(newUserMsg, manifest, rest);
  result.recommendedSlotId = slotToCancel;
  return result;
}
