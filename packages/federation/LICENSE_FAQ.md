# Bourdon License FAQ

This document explains how the Business Source License (BSL) 1.1 applies to Bourdon. It is interpretive guidance — the [LICENSE](LICENSE) itself is the authoritative legal text.

## TL;DR

- **Free for almost everyone:** solo developers, internal use at any company, non-commercial projects, research, education
- **Free for non-competing commercial use:** building a product on top of Bourdon that doesn't directly compete with RADLAB LLC's hosted Bourdon offering
- **Requires a commercial license:** running Bourdon as a hosted/embedded service that competes with RADLAB LLC's paid offerings
- **Auto-converts to Apache 2.0:** four years after each version is published, that version becomes pure Apache 2.0 (fully OSS forever)

## Why BSL instead of MIT?

Bourdon was originally MIT-licensed (v0.0.1 through v0.1.0). The rename from Continuo → Bourdon (2026-05-05) was the right moment to also relicense before the project gained external adoption — the project's strategy depends on RADLAB LLC capturing some commercial value to fund continued development. Pure MIT meant any cloud company could offer Bourdon-as-a-Service without contributing back, leaving the maintainer with no path to sustainability.

BSL 1.1 keeps Bourdon source-available and free for the vast majority of users while preserving a commercial wedge against direct hosted-service competitors. HashiCorp (Terraform, Vault), CockroachDB, Sentry, Couchbase, and MariaDB all use this license; HashiCorp was acquired by IBM under BSL in 2024, demonstrating it doesn't kill commercial outcomes.

## Common scenarios

### ✅ I'm a developer using Bourdon to add memory to my own AI agent
**Free.** Solo / internal use is explicitly permitted by the Additional Use Grant.

### ✅ My company uses Bourdon internally for our own engineering tools
**Free.** "Hosting or using the Licensed Work(s) for internal purposes within an organization is not considered a competitive offering."

### ✅ I'm building a SaaS product that uses Bourdon under the hood
**Probably free** — depends on whether your product is "competitive." If your product's main value is something else (e.g., a CRM that happens to use memory federation internally), you're fine. If your product *is* memory-federation-as-a-service marketed against Bourdon, you'd need a commercial license.

The BSL Additional Use Grant defines "competitive offering" specifically: a product offered to third parties on a paid basis that *significantly overlaps with the capabilities of RADLAB LLC's paid version(s) of the Licensed Work*. If RADLAB LLC has no paid version yet, then there's nothing to overlap with — but a future paid version doesn't retroactively make existing non-competing products competitive (per the explicit grandfathering language in the grant).

### ✅ I want to fork Bourdon and build a different memory system on top
**Free**, as long as you're not running it as a competing hosted service. Standard OSS-style fork-and-modify is permitted.

### ✅ I'm contributing back to Bourdon via a PR
**Free.** Contribution doesn't trigger any commercial concerns.

### ⚠️ I'm Anthropic / OpenAI / Google / a major AI vendor and want to integrate Bourdon natively into my product
This is where you'd want to talk to RADLAB LLC. Native integration into a paid AI product *probably* counts as embedding under the BSL definition. A commercial license is straightforward to negotiate.

Contact: licensing@bourdon.ai

### ⚠️ I'm running a managed Bourdon hosted service for paying customers
Commercial license needed. Same contact as above.

## Auto-conversion timeline

Each version of Bourdon auto-converts to **Apache License 2.0** four years after its first publication:

| Version | Published | Apache 2.0 conversion |
|---|---|---|
| v0.2.0 | 2026-05-06 | 2030-05-06 |
| v0.3.0 | 2026-05-09 | 2030-05-09 |
| v0.4.0 | 2026-05-10 | 2030-05-10 |
| v0.4.1 | 2026-05-10 | 2030-05-10 |
| v0.5.0 | 2026-05-11 | 2030-05-11 |
| v0.6.0 | 2026-05-11 | 2030-05-11 |
| ... | ... | ... |

After conversion, that version is fully OSS forever. The BSL only protects the *current* version; the long tail becomes Apache 2.0 over time.

## What about old versions (v0.0.1 through v0.1.0)?

Versions v0.0.1 through v0.1.0 were published under MIT. **Anyone who downloaded those versions has perpetual MIT rights to those specific releases.** Relicensing applies forward only, not backward — that's how OSS license changes always work.

## Frequently confused points

### "BSL isn't OSI-approved, so it's not 'real OSS'"
True that BSL 1.1 isn't on the OSI-approved list, but it's source-available and auto-converts to Apache 2.0 (which IS OSI-approved). The OSS Initiative's narrow approval list is one definition of "open"; BSL meets a broader practical definition (code is public, can be read, modified, used freely for most purposes, and becomes OSI-approved over time).

### "I can't use BSL code in my company because of policy bans"
Some enterprise software policies are written against AGPL (a different copyleft license) and don't actually cover BSL. Worth checking with your legal team — most BSL projects have been accepted in environments that ban AGPL.

### "What if I'm not sure whether my use is 'competitive'?"
Email licensing@bourdon.ai with a description of what you're building. RADLAB LLC will give you a written interpretation. Better to ask than to guess.

## Contact

Licensing questions: **licensing@bourdon.ai**
General project questions: GitHub issues at [github.com/getbourdon/bourdon/issues](https://github.com/getbourdon/bourdon/issues)
