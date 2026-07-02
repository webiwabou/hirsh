/** Types for pipeline composition from nf-core modules. */
import type { NfCoreModule } from "../modules/types.js";

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
  modules: NfCoreModule[];
  /** Pinned nf-core/modules commit the modules were taken from. */
  sha: string;
}
