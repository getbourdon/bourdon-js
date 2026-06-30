/**
 * L5 manifest validation — ajv (JSON Schema draft 2020-12) compiled over the
 * SAME schema/L5_schema.json the Python oracle uses (jsonschema
 * Draft202012Validator). Parity surface: `keyword` + `instancePath` (ajv-style
 * RFC6901 JSON Pointer). Messages differ between validators and are NOT asserted.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** The L5 JSON Schema object (loaded byte-faithfully from schema/L5_schema.json). */
export const l5Schema: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "schema", "L5_schema.json"), "utf8"),
) as Record<string, unknown>;

export interface ValidationError {
  keyword: string;
  /** ajv-style RFC6901 JSON Pointer: "" for root, "/agent/type", "/known_entities/0/visibility". */
  instancePath: string;
  message?: string;
  schemaPath?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// `strict: false` keeps ajv from rejecting the schema's annotation keywords
// (examples, etc.); it does not relax validation of the data itself.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateFn = ajv.compile(l5Schema);

/** Validate a candidate L5 manifest. Returns `{valid, errors}` (never throws). */
export function validateManifest(data: unknown): ValidationResult {
  const valid = validateFn(data) as boolean;
  const errors: ValidationError[] = (validateFn.errors ?? []).map((e) => ({
    keyword: e.keyword,
    instancePath: e.instancePath,
    message: e.message,
    schemaPath: e.schemaPath,
  }));
  // ajv stores errors on the shared validator; clear so calls don't leak.
  validateFn.errors = null;
  return { valid, errors };
}
