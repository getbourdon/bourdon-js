/**
 * @getbourdon/redaction — the credential-redaction SSOT + federation leak
 * auditor of Bourdon (BUSL-1.1). The security keystone of the TS mirror.
 *
 * A pattern that fires in the Python oracle but not here leaks a credential
 * across machines (the exact P0 keyword-less-secret class the SSOT closed —
 * AWS `AKIA`, GitHub `ghp_`, JWT/Supabase `service_role`, PEM keys). Python
 * (`pip install bourdon`) is the oracle; this mirror asserts byte-identical
 * `redactText` + boolean-identical `containsSecret` against
 * `conformance/redaction_battery.json`, and `[kind, location]`-identical
 * findings against `conformance/leak_cases.json`.
 */

// Redaction SSOT.
export { REDACTED, SENSITIVE_PATTERNS, containsSecret, redactText } from "./redaction.js";

// Leak auditor.
export {
  AUDIT_SCHEMA_VERSION,
  LeakKind,
  PRIVATE_TAG_FAMILIES,
  AuditReport,
  auditManifest,
  auditLibrary,
  findingToDict,
  type Finding,
} from "./leak-audit.js";
