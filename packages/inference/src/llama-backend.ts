/**
 * Bourdon llama.cpp inference backend — participant for `llama-server`.
 *
 * Faithful port of `participants/llama_cpp_backend.py`. Implements the
 * {@link InferenceBackend} protocol against llama.cpp's `llama-server` HTTP API:
 * SSE-streaming completion, slot enumeration, and cancel-via-disconnect.
 *
 * The Python backend uses `httpx` (`AsyncClient.stream` + `resp.aiter_lines()`);
 * this port uses native `fetch` (Node 20+) + a manual `ReadableStream` +
 * `TextDecoder` line splitter that holds an incomplete trailing line across chunk
 * boundaries (the `aiter_lines` idiom). The KV-cache-aware interrupt is a per-slot
 * `AbortController`: `abort()` tears down the HTTP socket so `llama-server` aborts
 * generation server-side, AND flips `signal.aborted` so the consumer loop returns
 * on the next event boundary even when a mocked/slow transport keeps emitting.
 *
 * Live SSE/cancel testing is platform-bound (the box running `llama-server`).
 * The parse logic ({@link parseSseLine}) is unit-tested on any machine.
 */

import { BackendCapabilities, type InferenceBackend, type Slot } from "./inference-protocol.js";
import { logger } from "./logger.js";

export const DEFAULT_BASE_URL = "http://localhost:8080";
export const DEFAULT_REQUEST_TIMEOUT = 600.0;
export const DEFAULT_CONCURRENT_SLOTS = 1;

type FetchImpl = typeof fetch;

export interface LlamaCppBackendOptions {
  /** Optional bearer token for `llama-server` builds requiring auth. */
  apiKey?: string | null;
  /** Per-request timeout in seconds (default 600 = 10 minutes). */
  requestTimeout?: number;
  /** Slots `llama-server` was launched with (its `-np` flag). Default 1. */
  concurrentSlots?: number;
  /** Set `cache_prompt: true` on completion requests (KV-cache reuse). Default true. */
  kvCacheReuse?: boolean;
  /** Inject a `fetch` implementation (tests / shared agents). Defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
}

/**
 * `llama-server` inference backend.
 *
 * Construction is cheap and does NO I/O (`capabilities()` is static). The first
 * call to `slots()` / `streamCompletion()` performs network I/O. If the runtime
 * lacks a global `fetch` (pre-Node-20), construction raises — the import-time
 * guard equivalent to the Python `httpx` ImportError.
 */
export class LlamaCppBackend implements InferenceBackend {
  private readonly _baseUrl: string;
  private readonly _apiKey: string | null;
  private readonly _kvCacheReuse: boolean;
  private readonly _requestTimeoutMs: number;
  private readonly _fetch: FetchImpl;
  private readonly _caps: BackendCapabilities;
  /** Per-slot abort controllers so `cancel()` can disconnect an in-flight stream. */
  private readonly _controllers = new Map<number, AbortController>();

  constructor(baseUrl: string = DEFAULT_BASE_URL, opts: LlamaCppBackendOptions = {}) {
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl | undefined);
    if (!fetchImpl) {
      throw new Error(
        "global fetch is required for LlamaCppBackend (Node >= 20). " +
          "Pass opts.fetchImpl to inject one on older runtimes.",
      );
    }
    this._fetch = fetchImpl;
    this._baseUrl = baseUrl.replace(/\/+$/, "");
    this._apiKey = opts.apiKey ?? null;
    this._kvCacheReuse = opts.kvCacheReuse ?? true;
    this._requestTimeoutMs = (opts.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT) * 1000;
    this._caps = new BackendCapabilities({
      streaming: true,
      cancel: true,
      concurrentSlots: opts.concurrentSlots ?? DEFAULT_CONCURRENT_SLOTS,
      kvCacheReuse: this._kvCacheReuse,
    });
  }

  // -- Protocol surface ------------------------------------------------------

  capabilities(): BackendCapabilities {
    return this._caps;
  }

  async slots(): Promise<Slot[]> {
    let data: unknown;
    try {
      const resp = await this._fetch(`${this._baseUrl}/slots`, {
        method: "GET",
        headers: this._authHeaders(),
        signal: AbortSignal.timeout(this._requestTimeoutMs),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    } catch (exc) {
      logger.warn(`LlamaCppBackend.slots() failed: ${String(exc)}`);
      return [];
    }
    if (!Array.isArray(data)) {
      logger.warn(`LlamaCppBackend.slots(): expected list, got ${typeof data}`);
      return [];
    }
    const slots: Slot[] = [];
    for (const rawSlot of data) {
      if (rawSlot === null || typeof rawSlot !== "object" || Array.isArray(rawSlot)) continue;
      try {
        slots.push(parseSlot(rawSlot as Record<string, unknown>));
      } catch (exc) {
        logger.warn(`LlamaCppBackend.slots() failed to parse slot payload: ${String(exc)}`);
      }
    }
    return slots;
  }

  async *streamCompletion(
    prompt: string,
    opts: { slotId?: number | null } = {},
  ): AsyncIterable<string> {
    const slotId = opts.slotId ?? null;
    const body: Record<string, unknown> = {
      prompt,
      stream: true,
      n_predict: -1,
      cache_prompt: this._kvCacheReuse,
    };
    if (slotId !== null) body.id_slot = slotId;

    const headers = this._authHeaders();
    headers.Accept = "text/event-stream";
    headers["Content-Type"] = "application/json";

    // The slot a stream is bound to may be unknown until the first event arrives
    // (when slotId=null). Track tentatively under the requested id, re-key once
    // observed. ONE AbortController is the two-pronged cancel: abort() tears down
    // the socket AND flips signal.aborted so the loop returns on the next event.
    const controller = new AbortController();
    let trackingKey: number | null = slotId;
    try {
      if (trackingKey !== null) this._controllers.set(trackingKey, controller);

      const resp = await this._fetch(`${this._baseUrl}/completion`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`llama-server HTTP ${resp.status}`);
      const stream = resp.body;
      if (!stream) return;

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          if (controller.signal.aborted) return;
          const { done, value } = await reader.read();
          if (done) {
            // aiter_lines yields a final unterminated line; flush the remainder.
            const tail = buffer;
            buffer = "";
            if (tail) {
              const event = parseSseLine(stripCr(tail));
              if (event !== null) {
                const out = this._handleEvent(event, trackingKey, controller);
                if (out.rekey !== null) trackingKey = out.rekey;
                if (out.content) yield out.content;
              }
            }
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = stripCr(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
            if (controller.signal.aborted) return;
            const event = parseSseLine(line);
            if (event === null) continue;
            const out = this._handleEvent(event, trackingKey, controller);
            if (out.rekey !== null) trackingKey = out.rekey;
            if (out.content) yield out.content;
            if (out.stop) return;
          }
        }
      } catch (exc) {
        // Connection closed mid-read. If cancel() aborted us, this is a graceful
        // cancellation and we exit cleanly. Otherwise the caller deserves the error.
        if (controller.signal.aborted || isAbortError(exc)) {
          logger.debug(`stream cancelled mid-read: ${String(exc)}`);
          return;
        }
        throw exc;
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* reader already closed */
        }
      }
    } finally {
      if (trackingKey !== null) this._controllers.delete(trackingKey);
    }
  }

  async cancel(slotId: number): Promise<void> {
    const controller = this._controllers.get(slotId);
    if (controller === undefined) {
      logger.debug(`cancel(${slotId}): no active stream`);
      return;
    }
    try {
      controller.abort();
    } catch (exc) {
      logger.debug(`cancel(${slotId}): abort raised ${String(exc)}`);
    }
  }

  // -- Internal --------------------------------------------------------------

  /**
   * Apply one parsed SSE event: raise on `error`, learn the slot id on the first
   * int (non-bool) `id_slot` when tracking was unknown, surface `content` /
   * `stop`. Returns the re-keyed tracking id (or null) so the caller can update.
   */
  private _handleEvent(
    event: Record<string, unknown>,
    trackingKey: number | null,
    controller: AbortController,
  ): { content: string; stop: boolean; rekey: number | null } {
    if (event.error) {
      throw new Error(`llama-server error: ${String(event.error)}`);
    }
    let rekey: number | null = null;
    const observed = event.id_slot;
    if (
      trackingKey === null &&
      typeof observed === "number" &&
      Number.isInteger(observed) &&
      typeof observed !== "boolean"
    ) {
      this._controllers.set(observed, controller);
      rekey = observed;
    }
    const content = typeof event.content === "string" ? event.content : "";
    return { content, stop: Boolean(event.stop), rekey };
  }

  private _authHeaders(): Record<string, string> {
    return this._apiKey ? { Authorization: `Bearer ${this._apiKey}` } : {};
  }
}

// -- Module-level helpers ------------------------------------------------------

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isAbortError(exc: unknown): boolean {
  return (
    typeof exc === "object" &&
    exc !== null &&
    "name" in exc &&
    (exc as { name?: unknown }).name === "AbortError"
  );
}

/** Parse one llama-server `/slots` row into a {@link Slot}. */
function parseSlot(raw: Record<string, unknown>): Slot {
  const prompt = raw.prompt;
  let prefixHash: string | null = null;
  if (typeof prompt === "string" && prompt) {
    // llama-server exposes no content-hash; truncate as a stable routing key.
    prefixHash = prompt.slice(0, 64);
  }
  const rawId = raw.id;
  const id =
    typeof rawId === "number" ? Math.trunc(rawId) : rawId === undefined ? 0 : Math.trunc(Number(rawId));
  if (!Number.isFinite(id)) throw new Error(`invalid slot id: ${String(rawId)}`);
  return {
    id,
    busy: Boolean(raw.is_processing),
    promptPrefixHash: prefixHash,
  };
}

/**
 * Parse a single SSE line into an event dict, or null when the line is not a JSON
 * `data:` frame. Accepts both `data: {...}` and `data:{...}` (no space). Returns
 * null for empty lines, comment lines (`:` prefix), and malformed JSON (logged at
 * debug, never raised). Module-level mirror of Python's `_parse_sse_line`.
 */
export function parseSseLine(line: string): Record<string, unknown> | null {
  if (!line || line.startsWith(":")) return null;
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).replace(/^\s+/, ""); // line[5:].lstrip()
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    logger.debug(`Skipping malformed SSE line: ${JSON.stringify(line)}`);
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
