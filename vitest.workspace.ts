import { defineWorkspace } from "vitest/config";

// Each package's tests run under the workspace. Parity/conformance specs load the
// language-neutral fixtures from the Python oracle (BOURDON_CONFORMANCE_DIR, default
// ../bourdon/conformance) so both implementations assert against the same bytes.
export default defineWorkspace(["packages/*"]);
