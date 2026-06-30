/**
 * `prepare-turn`, `deeper-context`, and `codex compile-turn` — the
 * recognition-context surface. All three delegate to ported engine packages
 * (@getbourdon/federation + @getbourdon/mcp-server + @getbourdon/inference).
 */

import { DEFAULT_LIBRARY_PATH, L6Store } from "@getbourdon/federation";
import {
  compileCodexTurnFromStore,
  getDeeperContextForPrompt,
  prepareRecognitionContextFromStore,
} from "@getbourdon/mcp-server";

import { type Dict, printYaml, writeYamlIfRequested } from "../util.js";

/** `prepare-turn <prompt>` — L6 recognition context for a prompt. */
export function handlePrepareTurn(opts: Dict, args: string[]): number {
  const prompt = String(args[0] ?? "");
  const library = opts.library ? String(opts.library) : DEFAULT_LIBRARY_PATH;
  const accessLevel = String(opts.accessLevel ?? "team");
  const store = new L6Store(library);
  const report = prepareRecognitionContextFromStore(store, prompt, accessLevel);
  writeYamlIfRequested(report, opts.reportOut as string | undefined);
  printYaml(report);
  return 0;
}

/** `deeper-context <prompt>` — post-recognition L2 context (never raises → ""). */
export function handleDeeperContext(opts: Dict, args: string[]): number {
  const prompt = String(args[0] ?? "");
  const accessLevel = String(opts.accessLevel ?? "team");
  const report = getDeeperContextForPrompt(prompt, accessLevel);
  writeYamlIfRequested(report, opts.reportOut as string | undefined);
  printYaml(report);
  return 0;
}

/** `codex compile-turn <prompt>` — turn-scoped Codex brief via the ported
 * @getbourdon/inference turn compiler. */
export function handleCodexCompileTurn(opts: Dict, args: string[]): number {
  const prompt = String(args[0] ?? "");
  const library = opts.libraryPath ? String(opts.libraryPath) : DEFAULT_LIBRARY_PATH;
  const store = new L6Store(library);
  const report = compileCodexTurnFromStore(store, prompt, {
    cwd: (opts.cwd as string | undefined) ?? null,
    accessLevel: String(opts.accessLevel ?? "team"),
    maxItems: Number(opts.maxItems ?? 6),
    maxChars: Number(opts.maxChars ?? 1800),
  });
  writeYamlIfRequested(report, opts.reportOut as string | undefined);
  printYaml(report);
  return 0;
}
