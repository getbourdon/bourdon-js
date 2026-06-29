# bourdon-js

> The TypeScript/JavaScript mirror of [**Bourdon**](https://bourdon.ai) — recognition-first runtime +
> cross-agent federation memory. The `@bourdon/*` packages on npm.

**Python (`pip install bourdon`) is the oracle.** This monorepo is a *faithful mirror* of it, proven by a
**cross-implementation parity harness**: the Python repo emits language-neutral fixtures (`conformance/`),
and both the Python (`pytest`) and TS (`vitest`) suites assert against the *same bytes*. A CI gate runs both
and diffs — so the two implementations can never silently drift. Mixed-language federation (a TS agent and a
Python agent sharing the same memory fabric) is therefore safe by construction.

Most of the AI-agent ecosystem is TS/JS. This makes the whole Bourdon stack real there.

## Packages

| Package | License | Mirrors (Python) | Status |
|---------|---------|------------------|--------|
| `@bourdon/conformance` | Apache-2.0 | `conformance/` parity fixtures + typed loaders | ✅ scaffolded |
| `@bourdon/l5` | Apache-2.0 | L5 manifest schema, types, atomic I/O, visibility | planned (P1) |
| `@bourdon/client` | Apache-2.0 | the L6 federation MCP client | planned (P1) |
| `@bourdon/recognition` | BUSL-1.1 | recognition contract + runtime + eval | planned (P2) |
| `@bourdon/redaction` | BUSL-1.1 | credential redaction SSOT + leak audit | planned (P3) |
| `@bourdon/participants` | BUSL-1.1 | the agent → L5 readers | planned (P4) |
| `@bourdon/federation` | BUSL-1.1 | L6 store + trust/registry/audit + remote transport | planned (P5) |
| `@bourdon/mcp-server` | BUSL-1.1 | the L6 MCP server | planned (P6) |
| `@bourdon/inference` | BUSL-1.1 | inference protocol + llama backend + turn compilers | planned (P7) |
| `bourdon` (CLI) | Apache-2.0 | the `bourdon` CLI | planned (P6) |

**License model:** the wire/interop surface (schema, fixtures, client) is **Apache-2.0** so third parties can
build conformant implementations; the engine (recognition, federation, the trust server) is **BUSL-1.1** —
source-available, the protected core. The canonical engine is the Python project.

## Develop

```bash
pnpm install
pnpm test        # vitest — parity specs load ../bourdon/conformance (or $BOURDON_CONFORMANCE_DIR)
pnpm build       # tsup — dual ESM+CJS + .d.ts
pnpm typecheck   # tsc -b (project references)
```

Requires a sibling checkout of the Python repo at `../bourdon` (the conformance oracle) until
`@bourdon/conformance` is published. Node ≥ 20. Toolchain: pnpm + tsup + vitest + oxlint + Changesets.

## Links

- 🌐 [bourdon.ai](https://bourdon.ai) · 🐍 Python oracle: [github.com/getbourdon/bourdon](https://github.com/getbourdon/bourdon)
