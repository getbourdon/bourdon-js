/**
 * `recognition eval` — score recognition against a labeled golden dataset
 * (precision / recall / F1). Exit 2 on a load failure, 1 when below the
 * configured CI thresholds. Backed by the ported @getbourdon/recognition eval
 * harness.
 *
 * NB: the Python CLI ships a bundled `recognition_golden_v1.yaml`; the TS
 * distribution does not embed it, so `--dataset` is required here — invoking
 * without one is treated as a load failure (exit 2), which is honest about the
 * missing bundled fixture rather than silently scoring zero cases.
 */

import { readFileSync } from "node:fs";

import {
  type CaseResult,
  type EvalReport,
  loadCases,
  meets,
  runEval,
} from "@getbourdon/recognition";
import { parse as yamlParse } from "yaml";

import { type Dict, printYaml, writeYamlIfRequested } from "../util.js";

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function caseToDict(c: CaseResult): Dict {
  const out: Dict = {
    id: c.id,
    prompt: c.prompt,
    expected: c.expected,
    matched: c.matched,
    tp: c.truePositives,
    fp: c.falsePositives,
    fn: c.falseNegatives,
    precision: round(c.precision, 3),
    recall: round(c.recall, 3),
    f1: round(c.f1, 3),
    recognition_latency_us: round(c.recognitionLatencyUs, 1),
    confidence: c.confidence,
  };
  if (c.expectedConfidence !== null) out.expected_confidence = c.expectedConfidence;
  if (c.confidenceOk !== null) out.confidence_ok = c.confidenceOk;
  if (c.error !== null) out.error = c.error;
  return out;
}

function reportToDict(report: EvalReport, summary: boolean): Dict {
  const out: Dict = {
    schema_version: report.schemaVersion,
    n_cases: report.nCases,
    n_errors: report.nErrors,
    micro_precision: round(report.microPrecision, 3),
    micro_recall: round(report.microRecall, 3),
    micro_f1: round(report.microF1, 3),
    macro_f1: round(report.macroF1, 3),
    latency_p50_us: round(report.latencyP50Us, 1),
    latency_p95_us: round(report.latencyP95Us, 1),
  };
  if (report.confidenceAccuracy !== null) {
    out.confidence_accuracy = round(report.confidenceAccuracy, 3);
  }
  if (!summary) out.cases = report.cases.map(caseToDict);
  return out;
}

export function handleRecognitionEval(opts: Dict, _args: string[]): number {
  const dataset = opts.dataset as string | undefined;
  if (!dataset) {
    process.stderr.write(
      "recognition eval: cannot load <bundled golden>: no --dataset given and the " +
        "TS CLI does not embed recognition_golden_v1.yaml (pip install bourdon ships it).\n",
    );
    return 2;
  }
  let cases;
  try {
    cases = loadCases(yamlParse(readFileSync(dataset, "utf8")));
  } catch (exc) {
    process.stderr.write(`recognition eval: cannot load ${dataset}: ${String(exc)}\n`);
    return 2;
  }

  const report = runEval(cases);
  const data = reportToDict(report, Boolean(opts.summary));
  writeYamlIfRequested(data, opts.reportOut as string | undefined);
  printYaml(data);

  const passed = meets(report, {
    minMicroF1: Number(opts.minMicroF1 ?? 0.0) || 0.0,
    minMacroF1: Number(opts.minMacroF1 ?? 0.0) || 0.0,
    maxP95Us: opts.maxP95Us != null ? Number(opts.maxP95Us) : null,
  });
  if (!passed) {
    process.stderr.write(
      `recognition eval: FAILED thresholds (micro_f1=${report.microF1.toFixed(3)}, ` +
        `macro_f1=${report.macroF1.toFixed(3)}, p95=${report.latencyP95Us.toFixed(0)}us)\n`,
    );
    return 1;
  }
  return 0;
}
