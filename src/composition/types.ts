/** Types for pipeline composition from nf-core modules. */
import type { NfCoreModule } from "../modules/types.js";
import type { LocalToolSpec } from "./localModule.js";

export interface PlanStep {
  /** Module name in the registry, e.g. "fastqc" or "samtools/sort". */
  module: string;
  /** Why this step is in the pipeline, in biological/plain terms. */
  rationale: string;
}

export interface CompositionPlan {
  /** nf-core-style pipeline name: lowercase, alphanumeric, no spaces. */
  pipelineName: string;
  /** One-line description of what the composed pipeline does. */
  description: string;
  /** Ordered steps (the intended linear flow). */
  steps: PlanStep[];
}

/** A plan resolved against the registry: each step paired with its parsed module. */
export interface ResolvedComposition {
  plan: CompositionPlan;
  /** All modules to wire, nf-core and local (local ones carry local: true). */
  modules: NfCoreModule[];
  /** Pinned nf-core/modules commit the modules were taken from. */
  sha: string;
  /** Specs for any local (custom, non-nf-core) tools included in `modules`. */
  localTools?: LocalToolSpec[];
}
