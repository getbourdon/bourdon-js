/**
 * @getbourdon/recognition — the recognition timing core of Bourdon (BUSL-1.1).
 *
 * Recognition-FIRST: a synchronous, no-I/O recognition string emitted in ~0ms,
 * with L1 hydration as a lazy thunk that never blocks the first response and
 * never raises. Python (`pip install bourdon`) is the oracle; this mirror is the
 * 4th parity engine, asserting against `conformance/recognition_vectors.json`.
 *
 * NB: `orchestrator.py`'s legacy substring `detect_entities` is the decoy
 * prototype and is intentionally NOT ported.
 */

// Contract SSOT.
export {
  TOKEN_RE,
  tokenize,
  MIN_TERM_LEN,
  STOPWORDS,
  DOMAIN_STOPWORDS_CODEX,
  meaningfulTerms,
  MatchTier,
  MATCH_TIER_NAME,
  tierFromName,
  containsSubsequence,
  matchTier,
  bestMatchTier,
  normalizedConfidence,
  recognitionConfidence,
  topAnchorKey,
  detectEntities,
  buildRecognitionString,
  filterManifestForAccess,
  type ConfidenceBucket,
  type ConfidenceSignals,
  type EntityDict,
  type ManifestDict,
} from "./contract.js";

// Runtime.
export {
  DEFAULT_HYDRATION_TIMEOUT,
  hydrateL1,
  recognitionFirst,
  interruptFirst,
  type RecognitionResult,
  type RecognitionOptions,
  type InferenceBackend,
} from "./runtime.js";

// Eval harness.
export {
  EVAL_SCHEMA_VERSION,
  scoreSets,
  runCase,
  percentile,
  runEval,
  meets,
  caseFromRaw,
  loadCases,
  type EvalCase,
  type CaseResult,
  type EvalReport,
} from "./eval.js";
