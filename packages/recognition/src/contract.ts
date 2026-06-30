/**
 * Recognition contract — the single source of truth for the pieces of the
 * recognition DECISION that must agree byte-for-byte across every Bourdon
 * surface (claude-code / codex / cursor / this TS mirror).
 *
 * Ported from `core/recognition_contract.py`. Python is the oracle; this mirror
 * is conformant iff it reproduces the oracle's output on the shared
 * `conformance/recognition_vectors.json` fixtures. Do NOT paraphrase the
 * constants — they are transcribed literally from the oracle and pinned by the
 * fixtures.
 *
 * NB: `orchestrator.py`'s legacy substring `detect_entities` is the decoy
 * prototype and is intentionally NOT ported (see README).
 */

// ---------------------------------------------------------------------------
// Tokenizer — ASCII-alphanumeric runs. Punctuation, underscores, and hyphens
// split tokens. Lowercased, ORDER + DUPLICATES preserved (never a Set).
// ---------------------------------------------------------------------------

/** ASCII alphanumeric runs. Mirrors `TOKEN_RE = re.compile(r"[a-zA-Z0-9]+")`. */
export const TOKEN_RE = /[a-zA-Z0-9]+/g;

/**
 * Lowercased ASCII-alphanumeric tokens, in order, duplicates kept. The one
 * tokenizer every engine shares.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/[a-zA-Z0-9]+/g)) {
    out.push(m[0].toLowerCase());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stopwords + meaningful terms.
// ---------------------------------------------------------------------------

export const MIN_TERM_LEN = 3;

/** Canonical general-English stopwords (frozenset transcribed from the oracle). */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "again", "am", "an", "and", "anything", "are", "as", "at",
  "be", "can", "did", "do", "for", "from", "how", "i", "is", "it", "its",
  "keep", "like", "made", "make", "me", "new", "no", "now", "of", "ok",
  "okay", "on", "or", "our", "please", "should", "so", "some", "tell",
  "that", "the", "then", "there", "this", "to", "us", "want", "was", "we",
  "what", "whats", "when", "where", "which", "will", "with", "work",
  "worked", "working", "would", "yes", "you",
]);

/**
 * Codex-prompt-shaped words. The codex engine may union these in via
 * `extraStopwords`; they are NOT universal, so other surfaces must not treat
 * them as stopwords (e.g. "branch"/"pr" can be real anchors elsewhere).
 */
export const DOMAIN_STOPWORDS_CODEX: ReadonlySet<string> = new Set([
  "active", "approved", "branch", "codex", "pr", "remind", "restart",
]);

const EMPTY_STOPS: ReadonlySet<string> = new Set();

/**
 * Tokens that carry recognition signal: length >= MIN_TERM_LEN and not a
 * stopword. Applied SYMMETRICALLY to prompt-side and name-side. ORDER +
 * DUPLICATES preserved (returns a list, not a set).
 */
export function meaningfulTerms(
  text: string,
  extraStopwords: ReadonlySet<string> = EMPTY_STOPS,
): string[] {
  const seen: string[] = [];
  for (const tok of tokenize(text)) {
    if (tok.length >= MIN_TERM_LEN && !STOPWORDS.has(tok) && !extraStopwords.has(tok)) {
      seen.push(tok);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Match tier ladder (IntEnum → const object + numeric union; ordinals are
// load-bearing for `>=` and `Math.max`).
// ---------------------------------------------------------------------------

export const MatchTier = {
  NONE: 0,
  TOKEN_OVERLAP: 1, // some meaningful tokens shared, not contiguous
  TOKEN_SUBSEQUENCE: 2, // name tokens appear contiguously within the prompt
  NAME_SUBSTRING: 3, // name string is a substring of the prompt string
  EXACT: 4, // prompt equals the name (normalized)
} as const;

export type MatchTier = (typeof MatchTier)[keyof typeof MatchTier];

/** Reverse map: ordinal → IntEnum member name (the fixtures encode tiers by name). */
export const MATCH_TIER_NAME: Readonly<Record<MatchTier, string>> = {
  0: "NONE",
  1: "TOKEN_OVERLAP",
  2: "TOKEN_SUBSEQUENCE",
  3: "NAME_SUBSTRING",
  4: "EXACT",
};

/** Name → ordinal (for reading fixtures that encode a tier by its IntEnum name). */
export function tierFromName(name: string): MatchTier {
  const t = (MatchTier as Record<string, number>)[name];
  if (t === undefined) throw new Error(`unknown MatchTier name: ${name}`);
  return t as MatchTier;
}

/** True if `needle` appears as a contiguous run within `haystack`. */
export function containsSubsequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  const first = needle[0];
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (haystack[i] === first) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
  }
  return false;
}

/**
 * The match tier for a single candidate name against the prompt. Precedence:
 * EXACT > NAME_SUBSTRING (substring AND contiguous-token subsequence — the
 * short-name guard) > TOKEN_SUBSEQUENCE > TOKEN_OVERLAP > NONE.
 */
export function matchTier(
  prompt: string,
  name: string,
  extraStopwords: ReadonlySet<string> = EMPTY_STOPS,
): MatchTier {
  const pTokens = tokenize(prompt);
  const nTokens = tokenize(name);
  const pNorm = pTokens.join(" ");
  const nNorm = nTokens.join(" ");
  if (!nNorm) return MatchTier.NONE;
  if (pNorm === nNorm) return MatchTier.EXACT;
  // NAME_SUBSTRING gated on a whole-token subsequence so "ILTT" doesn't match
  // "ILTTed": the raw `in` test alone is the decoy; the token-boundary check
  // is the guard.
  if (pNorm.includes(nNorm)) {
    if (containsSubsequence(pTokens, nTokens)) return MatchTier.NAME_SUBSTRING;
  }
  if (containsSubsequence(pTokens, nTokens)) return MatchTier.TOKEN_SUBSEQUENCE;
  const pTerms = new Set(meaningfulTerms(prompt, extraStopwords));
  const nTerms = meaningfulTerms(name, extraStopwords);
  for (const t of nTerms) {
    if (pTerms.has(t)) return MatchTier.TOKEN_OVERLAP;
  }
  return MatchTier.NONE;
}

/** Strongest tier across a candidate's name + aliases + focus strings. */
export function bestMatchTier(
  prompt: string,
  names: string[],
  extraStopwords: ReadonlySet<string> = EMPTY_STOPS,
): MatchTier {
  let best: MatchTier = MatchTier.NONE;
  for (const name of names) {
    const tier = matchTier(prompt, name, extraStopwords);
    if (tier > best) best = tier;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Normalized confidence (0..1 score → bucket). The 0.45 and 0.80 boundaries are
// load-bearing; round BEFORE comparing to kill float-sum drift.
// ---------------------------------------------------------------------------

export type ConfidenceBucket = "none" | "low" | "medium" | "high";

const TIER_SCORE: Readonly<Record<MatchTier, number>> = {
  0: 0, // NONE — never reached (early return)
  1: 0.3, // TOKEN_OVERLAP
  2: 0.55, // TOKEN_SUBSEQUENCE
  3: 0.75, // NAME_SUBSTRING
  4: 0.9, // EXACT
};

export interface ConfidenceSignals {
  nAnchorTerms?: number;
  cwdHit?: boolean;
  recencyFresh?: boolean;
}

/**
 * Map a match into a surface-independent confidence bucket. Absent signals
 * never DEMOTE. `round(score, 4)` before bucketing avoids float-sum drift at
 * the 0.45 / 0.80 boundaries.
 */
export function normalizedConfidence(
  tier: MatchTier,
  signals: ConfidenceSignals = {},
): ConfidenceBucket {
  if (tier === MatchTier.NONE) return "none";
  const { nAnchorTerms = 1, cwdHit = false, recencyFresh = false } = signals;
  let score = TIER_SCORE[tier];
  if (tier === MatchTier.TOKEN_OVERLAP && nAnchorTerms >= 2) score += 0.15;
  if (cwdHit) score += 0.1;
  if (recencyFresh) score += 0.05;
  score = Math.round(score * 1e4) / 1e4; // avoid float-sum drift at boundaries
  if (score >= 0.8) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

/**
 * The shared confidence bucket for a recognized anchor — TIER-ONLY. Driven
 * SOLELY by the strongest match tier across name + aliases. Engine-specific
 * signals (recency, cross-agent, cwd) drive RANKING only; they never move the
 * emitted bucket, because other surfaces can't see them and parity requires
 * equality. Do NOT fold nAnchorTerms/cwd/recency in here.
 */
export function recognitionConfidence(prompt: string, names: string[]): ConfidenceBucket {
  return normalizedConfidence(bestMatchTier(prompt, names));
}

/**
 * Sort key for selecting the top anchor: strongest tier, then most recent, then
 * name ascending, then source ascending. Descending fields are negated so the
 * key sorts ascending (min-first) into the winner.
 */
export function topAnchorKey(
  tier: MatchTier,
  recencyOrdinal: number,
  name: string,
  source: string,
): [number, number, string, string] {
  return [-tier, -recencyOrdinal, name.toLowerCase(), source];
}

// ---------------------------------------------------------------------------
// Entity detection (mirrors core.recognition_runtime.detect_entities) + the
// recognition-string builder + the visibility filter. Kept in the contract so
// they share the tokenizer/ladder above.
// ---------------------------------------------------------------------------

export interface EntityDict {
  name?: unknown;
  type?: unknown;
  aliases?: unknown;
  tags?: unknown;
  valid_to?: unknown;
  visibility?: unknown;
  [k: string]: unknown;
}

export interface ManifestDict {
  known_entities?: unknown;
  recent_sessions?: unknown;
  [k: string]: unknown;
}

/**
 * Find entities from the manifest's `known_entities` mentioned in `userMsg`.
 *
 * Prefilter: a candidate whose token set is NOT a subset of the prompt's token
 * set can never reach the gate (sound necessary condition, never sufficient).
 * Gate: at least one prefiltered candidate must reach `>= TOKEN_SUBSEQUENCE` —
 * this carries the short-name guard ("ILTTed" never matches "ILTT"). The gate
 * uses default extra_stopwords (no codex domain stopwords).
 */
export function detectEntities(userMsg: string, manifest: unknown): EntityDict[] {
  if (!isPlainObject(manifest)) return [];
  const promptTokenSet = new Set(tokenize(userMsg));
  const matches: EntityDict[] = [];
  const known = (manifest as ManifestDict).known_entities;
  const entities = Array.isArray(known) ? known : [];
  for (const entity of entities) {
    if (!isPlainObject(entity)) continue;
    const e = entity as EntityDict;
    // Python: name = entity.get("name") or ""; if not isinstance(name,str): skip.
    // A truthy non-string name → skip; a falsy name → "".
    if (e.name && typeof e.name !== "string") continue;
    const resolvedName = typeof e.name === "string" ? e.name : "";
    const candidates: string[] = [resolvedName];
    const aliases = Array.isArray(e.aliases) ? e.aliases : [];
    for (const alias of aliases) {
      if (typeof alias === "string") candidates.push(alias);
    }
    const prefiltered = candidates.filter((c) => {
      const cTokens = new Set(tokenize(c));
      if (cTokens.size === 0) return false;
      for (const t of cTokens) if (!promptTokenSet.has(t)) return false;
      return true;
    });
    if (prefiltered.length === 0) continue;
    if (prefiltered.some((c) => matchTier(userMsg, c) >= MatchTier.TOKEN_SUBSEQUENCE)) {
      matches.push(e);
    }
  }
  return matches;
}

const END_OF_LIFE_TAGS: ReadonlySet<string> = new Set(["archived", "canceled"]);

function temporalSuffix(entity: EntityDict): string {
  const validTo = entity.valid_to;
  if (typeof validTo === "string" && validTo) return ` (archived ${validTo})`;
  const tags = entity.tags;
  if (Array.isArray(tags) && tags.some((t) => typeof t === "string" && END_OF_LIFE_TAGS.has(t))) {
    return " (archived)";
  }
  return "";
}

function singleMatchRecognition(entity: EntityDict): string {
  const name = String(entity.name || "this");
  const typeStr = entity.type || "";
  const suffix = temporalSuffix(entity);
  if (typeStr) return `Oh -- ${name}, the ${String(typeStr)}${suffix}.`;
  return `Oh -- ${name}${suffix}.`;
}

/**
 * Build the immediate recognition string from matched entities. Byte-identical
 * separators (literal " -- " double-hyphen, NOT em-dash; apostrophe in
 * "You're").
 */
export function buildRecognitionString(matches: EntityDict[]): string {
  if (matches.length === 0) return "";
  if (matches.length === 1) return singleMatchRecognition(matches[0] as EntityDict);
  const names = matches.map((e) => String(e.name || "?"));
  if (names.length === 2) {
    return `You're asking about ${names[0]} and ${names[1]} -- I have both.`;
  }
  const joined = names.slice(0, -1).join(", ") + `, and ${names[names.length - 1]}`;
  return `You're asking about ${joined} -- I have all of those.`;
}

// ---------------------------------------------------------------------------
// Visibility filter (core.codex_context.filter_manifest_for_access). Runs
// BEFORE detection so a private entity can never surface.
// ---------------------------------------------------------------------------

function normalizeVisibility(value: unknown): string {
  const normalized = String(value ?? "public").trim().toLowerCase();
  return normalized === "public" || normalized === "team" || normalized === "private"
    ? normalized
    : "public";
}

const VIS_RANK: Readonly<Record<string, number>> = { public: 0, team: 1, private: 2 };

function visibilityRank(value: unknown): number {
  return VIS_RANK[normalizeVisibility(value)] as number;
}

function isVisible(item: EntityDict, accessLevel: string): boolean {
  return visibilityRank(item.visibility) <= visibilityRank(accessLevel);
}

/** Filter sessions/entities to the requested visibility level. */
export function filterManifestForAccess(
  manifest: unknown,
  accessLevel = "team",
): ManifestDict {
  const data: ManifestDict = isPlainObject(manifest) ? (manifest as ManifestDict) : {};
  const filtered: ManifestDict = { ...data };
  const known = Array.isArray(data.known_entities) ? data.known_entities : [];
  filtered.known_entities = known.filter(
    (entity) => isPlainObject(entity) && isVisible(entity as EntityDict, accessLevel),
  );
  const sessions = Array.isArray(data.recent_sessions) ? data.recent_sessions : [];
  filtered.recent_sessions = sessions.filter(
    (session) => isPlainObject(session) && isVisible(session as EntityDict, accessLevel),
  );
  return filtered;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
