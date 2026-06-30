# @getbourdon/federation

Bourdon **L6 — the cross-machine trust boundary** (BUSL-1.1). The TypeScript
mirror of the Python `core/l6_store.py` + `l6_remote.py` +
`federation_{registry,audit,staging}.py`. Python (`pip install bourdon`) is the
oracle; this package asserts against the `@getbourdon/conformance`
`fed_seed_library` / `tier_matrix` / `on_disk` fixtures.

> Security-critical. Every invariant below is enforced **in code**, not by
> trust — a single missed clamp leaks PRIVATE memory across machines.

## What's inside

- **`L6Store`** — in-memory aggregator over `<library>/agents/*.l5.yaml`.
  Visibility-filtered query primitives (`listAgents`, `findEntity`,
  `listRecentWork`, `getCrossAgentSummary`, `getAgentManifest`,
  `buildRecognitionManifest`), base64url pagination cursors with a stable
  `(date desc, agent desc)` total order, `exportAgents` with the egress
  visibility clamp + credential redaction, and the `*Federated` peer fan-outs
  (`Promise.allSettled` — a dead peer never fails the local answer; peer rows
  tagged `peer:<name>:<agent>`).
- **`commitL5`** runs behind an **async mutex** (the Node analogue of Python's
  `threading.RLock`): Node interleaves at every `await`, so a
  read-modify-write-RELOAD without serialization is the P1-3 lost-update race.
- **`FederationRegistry`** — single-operator trust registry at
  `~/.bourdon/federation.yaml`. `bdn_` + 24-byte-hex tokens, **SHA-256 hash-only
  at rest**, `crypto.timingSafeEqual` against ALL rows (constant-time, no early
  exit), trust tiers, an **empty Bearer authenticates nowhere**, `(mtimeNs,
  size)` hot-reload staleness key, and **fail-closed** parse (a corrupt registry
  authenticates no one).
- **`AgentIdentity`** + **`AsyncLocalStorage`** caller propagation
  (`runWithCaller` / `getCaller`) — Python's `ContextVar`. Fail-closed: an
  unbound caller is `OPERATOR` (stdio); an unknown HTTP caller is quarantined.
- **`FederationAudit`** — append-only JSONL, **never token material**,
  write-failure non-fatal, microsecond-padded timestamps, Python-`json.dumps`
  default-separator byte parity.
- **Quarantined staging** — quarantined writes land under
  `<library>/staging/<caller>/`, invisible to every read tool until promoted.
- **`enforceToolAccess`** + **`clampPeerAccess`** — the tier-matrix decision
  logic and the ingress/egress PRIVATE clamps.
- **`RemoteL6Client`** — depth-1 peer client: `federation_hop: 1` on every
  fan-out (#139), `access_level` capped to `("public","team")`, never
  `include_private: true`, per-call timeout 5.0s / recognition 0.2s, and a
  never-raise wrapper so one dead peer never breaks the merge.

## License

BUSL-1.1 — see `LICENSE` and `LICENSE_FAQ.md`.
