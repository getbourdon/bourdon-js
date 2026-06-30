# @getbourdon/redaction

The **credential-redaction SSOT + federation leak auditor** of [Bourdon](https://bourdon.ai) — the
**security keystone** of the TS mirror.

Python (`pip install bourdon`) is the **oracle** (`core/redaction.py` + `core/leak_audit.py`). This
TypeScript mirror is conformant iff it reproduces the oracle's output on the shared
`@getbourdon/conformance` fixtures: `redactText` **byte-identical** + `containsSecret`
**boolean-identical** on every secret and benign string in `redaction_battery.json` (incl. the
per-pattern `case_variants` probes), and `[kind, location]`-identical findings on
`leak_cases.json`. A pattern that fires in Python but not here **leaks a credential across machines**.

## The pattern set (the boundary)

- **12 keyword patterns**, ALL case-insensitive — a nearby word implies a secret even when the value
  is unrecognizable (`api_key`, `service_role`, `bearer token`, `password`, `.env`, …).
- **14 token patterns** — the literal token, **no keyword needed**. Case-SENSITIVE **except** `appl_`
  (RevenueCat) and `hf_` (HuggingFace), which are `/i`. These are the **keyword-less leak class** the
  pre-SSOT sets missed: AWS `AKIA`/`ASIA`, GitHub `gh[pousr]_` / `github_pat_`, GitLab `glpat-`, Slack
  `xox[baprs]-`, OpenAI/Anthropic `sk-`/`sk-ant-`, Google `AIza`/`ya29.`, Stripe `[sprk]k_live|test_`,
  `npm_`, JWT (`eyJ…`, covers Supabase `service_role`/`anon`), and PEM `-----BEGIN … PRIVATE KEY-----`.

> **Keyword-less leak class.** The whole reason this package exists: a secret with **no surrounding
> keyword** (a bare `AKIA…`, `ghp_…`, a raw JWT, a PEM block) was federating verbatim because the
> weak federation/recognition redaction sets only had keyword rules. The token patterns close that.

## Determinism / security gotchas (parity-critical)

- **`SENSITIVE_PATTERNS` are NON-GLOBAL.** A `/g` RegExp carries `lastIndex` across `.test()` calls
  and yields intermittent false negatives — and the leak auditor calls `containsSecret` once per
  string in a loop, so a sticky `lastIndex` would *intermittently miss a credential*. Only the
  internal whitespace/URL regexes are `/g`, used solely with `.replace()`.
- **Per-pattern case flags are load-bearing.** An over-eager `/i` on a case-sensitive token (AWS,
  Stripe, GitHub) or a missing `/i` on `appl_`/`hf_` is a parity break — `case_variants` probes each.
- `\b` is ASCII in JS, matching Python `re` for these patterns; mid-word boundaries don't fire, so
  benign survivors (`task`/`risk`/`disk`) must NOT redact.

## Leak audit

`auditManifest(manifest, agentFile)` walks **every string** in an L5 manifest tree (not a curated key
list, so it can't silently forget a field) and flags two classes: **CREDENTIAL** (a value matching
the patterns above) and **VISIBILITY** (an entity/session that resolves to `private` —
`PRIVATE_TAG_FAMILIES` ∪ the manifest's own declared `private_tags` — but rides in a federated
manifest). Emission order is contract: visibility(entities) → visibility(sessions) →
credentials(whole tree). It **never throws**: a non-dict manifest or malformed collection yields `[]`;
`auditLibrary` reports an unparseable `*.l5.yaml` as a finding, not a silent skip.

## License

**BUSL-1.1** (Business Source License 1.1) — engine code, not the permissive wire/interop surface.
See `LICENSE` and `LICENSE_FAQ.md`. (`@getbourdon/redaction` may depend on Apache-2.0 packages; the
reverse — Apache importing BUSL — is forbidden.)
