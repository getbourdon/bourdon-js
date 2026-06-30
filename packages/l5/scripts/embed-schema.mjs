// Emits src/schema.gen.ts from the byte-faithful schema/L5_schema.json so the
// validator can bundle the schema into both ESM and CJS outputs without any
// runtime path resolution (import.meta.url is unavailable in the CJS build).
// Generated — do NOT edit src/schema.gen.ts by hand.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "schema", "L5_schema.json");
const outPath = resolve(here, "..", "src", "schema.gen.ts");

// Re-serialize via JSON.parse/stringify so the embedded object is structurally
// identical to the schema (validation uses the object; byte-identity to the
// oracle is asserted separately against schema/L5_schema.json).
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const banner =
  "/* GENERATED from schema/L5_schema.json via scripts/embed-schema.mjs. Do NOT edit by hand. */\n";
const body = `const l5Schema = ${JSON.stringify(schema, null, 2)} as const;\nexport default l5Schema;\n`;
writeFileSync(outPath, banner + body, "utf8");
console.log(`wrote ${outPath}`);
