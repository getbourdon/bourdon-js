/**
 * Single source of truth for credential redaction across every Bourdon surface.
 *
 * Port of `core/redaction.py` (the Python oracle). Historically each surface
 * carried its own credential-pattern tuple and drifted: the federation and
 * recognition surfaces — the ones that actually cross machines — used the
 * *weakest* sets, so keyword-less secrets (AWS `AKIA...`, GitHub `ghp_...`,
 * JWTs / Supabase `service_role`, PEM private keys) federated verbatim
 * (3-Star Michelin audit 2026-06-22, findings P0-2 / P0-4).
 *
 * Every surface now routes through {@link redactText} / {@link containsSecret}.
 * The shared `conformance/redaction_battery.json` fixture feeds the same secret
 * battery through this mirror and the Python oracle and asserts identical
 * redaction, so the invariant can never silently drift again.
 *
 * SECURITY KEYSTONE — the patterns below are the boundary. Transcribed
 * literally from `redaction.py` with EXACT per-pattern case flags:
 *  - all 12 keyword patterns are case-insensitive (`i`);
 *  - the 14 token patterns are case-SENSITIVE except `appl_` and `hf_`, which
 *    carry `i`.
 *
 * The SENSITIVE_PATTERNS regexes are deliberately NON-GLOBAL. A `/g` RegExp
 * carries `lastIndex` across `.test()` calls and yields intermittent false
 * negatives — exactly the failure that would re-open the leak class, since the
 * leak auditor calls {@link containsSecret} once per string in a loop. Only
 * `WHITESPACE` / `URL` are global, and they are only used with `.replace()`.
 */

/**
 * The one canonical redaction sentinel. Asserted across the conformance battery
 * byte-for-byte; do not change.
 */
export const REDACTED = "[redacted credential-like text]";

/**
 * Keyword-shaped triggers: a nearby word strongly implies a secret value is
 * present even when the value itself is unrecognizable. Kept specific — bare
 * ambiguous words like "secret"/"token"/"key" are deliberately NOT here because
 * they over-redact the recognition surface (that drops real anchors).
 *
 * ALL case-insensitive (`i`).
 */
const KEYWORD_PATTERNS: readonly RegExp[] = [
  /\bapi[_-]?keys?\b/i,
  /\bapi[_-]?tokens?\b/i,
  /\baccess[_-]?tokens?\b/i,
  /\brefresh[_-]?tokens?\b/i,
  /\bbearer\s+token\b/i,
  /\bservice[_-]?role\b/i,
  /\bclient[_-]?secret\b/i,
  /\bpassword\b/i,
  /\bpasswd\b/i,
  /\bstripe\s+(?:key|secret|token)\b/i,
  /\b(?:keystore|private[_-]?key|ssh[_-]?key)\b/i,
  /\.env\b/i,
];

/**
 * Value-shaped triggers: the literal token, no keyword needed. THESE are what
 * the pre-SSOT sets missed and what the audit flagged as the P0 leak class.
 *
 * Case-SENSITIVE except `appl_` (RevenueCat) and `hf_` (HuggingFace), which are
 * `i`. An over-eager `i` on a case-sensitive token pattern (AWS, Stripe,
 * GitHub) or a missing `i` on `appl_`/`hf_` is a parity break — the
 * `case_variants` battery probes each one.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{8,}\b/, // Stripe sk/pk/rk_live|test
  /\bappl_[A-Za-z0-9]{10,}\b/i, // RevenueCat
  /\bhf_[A-Za-z0-9]{10,}\b/i, // HuggingFace
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access-key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub PAT / OAuth / app
  /\bgithub_pat_[0-9A-Za-z_]{22,}\b/, // GitHub fine-grained PAT
  /\bglpat-[0-9A-Za-z_-]{20,}\b/, // GitLab PAT
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, // Slack
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/, // OpenAI / Anthropic
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}\b/, // Google OAuth token
  /\bnpm_[0-9A-Za-z]{36}\b/, // npm token
  // JWT (three base64url segments) — covers Supabase service_role / anon keys.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/, // PEM private key
];

/**
 * The full pattern set (keyword first, then token — order preserved from the
 * Python oracle). NON-GLOBAL by construction: safe to reuse across `.test()`.
 */
export const SENSITIVE_PATTERNS: readonly RegExp[] = [...KEYWORD_PATTERNS, ...TOKEN_PATTERNS];

const WHITESPACE = /\s+/g;
const URL = /https?:\/\/\S+/g;

/**
 * Return `true` if `value` matches any credential pattern. Used by surfaces
 * (e.g. the leak auditor) that gate on presence rather than transform in place.
 *
 * Empty/falsy short-circuits to `false`.
 */
export function containsSecret(value: string): boolean {
  if (!value) {
    return false;
  }
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Canonical scrub used by every surface that emits free-form memory text.
 *
 * Collapse whitespace, drop the whole string to {@link REDACTED} if it looks
 * like it contains a secret, strip URLs to `[link]`, then cap at `limit`
 * characters. Mirrors `redact_text` byte-for-byte (the `slice` tail reproduces
 * Python's `text[:limit-3].rstrip() + "..."` — trailing-whitespace strip only).
 *
 * @param value text to scrub
 * @param limit length cap (default 180; the recognition/benign surface uses 400)
 */
export function redactText(value: string, limit = 180): string {
  if (!value) {
    return value;
  }
  let text = value.trim().replace(WHITESPACE, " ");
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(text))) {
    return REDACTED;
  }
  text = text.replace(URL, "[link]");
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit - 3).replace(/\s+$/, "") + "...";
}
