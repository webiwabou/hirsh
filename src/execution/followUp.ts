/**
 * Follow-up pipeline chaining (Phase 2 — "the DE gap").
 *
 * A real analysis rarely ends at one pipeline: rnaseq produces count matrices,
 * and the scientist's actual question ("which genes are differentially
 * expressed?") is answered by nf-core/differentialabundance run on those counts.
 * A pipeline can declare a runnable `followUp`; Hirsh then offers to launch it
 * directly, wiring the upstream outputs into the follow-up's inputs — always with
 * confirmation, never a silent auto-chain.
 *
 * These helpers are pure (spec + paths in, resolved inputs / command out) so they
 * can be unit-tested; the state machine drives the interactive run.
 */
import { isAbsolute, join, resolve } from "node:path";
import type { FollowUpSpec } from "../pipelines/types.js";

/**
 * Whether a follow-up can actually be run (not just suggested). A pinned
 * revision is the marker — without it we lack the information to launch it.
 */
export function isRunnableFollowUp(followUp: FollowUpSpec | undefined): followUp is FollowUpSpec {
  return !!followUp && typeof followUp.revision === "string" && followUp.revision.trim() !== "";
}

/**
 * Resolves the follow-up params sourced from the upstream run to absolute paths.
 * Relative entries are joined onto the upstream outdir; absolute ones are kept.
 * Existence is checked by the caller (so this stays pure).
 */
export function upstreamInputPaths(
  spec: FollowUpSpec,
  upstreamOutdir: string,
): Record<string, string> {
  const base = resolve(upstreamOutdir);
  const out: Record<string, string> = {};
  for (const [param, rel] of Object.entries(spec.inputsFromUpstream ?? {})) {
    out[param] = isAbsolute(rel) ? rel : join(base, rel);
  }
  return out;
}

export interface FollowUpCommandOptions {
  pipeline: string;
  revision: string;
  engine: string;
  paramsFile: string;
  extraConfigs?: string[];
}

/** Builds the `nextflow run <followUp> …` argument list (real data; -params-file). */
export function buildFollowUpCommand(o: FollowUpCommandOptions): string[] {
  const args = [
    "run",
    o.pipeline,
    "-r",
    o.revision,
    "-profile",
    o.engine,
    "-params-file",
    o.paramsFile,
  ];
  for (const cfg of o.extraConfigs ?? []) args.push("-c", cfg);
  return args;
}
