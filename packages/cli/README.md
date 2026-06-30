# bourdon

The unscoped **`bourdon`** command-line interface — a thin, **Apache-2.0** dispatch
layer over the `@getbourdon/*` engine packages. It contains **no engine logic**: every
subcommand delegates to a ported `@getbourdon/*` package, so the CLI itself is
permissively licensed even though the engine packages are BUSL-1.1.

```bash
npx bourdon --help
# or
npm i -g bourdon && bourdon serve
```

This is a faithful command-for-command port of the Python `cli/main.py` (`argparse`,
~78 subparsers) to `commander.js`. Python (`pip install bourdon`) is the oracle.

## What's wired vs. deferred

Commands backed by an already-ported package run natively:

- `prepare-turn`, `deeper-context`, `codex compile-turn` — recognition context
  (`@getbourdon/federation` + `@getbourdon/mcp-server` + `@getbourdon/inference`)
- `recognition eval` — the scoring harness (`@getbourdon/recognition`)
- `serve` — the L6 federation MCP server (`@getbourdon/mcp-server`), including the
  non-loopback-bind refusal
- `agent {add,list,rotate,set-tier}`, `grant`, `ungrant`, `revoke`,
  `staging {list,promote,reject}`, `audit` — trust + audit (`@getbourdon/federation`)
- `audit-leaks` — the leak auditor (`@getbourdon/redaction`)
- `agents` — the `--json` desktop-tray contract (local enumeration)
- `doctor`, `export-all`, `hermes {export,doctor}`, `claude-code export` —
  the participant layer (`@getbourdon/participants`)

Commands whose backing reader is **not yet ported** to TS keep their full parser
surface (so `bourdon --help` stays complete) but exit non-zero with a pointer to the
Python implementation rather than silently failing — e.g. the `cursor` / `copilot` /
`cascade` export readers, the `sync` rsync seam, and the `benchmark` python seam.

## Defaults are the contract

The non-obvious `argparse` defaults are copied **exactly**: `serve --port 7500
--host 127.0.0.1`, `--max-items 6` / `--max-chars 1800` (but **1 / 500** on the
`codex hook`), `--max-sessions 20`, `--max-entities 100`, `recognition eval
--min-*-f1 0.0`, `audit --limit 50`, and the access-level default split (`team`
everywhere except `demo` and `sync push`, which default to `public`).

## License

Apache-2.0. See [LICENSE](./LICENSE).
