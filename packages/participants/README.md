# @getbourdon/participants

The external-agent → L5 reader layer of [Bourdon](https://bourdon.ai) (BUSL-1.1).

A **participant** normalizes a foreign agent's native memory store into a
visibility-filtered, redacted [L5 manifest](../l5). It is the bridge between an
agent's private, vendor-specific state and the cross-machine federation library.

Python (`pip install bourdon`) is the oracle; this TS mirror asserts against the
`@getbourdon/conformance` `native_stores` fixtures (output shape only).

## Reader categories

| Reader | Category | Native store |
|---|---|---|
| `HermesParticipant` | SQLite (read-only) | `~/.hermes/` — `state.db` sessions + `memories/*.md` |
| `ClaudeCodeParticipant` | file / convention | claude-brain + `~/.claude/projects/*/memory/` + KG JSONL |
| `GitHubCopilotParticipant` | network (TTL cache) | `api.github.com` PR activity → `~/.cache/bourdon/github-copilot/` |

The heavier SQLite readers (`cursor`, `codex`, `copilot_cli`) are **deferred to
the follow-on slice**; `openclaw` ships as the `@getbourdon/openclaw` plugin.

## The four invariants (enforced in code, not by trust)

1. **Visibility filter BEFORE emission** — every entity passes
   `filterForFederation`; `private_tags` always win. A PRIVATE entity never lands
   in a manifest.
2. **Deterministic / idempotent `exportL5`** — same store → byte-identical
   `toDict` (L6 hashes it for change detection).
3. **`healthCheck` NEVER throws** — a diagnostic must never crash `bourdon doctor`.
4. **Every native string through `@getbourdon/redaction`** before it enters L5.

## Usage

```ts
import { discoverParticipants, toDict } from "@getbourdon/participants";

for (const p of discoverParticipants()) {
  const health = p.healthCheck(); // never throws
  if (health.status === "blocked") continue;
  const manifest = p.exportL5(); // visibility-filtered, redacted, deterministic
  console.log(p.agentId, toDict(manifest));
}
```

Discovery is a **static registry** (`FIRST_PARTY`), not a filesystem package
scan — it preserves the Python oracle's `agentId`-sorted output, first-wins
dedupe, and log-and-skip-on-construction-failure resilience. Third-party plugins
are gated behind `BOURDON_PLUGINS=1` (a no-op stub today).

## Native addon note

The SQLite readers use [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3),
a native addon. It is loaded lazily: if the addon fails to build on a given
toolchain, `sqliteAvailable()` returns `false`, the SQLite readers degrade
gracefully, and the rest of the package (file + network readers) keeps working.
The SQLite-reader parity tests are gated on `sqliteAvailable()`.

## License

BUSL-1.1 — see [LICENSE](./LICENSE) and [LICENSE_FAQ.md](./LICENSE_FAQ.md).
