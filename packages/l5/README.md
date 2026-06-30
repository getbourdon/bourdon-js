# @getbourdon/l5

The **L5 agent-memory manifest** layer of [Bourdon](https://bourdon.ai) — the per-agent public memory
glossary that L6 federation aggregates across agents.

Python (`pip install bourdon`) is the **oracle**. This TypeScript mirror is conformant iff it reproduces the
oracle's output on the shared `@getbourdon/conformance` fixtures.

## What's in here

- **`schema/L5_schema.json`** — the normative JSON Schema (draft 2020-12), copied byte-identical from the
  Python repo (`spec/L5_schema.json`). `$id = https://bourdon.ai/schema/L5_manifest_v0.1.json`.
- **Generated types** (`src/types.gen.ts`) — produced from the schema via `json-schema-to-typescript`
  (`pnpm --filter @getbourdon/l5 gen`). Hand-writing the wire types is banned; regenerate instead.
- **`validateManifest`** — [ajv](https://ajv.js.org) (2020-12 + formats) compiled over the same schema.
  Returns `{ valid, errors }` where each error carries `keyword` + ajv-style `instancePath`.
- **`applyVisibility` / `filterForFederation`** — the visibility model. Precedence (highest first):
  `private_tags` ▸ explicit `visibility` ▸ `team_tags` ▸ `policy.default` (or `public`). Private entities are
  dropped from federation.
- **`toDict`** — the byte-faithful `to_dict()` port (the L6 change-detection hash key): drops `None`/`undefined`
  and empty-array fields, keeps `Visibility` as its lowercase value, and emits keys in dataclass field order.
- **`writeL5` / `writeL5Dict` / `readL5Dict`** — atomic YAML write (tmp + `fsync` + rename) and lenient read.

```ts
import { makeManifest, toDict, validateManifest, writeL5 } from "@getbourdon/l5";

const manifest = makeManifest({
  spec_version: "0.1",
  agent: { id: "clyde", type: "note-capture" },
  last_updated: "2026-06-29T12:00:00+00:00",
});

const { valid, errors } = validateManifest(toDict(manifest));
writeL5(manifest, "/path/to/agents/clyde.yaml");
```

## Determinism notes (parity-critical)

- `Entity` emits `valid_from` / `valid_to` **after** `visibility` (they were appended later in the dataclass).
- A present `visibility_policy` **always** emits `default` (defaults to `"public"`) even if the caller omits it.
- Empty arrays are dropped; `null`/`undefined` fields are dropped — never serialized as `null` or `[]`.

License: **Apache-2.0** (the wire-contract surface is permissive so third parties can build conformant
implementations). The Bourdon engine packages are BUSL-1.1.
