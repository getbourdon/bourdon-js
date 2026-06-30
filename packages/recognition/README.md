# @getbourdon/recognition

The **recognition timing core** of [Bourdon](https://bourdon.ai) — the synchronous recognition-FIRST
runtime, the cross-surface recognition contract, and the precision/recall/F1 eval harness.

Python (`pip install bourdon`) is the **oracle**. This TypeScript mirror is conformant iff it
reproduces the oracle's output on the shared `@getbourdon/conformance` fixtures
(`recognition_vectors.json` + `recognition_golden_v1.yaml`). It is the **4th parity engine**:
claude-code / codex / cursor / TS all agree on the same `(prompt, manifest) → tier + confidence
bucket + recognition string`.

## The recognition-FIRST contract (what must survive)

- **The recognition string is computed synchronously** — zero I/O, zero model call. It is emitted in
  ~0ms while the model's first token is ~1s behind.
- **L1 hydration is a lazy thunk** `() => Promise<string>` (mirrors Python's un-started coroutine). It
  must NOT execute during `recognitionFirst`; the caller controls start. It NEVER blocks the first
  response and NEVER rejects — timeout/error degrade to `''` (L0-only).
- **`recognitionConfidence` is tier-only.** The emitted bucket is a pure function of
  `bestMatchTier(prompt, name+aliases)`. `nAnchorTerms` / `cwdHit` / `recencyFresh` drive RANKING on
  other surfaces only; folding them into the emitted bucket would break parity (other surfaces can't
  see them, and parity requires equality).

## Determinism notes (parity-critical)

- The tokenizer **hyphen-splits** (`"Bourdon-AI v2" → [bourdon, ai, v2]`), lowercases, and keeps
  **duplicates + order** — never a `Set` for the ladder.
- Matching uses a **contiguous token subsequence**, not a raw substring. This is the **short-name
  guard**: `"ILTTed"` does NOT match `"ILTT"` (`iltt` is a substring of `iltted` but not a whole-token
  subsequence of the prompt's tokens).
- `normalizedConfidence` runs `Math.round(score*1e4)/1e4` **before** comparing to the `0.45` and
  `0.80` bucket boundaries (kills float-sum drift). Both edges are pinned by fixtures.
- `detectEntities` prefilters with a token-set **subset** test (a sound *necessary* condition only);
  the full `match_tier` ladder still decides, and the gate requires `>= TOKEN_SUBSEQUENCE`.
- `filterManifestForAccess` runs **before** detection, so a private entity can never surface.
- Recognition strings use the literal `" -- "` (double-hyphen, **not** an em-dash) and `"You're"`
  (straight apostrophe).

## Not ported (by design)

`orchestrator.py`'s legacy substring `detect_entities` is the **decoy prototype** — it had short-name
false positives (`"baNAS"` matched `"NAS"`). It is intentionally **NOT** ported. The contract's
token-subsequence ladder is the only matcher in this package.

## License

**BUSL-1.1** (Business Source License 1.1) — this is engine code, not the permissive wire/interop
surface. See `LICENSE` and `LICENSE_FAQ.md`. (`@getbourdon/recognition` may depend on the Apache-2.0
`@getbourdon/l5`; the reverse — Apache importing BUSL — is forbidden.)
