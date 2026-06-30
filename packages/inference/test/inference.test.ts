import { describe, expect, it } from "vitest";

import {
  BackendCapabilities,
  BackendUnsupported,
  type InferenceBackend,
  type Slot,
  registerBackend,
} from "../src/index.js";

function fakeBackend(caps: BackendCapabilities): InferenceBackend {
  return {
    capabilities: () => caps,
    slots: async (): Promise<Slot[]> => [{ id: 0, busy: false }],
    // eslint-disable-next-line require-yield
    streamCompletion: async function* () {
      return;
    },
    cancel: async () => {},
  };
}

const fullCaps = new BackendCapabilities({
  streaming: true,
  cancel: true,
  concurrentSlots: 4,
  kvCacheReuse: true,
});

describe("@getbourdon/inference protocol", () => {
  it("supports() — concurrent_slots is true only when count > 1; unknown names false", () => {
    expect(fullCaps.supports("streaming")).toBe(true);
    expect(fullCaps.supports("cancel")).toBe(true);
    expect(fullCaps.supports("kv_cache_reuse")).toBe(true);
    expect(fullCaps.supports("concurrent_slots")).toBe(true);
    const single = new BackendCapabilities({
      streaming: true,
      cancel: false,
      concurrentSlots: 1,
      kvCacheReuse: false,
    });
    expect(single.supports("concurrent_slots")).toBe(false);
    expect(single.supports("nonsense")).toBe(false);
  });

  it("registerBackend returns the backend when capabilities are met", () => {
    expect(registerBackend(fakeBackend(fullCaps), ["streaming"])).toBeTruthy();
    expect(registerBackend(fakeBackend(fullCaps), ["streaming", "cancel", "kv_cache_reuse"])).toBeTruthy();
  });

  it("registerBackend throws BackendUnsupported listing every missing capability (sorted, deduped)", () => {
    const weak = fakeBackend(
      new BackendCapabilities({ streaming: true, cancel: false, concurrentSlots: 1, kvCacheReuse: false }),
    );
    try {
      registerBackend(weak, ["cancel", "kv_cache_reuse", "cancel"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BackendUnsupported);
      expect((e as BackendUnsupported).missing).toEqual(["cancel", "kv_cache_reuse"]);
    }
  });

  it("registerBackend throws TypeError on a non-backend or a bare-string requirement", () => {
    expect(() => registerBackend({}, ["streaming"])).toThrow(TypeError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => registerBackend(fakeBackend(fullCaps), "streaming" as any)).toThrow(TypeError);
  });
});
