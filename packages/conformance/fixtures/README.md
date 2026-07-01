# `conformance/` — cross-implementation parity fixtures

**Python is the oracle.** These language-neutral fixtures are the contract that the
TypeScript mirror (`getbourdon/bourdon-js`, published as `@bourdon/*`) must reproduce
exactly. The TS mirror is *conformant* iff it produces the same output as Python on
these fixtures — byte-for-byte where the contract is bytes (redaction, recognition
strings, MCP wire), value-for-value where it's structured (F1, schema validity, tool I/O).

This directory is **generated** by `tools/gen_conformance.py` (the single writer) — it
imports the live oracle modules and emits their actual output, so expectations can never
be hand-typed out of sync with the code. Two mechanical suites assert against the *same
bytes*: `tests/test_redaction.py` (Python, characterization) and the TS `vitest`
conformance suite (parity). A CI drift gate runs the generator and fails on an
uncommitted diff (`git diff --exit-code -- conformance/`).

## Regenerate

```bash
python tools/gen_conformance.py     # rewrites conformance/ + manifest.json
```

After changing a pattern in `core.redaction` (or any oracle), regenerate, review the
diff, and bump `conformance_version` in `tools/gen_conformance.py` (patch = added cases,
minor = new family, major = a changed expected-output = a reviewed behavior change).

## Contents

| File | Family | Source (extracted from) | Phase |
|------|--------|-------------------------|-------|
| `redaction_battery.json` | redaction | `tests/test_redaction.py` SECRETS/BENIGN | ✅ wired |
| `manifest.json` | index | (generated) | ✅ |
| `recognition_vectors.json` | recognition | `test_recognition_{contract,parity}.py` | ✅ wired |
| `l5_schema.json` + `l5_manifests/` | schema | `spec/L5_schema.json` | ✅ wired |
| `tier_matrix.json` | trust (D4) | `create_l6_server` enforcement over the seed | ✅ wired |
| `fed_seed_library/agents/*.l5.yaml` | seed input | 2-agent library, public/team/private | ✅ wired |
| `on_disk/federation.yaml` + `audit.jsonl` + `auth_vectors.json` | on-disk trust state | real `FederationRegistry` + `FederationAudit` | ✅ wired |
| `mcp_snapshots/` | wire | live `create_l6_server` tool closures over `fed_seed_library` | ✅ wired |

The L6 **federation** families are the cross-machine trust boundary. `tier_matrix.json` drives
the live `create_l6_server` enforcement (a quarantined `openclaw` granted only `claude-code`) and
pins, per `tool x trust-tier x granted`, the allow/deny decision plus the verbatim structured-denial
dict. `on_disk/` holds Python-written artifacts the TS side must parse identically: a registry with
**sha256-only** rows for **synthetic** `bdn_` tokens (stored as fragment arrays in `auth_vectors.json`,
never a contiguous literal), and an append-only audit log produced by the real `record()` with frozen
timestamps. Both pytest (`tests/test_federation_conformance.py`) and the TS vitest suite assert these.

The `mcp_snapshots/` family pins the **JSON-in-TextContent wire contract** for all 10 L6
MCP tools. Each `*.res.json` is the live tool's payload (as `RemoteL6Client` recovers it:
`json.loads` of the single `TextContent.text` = `json.dumps(payload)`) run through one codified
NORMALIZER — sort object keys, round floats to 4dp, drop null/empty-list fields (to_dict
omission), freeze `last_updated`/`generated_at`/`generated_from`/`path`, drop latency fields,
and decode base64 `next_cursor` to its `{offset}` payload. The normalizer is itself fixture-tested
in `mcp_snapshots/_normalizer.json`. `compile_codex_turn` is the **deferred P7 stub** (its brief is
environment-bound — live cwd + git repo identity — so it is not a portable parity fixture yet).

Token-shaped secrets are stored as **fragment arrays** joined at load time, so no
contiguous secret literal ever lands in git (GitHub push-protection scans literals).
Both loaders `"".join(fragments)`.

See the master plan: `claude-brain/PROJECTS/NEUROLAYER/PLAN_TS_MIRROR_2026-06-29.md` and
the `bourdon-parity-fixture-harness` / `bourdon-py-to-ts-port` skills.
