/**
 * `audit-leaks` — static scan of published L5 manifests for credential +
 * visibility leaks. Read-only. Backed by @getbourdon/redaction's leak auditor.
 * Exit 1 if `--require-files` and zero manifests were scanned, or if findings
 * exist and `--strict`.
 */

import { auditLibrary } from "@getbourdon/redaction";

import { DEFAULT_LIBRARY_PATH } from "@getbourdon/federation";

import { type Dict, printYaml, writeYamlIfRequested } from "../util.js";

export function handleAuditLeaks(opts: Dict, _args: string[]): number {
  const library = opts.library ? String(opts.library) : DEFAULT_LIBRARY_PATH;
  const report = auditLibrary(library);
  const full = report.toDict();
  const data: Dict = opts.summary
    ? Object.fromEntries(Object.entries(full).filter(([k]) => k !== "findings"))
    : (full as unknown as Dict);
  writeYamlIfRequested(data, opts.reportOut as string | undefined);
  printYaml(data);

  if (opts.requireFiles && report.filesScanned === 0) {
    process.stderr.write(
      `audit leaks: no manifests found under ${library} (--require-files): ` +
        "nothing was actually scanned.\n",
    );
    return 1;
  }
  if (!report.clean) {
    process.stderr.write(
      `audit leaks: ${report.findings.length} finding(s) across ${report.filesScanned} ` +
        `manifest(s) in ${library}\n`,
    );
    if (opts.strict) return 1;
  }
  return 0;
}
