# @getbourdon/client

The **Bourdon L6 federation MCP client** for TypeScript/Node. Query a running
[Bourdon](https://bourdon.ai) L6 server — over a spawned `python -m core.l6_server`
stdio subprocess, or a long-lived Streamable-HTTP service — from any JS agent.

Wire-compatible with the Python L6 server: results are JSON-parsed from the server's
`TextContent` envelope, exactly as a Python peer does. Built on `@modelcontextprotocol/sdk`.

```ts
import { BourdonL6Client } from "@getbourdon/client";

// Spawn the Python L6 server over stdio (Python is the oracle):
const bourdon = new BourdonL6Client({ transport: "stdio", library: "~/agent-library" });
await bourdon.findEntity({ name: "Castmore" });
await bourdon.listRecentWork({ limit: 10 });
await bourdon.prepareRecognitionContext({ prompt: userMessage });
await bourdon.close();

// Or a remote federation peer over Streamable HTTP with a Bearer token:
const peer = new BourdonL6Client({ transport: "http", url: "https://peer/mcp", token });
await peer.listAgents();
```

All ten L6 tools are exposed: `queryAgentMemory`, `listRecentWork`, `findEntity`,
`listAgents`, `exportAgents`, `getCrossAgentSummary`, `prepareRecognitionContext`,
`getDeeperContext`, `compileCodexTurn`, `commitToFederation`. The server applies its own
per-tool `access_level` defaults (public for queries, team for recognition), so omitted
args are dropped rather than defaulted client-side.

License: Apache-2.0 (interop client). The Bourdon engine is BUSL-1.1; the canonical
implementation is the Python project.
