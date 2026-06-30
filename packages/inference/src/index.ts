/**
 * @getbourdon/inference — the Bourdon inference layer (BUSL-1.1).
 *
 * The backend-neutral {@link InferenceBackend} protocol, the llama.cpp SSE
 * backend, L2 episodic retrieval (never blocks / never raises), and the
 * codex/cursor turn compilers (verbatim scoring magic numbers + exact
 * SCHEMA_VERSION strings). Python (`pip install bourdon`) is the oracle; the turn
 * compilers assert against `conformance/turn_compiler_vectors.json`.
 */

// Backend-neutral protocol.
export {
  BackendCapabilities,
  BackendUnsupported,
  registerBackend,
  type CapabilityName,
  type InferenceBackend,
  type Slot,
} from "./inference-protocol.js";

// llama.cpp SSE backend.
export {
  DEFAULT_BASE_URL,
  DEFAULT_CONCURRENT_SLOTS,
  DEFAULT_REQUEST_TIMEOUT,
  LlamaCppBackend,
  parseSseLine,
  type LlamaCppBackendOptions,
} from "./llama-backend.js";

// L2 episodic retrieval.
export {
  DEFAULT_CONFIG_PATH,
  FastMCPL2Client,
  L2Config,
  formatL2Context,
  parseBool,
  queryL2,
  type L2Client,
  type L2ConfigData,
} from "./l2.js";

// Codex turn compiler.
export {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ITEMS,
  MAX_PROMPT_CHARS,
  SCHEMA_VERSION as CODEX_SCHEMA_VERSION,
  STRATEGY,
  compileCodexTurn,
  turnBriefToDict,
  turnBriefToJson,
  turnBriefToYaml,
  type BriefHealth,
  type BriefItem,
  type CompileCodexTurnOptions,
  type RepoIdentity,
  type TurnBrief,
} from "./codex-turn-compiler.js";

// Cursor turn compiler.
export {
  MAX_ITEMS_CEILING,
  SCHEMA_VERSION as CURSOR_SCHEMA_VERSION,
  compileCursorTurn,
  cursorBriefToText,
  type CompileCursorTurnOptions,
  type CursorTurnBrief,
} from "./cursor-turn-compiler.js";

// Codex context (pure transform).
export {
  buildL0Payload,
  buildL1Documents,
  filterManifestForAccess,
  slugify,
  writeCodexContextArtifacts,
} from "./codex-context.js";

// Codex native-state helpers.
export {
  collectLightweightSessionRecords,
  dateFromStateTimestamp,
  inspectCodexStateDb,
  resolveCodexHome,
  safeNativeMemoryText,
} from "./codex-state.js";
