/**
 * Bourdon inference backend protocol — the backend-neutral contract every
 * local-inference participant implements.
 *
 * Faithful port of `core/inference_protocol.py`. Backend-neutral by design: the
 * recognition-first runtime needs to drive token streaming concurrent with
 * hydration, and a future interrupt-first primitive needs mid-stream cancel +
 * concurrent slot routing. The capability surface is checked at registration so a
 * backend missing a required primitive fails loudly — it never silently degrades.
 */

/** Raised when a backend lacks a capability the caller required. */
export class BackendUnsupported extends Error {
  readonly missing: readonly string[];

  constructor(missing: Iterable<string>) {
    const missingList = [...new Set(missing)].sort();
    const plural = missingList.length === 1 ? "capability" : "capabilities";
    super(`Backend missing required ${plural}: ${missingList.join(", ")}`);
    this.name = "BackendUnsupported";
    this.missing = missingList;
  }
}

/**
 * A backend-side generation slot. Single-context backends report one `Slot{id:0}`;
 * concurrent backends (llama.cpp `-np N`, vLLM, TGI) report one per slot.
 */
export interface Slot {
  /** Stable slot id; pass back to `cancel(slotId)` / `streamCompletion({slotId})`. */
  readonly id: number;
  /** True if the slot is currently generating. */
  readonly busy: boolean;
  /** Backend identifier for the cached prompt prefix on this slot, or null. */
  readonly promptPrefixHash?: string | null;
}

export type CapabilityName = "streaming" | "cancel" | "concurrent_slots" | "kv_cache_reuse";

/**
 * Static description of what a backend can do. Constant for the backend
 * instance's lifetime — construct a new instance rather than mutate.
 */
export class BackendCapabilities {
  readonly streaming: boolean;
  readonly cancel: boolean;
  readonly concurrentSlots: number;
  readonly kvCacheReuse: boolean;

  constructor(opts: {
    streaming: boolean;
    cancel: boolean;
    concurrentSlots: number;
    kvCacheReuse: boolean;
  }) {
    this.streaming = opts.streaming;
    this.cancel = opts.cancel;
    this.concurrentSlots = opts.concurrentSlots;
    this.kvCacheReuse = opts.kvCacheReuse;
  }

  /**
   * Boolean view of a named capability. `concurrent_slots` is supported when the
   * count is > 1. Unknown names return false (forward-compatible queries never throw).
   */
  supports(name: string): boolean {
    switch (name) {
      case "concurrent_slots":
        return this.concurrentSlots > 1;
      case "streaming":
        return this.streaming;
      case "cancel":
        return this.cancel;
      case "kv_cache_reuse":
        return this.kvCacheReuse;
      default:
        return false;
    }
  }
}

/**
 * Backend-neutral inference contract. Structural — a participant satisfies it by
 * providing the four methods. All async methods must be cancellable via
 * `AbortSignal`; `streamCompletion` must be re-entrant across distinct `slotId`s.
 */
export interface InferenceBackend {
  /** Static capability surface. Pure, cheap, no I/O. */
  capabilities(): BackendCapabilities;
  /** Current slot state. Must NOT raise — return [] when unreachable (caller degrades). */
  slots(): Promise<Slot[]>;
  /** Yield tokens one at a time. Dropping the iterator must stop server-side generation. */
  streamCompletion(prompt: string, opts?: { slotId?: number | null }): AsyncIterable<string>;
  /** Stop generation on a slot. Idempotent; must NOT raise on transient errors (log + return). */
  cancel(slotId: number): Promise<void>;
}

/** The four method names a backend must structurally provide. */
const BACKEND_METHODS = ["capabilities", "slots", "streamCompletion", "cancel"] as const;

function isInferenceBackend(backend: unknown): backend is InferenceBackend {
  if (typeof backend !== "object" || backend === null) return false;
  const b = backend as Record<string, unknown>;
  return BACKEND_METHODS.every((m) => typeof b[m] === "function");
}

/**
 * Validate `backend` against the protocol and required capabilities, returning it
 * typed as `InferenceBackend`. Default required set is `["streaming"]`.
 *
 * @throws TypeError if the object does not structurally satisfy InferenceBackend
 *   (or if `requiredCapabilities` is a bare string).
 * @throws BackendUnsupported if any required capability is missing.
 */
export function registerBackend(
  backend: unknown,
  requiredCapabilities: Iterable<string> = ["streaming"],
): InferenceBackend {
  if (typeof requiredCapabilities === "string") {
    throw new TypeError(
      "requiredCapabilities must be an iterable of capability names, not a bare string",
    );
  }
  if (!isInferenceBackend(backend)) {
    const name =
      typeof backend === "object" && backend !== null ? backend.constructor.name : typeof backend;
    throw new TypeError(
      `${name} does not implement InferenceBackend ` +
        "(missing one or more of: capabilities, slots, streamCompletion, cancel)",
    );
  }
  const caps = backend.capabilities();
  const missing = [...new Set(requiredCapabilities)].filter((n) => !caps.supports(n)).sort();
  if (missing.length > 0) {
    throw new BackendUnsupported(missing);
  }
  return backend;
}
