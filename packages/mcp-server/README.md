# @getbourdon/mcp-server

Bourdon **L6 — the MCP server facade** (BUSL-1.1). The TypeScript mirror of the
Python `core/l6_server.py` on `@modelcontextprotocol/sdk`. It exposes
`@getbourdon/federation` (the L6Store + trust boundary) natively to any MCP-aware
agent (Claude Code, Codex, Cursor) and is **wire-compatible with the Python
server in BOTH directions**, so mixed-language federation works.

> Python (`pip install bourdon`) is the oracle. This package asserts its tool
> payloads against the `@getbourdon/conformance` `mcp_snapshots` fixtures,
> recovered through the exact same wire path a Python `RemoteL6Client` uses.

## The wire contract (the single highest-risk detail)

Every tool handler returns **JSON-in-TextContent**:

```ts
{ content: [{ type: "text", text: JSON.stringify(payload) }] }
```

— **not** the SDK's default structured content. The Python `RemoteL6Client` (and
`@getbourdon/client`) recover the payload with `json.loads(item.text)` /
`JSON.parse(text)`. Returning structured content instead makes a Python peer's
`json.loads(item.text)` get `None` and silently breaks federation. The
`mcp_snapshots` fixtures snapshot the **post-round-trip** payload, so the parity
test drives a real MCP client over an in-memory transport, recovers
`content[0].text`, `JSON.parse`s it, normalizes, and compares to the Python `.res`.

## Tools (10) + resources (3)

Thin delegates to `@getbourdon/federation` + `@getbourdon/recognition`. Tool
names, arg names, and defaults are byte-identical to the Python server —
including the **access_level default split**:

| default `public` (read/query) | default `team` (recognition / turn) |
|---|---|
| `query_agent_memory`, `list_recent_work`, `find_entity`, `get_cross_agent_summary` | `prepare_recognition_context`, `compile_codex_turn`, `get_deeper_context` |

`list_agents`, `export_agents`, `commit_to_federation` round out the ten.
`compile_codex_turn` returns the **deferred P7 stub** (`{_status:"deferred",
schema_version:"codex-turn-brief/v1", reason}`) — the turn compiler is
environment-bound and ships in Phase 7. Resources:
`agent-library://agents`, `agent-library://agents/{agent_id}/memory`,
`agent-library://entities/{name}`.

## Transports + auth

```ts
import { createL6Server, runStdio, runHttpServer } from "@getbourdon/mcp-server";
import { L6Store, FederationRegistry } from "@getbourdon/federation";

const store = new L6Store("/path/to/agent-library");
const registry = new FederationRegistry();

// stdio (the MCP-host default; resolves to OPERATOR — v0.8.0 behavior):
await runStdio(createL6Server(store, { registry }));

// streamable-HTTP (Bearer auth, stateless):
runHttpServer(() => createL6Server(store, { registry }), {
  host: "127.0.0.1", // default; a NON-loopback bind without auth REFUSES to start
  port: 7500,
  registry,
});
```

Security invariants are enforced **in code**: an empty Bearer can never
authenticate as OPERATOR (the legacy compare needs both a configured legacy token
and a non-empty presented token); a non-loopback bind without auth (or with
`--allow-unauthenticated`, which is loopback-only) throws `BindRefusedError`;
identity propagates to the tool handlers via `AsyncLocalStorage`
(`runWithCaller`) so a quarantined caller can never escalate.

The `bourdon-l6-server` bin mirrors `python -m core.l6_server`:
`--library --transport {stdio,http} --port 7500 --host 127.0.0.1 --peer
--peers-config --allow-unauthenticated`.

## License

BUSL-1.1 — see `LICENSE` + `LICENSE_FAQ.md`.
