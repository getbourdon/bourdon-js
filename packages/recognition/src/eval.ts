/**
 * Recognition evaluation harness — ported from `core/recognition_eval.py`.
 *
 * Scores a labeled golden dataset for precision/recall/F1 against ground truth,
 * plus latency percentiles. Pure + synchronous (recognition is synchronous by
 * design); the optional lazy hydration thunk is simply discarded rather than
 * invoked. Never raises on a single bad case — an errored case is scored as a
 * miss so one malformed row can't sink the run.
 */

import { recognitionFirst } from "./runtime.js";

export const EVAL_SCHEMA_VERSION = "recognition-eval/v1";

export interface EvalCase {
  id: string;
  prompt: string;
  manifest: Record<string, unknown>;
  expectedEntities: string[];
  expectedConfidence: string | null;
  accessLevel: string;
}

export interface CaseResult {
  id: string;
  prompt: string;
  expected: string[];
  matched: string[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  recognitionLatencyUs: number;
  confidence: string;
  expectedConfidence: string | null;
  confidenceOk: boolean | null;
  error: string | null;
}

export interface EvalReport {
  schemaVersion: string;
  nCases: number;
  microPrecision: number;
  microRecall: number;
  microF1: number;
  macroF1: number;
  latencyP50Us: number;
  latencyP95Us: number;
  confidenceAccuracy: number | null;
  nErrors: number;
  cases: CaseResult[];
}

/**
 * Set-based TP/FP/FN + precision/recall/F1 for one case. Case-insensitive on
 * names. The empty/empty case (a negative control that correctly matched
 * nothing) scores a perfect 1.0 on all three — "correctly recognized nothing"
 * is success, not undefined.
 */
export function scoreSets(
  expected: Set<string>,
  matched: Set<string>,
): {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
} {
  const exp = new Set([...expected].map((e) => e.toLowerCase()));
  const mat = new Set([...matched].map((m) => m.toLowerCase()));
  let tp = 0;
  for (const m of mat) if (exp.has(m)) tp++;
  const fp = mat.size - tp;
  let fn = 0;
  for (const e of exp) if (!mat.has(e)) fn++;
  if (exp.size === 0 && mat.size === 0) {
    return { tp: 0, fp: 0, fn: 0, precision: 1.0, recall: 1.0, f1: 1.0 };
  }
  const precision = tp + fp ? tp / (tp + fp) : 0.0;
  const recall = tp + fn ? tp / (tp + fn) : 0.0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0.0;
  return { tp, fp, fn, precision, recall, f1 };
}

/** Run one case through `recognitionFirst` and score it. Never throws. */
export function runCase(c: EvalCase): CaseResult {
  try {
    const t0 = performance.now();
    const result = recognitionFirst(c.prompt, c.manifest, { accessLevel: c.accessLevel });
    const latencyUs = (performance.now() - t0) * 1_000;
    // We score recognition, not hydration: discard the lazy thunk (never invoked).

    const matched = result.matchedEntities
      .map((e) => String(e.name ?? ""))
      .filter((m) => m);
    const { tp, fp, fn, precision, recall, f1 } = scoreSets(
      new Set(c.expectedEntities),
      new Set(matched),
    );

    const confidenceOk =
      c.expectedConfidence !== null ? result.confidence === c.expectedConfidence : null;

    return {
      id: c.id,
      prompt: c.prompt,
      expected: c.expectedEntities,
      matched,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision,
      recall,
      f1,
      recognitionLatencyUs: latencyUs,
      confidence: result.confidence,
      expectedConfidence: c.expectedConfidence,
      confidenceOk,
      error: null,
    };
  } catch (exc) {
    const nExp = c.expectedEntities.length;
    return {
      id: c.id,
      prompt: c.prompt,
      expected: c.expectedEntities,
      matched: [],
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: nExp,
      precision: 0.0,
      recall: nExp ? 0.0 : 1.0,
      f1: 0.0,
      recognitionLatencyUs: 0.0,
      confidence: "none",
      expectedConfidence: c.expectedConfidence,
      confidenceOk: null,
      error: String(exc),
    };
  }
}

/** Nearest-rank (interpolated) percentile of an already-sorted list. 0.0 when empty. */
export function percentile(sortedValues: number[], pct: number): number {
  if (sortedValues.length === 0) return 0.0;
  if (sortedValues.length === 1) return sortedValues[0] as number;
  const k = (pct / 100) * (sortedValues.length - 1);
  const lo = Math.trunc(k);
  const hi = Math.min(lo + 1, sortedValues.length - 1);
  const frac = k - lo;
  const loV = sortedValues[lo] as number;
  const hiV = sortedValues[hi] as number;
  return loV + (hiV - loV) * frac;
}

/** Run all cases and aggregate into a report. */
export function runEval(cases: EvalCase[]): EvalReport {
  const results = cases.map((c) => runCase(c));
  const n = results.length;

  const totalTp = results.reduce((s, r) => s + r.truePositives, 0);
  const totalFp = results.reduce((s, r) => s + r.falsePositives, 0);
  const totalFn = results.reduce((s, r) => s + r.falseNegatives, 0);
  const microP = totalTp + totalFp ? totalTp / (totalTp + totalFp) : 1.0;
  const microR = totalTp + totalFn ? totalTp / (totalTp + totalFn) : 1.0;
  const microF1 = microP + microR ? (2 * microP * microR) / (microP + microR) : 0.0;

  const macroF1 = results.length
    ? results.reduce((s, r) => s + r.f1, 0) / results.length
    : 0.0;

  const latencies = results
    .filter((r) => r.error === null)
    .map((r) => r.recognitionLatencyUs)
    .sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  const confChecked = results.filter((r) => r.confidenceOk !== null);
  const confAcc = confChecked.length
    ? confChecked.filter((r) => r.confidenceOk).length / confChecked.length
    : null;

  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    nCases: n,
    microPrecision: microP,
    microRecall: microR,
    microF1,
    macroF1,
    latencyP50Us: p50,
    latencyP95Us: p95,
    confidenceAccuracy: confAcc,
    nErrors: results.filter((r) => r.error !== null).length,
    cases: results,
  };
}

/** True if the report clears the given CI thresholds. */
export function meets(
  report: EvalReport,
  opts: { minMicroF1?: number; minMacroF1?: number; maxP95Us?: number | null } = {},
): boolean {
  const { minMicroF1 = 0.0, minMacroF1 = 0.0, maxP95Us = null } = opts;
  if (report.microF1 < minMicroF1) return false;
  if (report.macroF1 < minMacroF1) return false;
  if (maxP95Us !== null && report.latencyP95Us > maxP95Us) return false;
  return true;
}

interface RawCase {
  id?: unknown;
  prompt?: unknown;
  manifest?: unknown;
  expected_entities?: unknown;
  expected_confidence?: unknown;
  access_level?: unknown;
}

/** Build an EvalCase from a raw mapping (parsed YAML row). Fails loud. */
export function caseFromRaw(raw: unknown): EvalCase {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`case must be a mapping, got ${raw === null ? "null" : typeof raw}`);
  }
  const r = raw as RawCase;
  const cid = String(r.id ?? "").trim();
  if (!cid) throw new Error("case missing required 'id'");
  if (!("prompt" in r)) throw new Error(`case '${cid}' missing required 'prompt'`);
  const manifest = r.manifest ?? {};
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(`case '${cid}': 'manifest' must be a mapping`);
  }
  const expected = r.expected_entities ?? [];
  if (!Array.isArray(expected)) {
    throw new Error(`case '${cid}': 'expected_entities' must be a list`);
  }
  return {
    id: cid,
    prompt: String(r.prompt),
    manifest: manifest as Record<string, unknown>,
    expectedEntities: expected.map((e) => String(e)),
    expectedConfidence:
      r.expected_confidence != null ? String(r.expected_confidence) : null,
    accessLevel: String(r.access_level ?? "team"),
  };
}

/**
 * Load a golden dataset (parsed YAML root) into EvalCase objects. Raises on a
 * malformed dataset (fail loud at load time) — including duplicate ids.
 */
export function loadCases(raw: unknown): EvalCase[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("top level must be a mapping");
  }
  const casesRaw = (raw as { cases?: unknown }).cases;
  if (!Array.isArray(casesRaw) || casesRaw.length === 0) {
    throw new Error("'cases' must be a non-empty list");
  }
  const cases = casesRaw.map((c) => caseFromRaw(c));
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate case id '${c.id}'`);
    seen.add(c.id);
  }
  return cases;
}
