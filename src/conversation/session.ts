/** Conversational session state (in memory; no persistence in Phase 1). */
import type { PipelineDefinition } from "../pipelines/types.js";
import type { ContainerEngine } from "../config/types.js";
import type { ExecutorSettings } from "../execution/executor.js";
import type { FastqPair } from "../execution/samplesheet.js";
import type { DesignReview } from "./designReview.js";

export type Phase =
  | "intent" // Phase A — understand the intent
  | "select" // Phase B — pipeline selection
  | "compose" // Phase F4 — compose a pipeline from nf-core modules
  | "params" // Phase C — parameterization
  | "confirm" // Phase D — confirmation
  | "execute" // Phase D — execution
  | "results" // Phase E — interpretation
  | "done";

export const PHASE_LABEL: Record<Phase, string> = {
  intent: "A · Understand the intent",
  select: "B · Pipeline selection",
  compose: "F4 · Composing from nf-core modules",
  params: "C · Parameterization",
  confirm: "D · Confirmation",
  execute: "D · Execution",
  results: "E · Results interpretation",
  done: "Done",
};

/** Biological context of the query, filled in during Phase A. */
export interface QueryContext {
  organism?: string;
  dataType?: string;
  objective?: string;
  experimentalDesign?: string;
}

export interface Session {
  phase: Phase;
  /** Plain-language turn history (to give the LLM context). */
  transcript: Array<{ role: "user" | "agent"; text: string }>;
  query: QueryContext;
  selectedPipeline?: PipelineDefinition;
  /** Resolved parameter values (without the "--" prefix). */
  paramValues: Record<string, string | number | boolean>;
  /** Whether the test profile will be used (auto-provides input and references). */
  useTestProfile: boolean;
  /** Path to the generated samplesheet, if any. */
  samplesheetPath?: string;
  /**
   * FASTQ pairs downloaded from public accessions when fetchngs couldn't emit a
   * samplesheet in the target pipeline's shape (e.g. sarek). Phase C builds the
   * proper samplesheet from these, asking the pipeline-specific columns.
   */
  fetchedPairs?: FastqPair[];
  /** Final `nextflow run ...` command as an argument list. */
  command?: string[];
  /** Resolved output directory. */
  outdir?: string;
  /** Run directory (cwd for Nextflow; holds params.yaml and samplesheet). */
  runDir?: string;
  /** Path to the generated -params-file (params.yaml). */
  paramsFile?: string;
  /** Execution backend chosen interactively (overrides the configured one). */
  engine?: ContainerEngine;
  /** Executor (where jobs run) chosen interactively. */
  executor?: ExecutorSettings;
  /** Path to the generated executor `-c` config, when not local. */
  executorConfigPath?: string;
  /** Extra environment for the Nextflow process (e.g. image cache dirs). */
  runEnv?: Record<string, string>;
  /** Experimental-design review from Phase 6, carried into results interpretation. */
  designReview?: DesignReview;
}

export function createSession(): Session {
  return {
    phase: "intent",
    transcript: [],
    query: {},
    paramValues: {},
    useTestProfile: false,
  };
}

/** Signal used by /reset to restart the conversation from the CLI. */
export class ResetSignal extends Error {
  constructor() {
    super("reset");
    this.name = "ResetSignal";
  }
}

/** Signal used by /exit or EOF to terminate the program cleanly. */
export class ExitSignal extends Error {
  constructor() {
    super("exit");
    this.name = "ExitSignal";
  }
}
