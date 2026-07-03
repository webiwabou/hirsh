/** Pipeline registry types. */

export type ParamType = "string" | "number" | "boolean" | "enum" | "path";

export interface PipelineParam {
  /** Flag name without "--", e.g. "genome". */
  name: string;
  type: ParamType;
  required: boolean;
  /** Proposed default value (for optional params or suggestions). */
  default?: string | number | boolean;
  /** Plain-language explanation: this is what the LLM uses to know what to ask. */
  description: string;
  /** Valid options when type === "enum". */
  choices?: string[];
  /**
   * If the param is covered by building the samplesheet (e.g. "input"), mark it
   * here so it is not asked as a free-form field in Phase C.
   */
  providedBySamplesheet?: boolean;
}

export interface SamplesheetColumn {
  name: string;
  required: boolean;
  description: string;
}

export interface SamplesheetSpec {
  filename: string;
  description: string;
  columns: SamplesheetColumn[];
}

export interface ResultOutput {
  /** Path relative to outdir. */
  path: string;
  description: string;
  /** Type for the Phase E results interpreter. */
  kind: "multiqc_html" | "table" | "vcf_dir" | "directory";
}

export interface PipelineDefinition {
  /** nf-core identifier, e.g. "nf-core/rnaseq". */
  name: string;
  /** Pinned revision passed to `-r`, e.g. "3.14.0". */
  version: string;
  /** Primary citation for the pipeline, for publication-ready methods. */
  citation?: { text: string; doi?: string };
  /** Short human-readable title. */
  title: string;
  /** Which biological question it answers (key for the LLM's semantic matching). */
  purpose: string;
  /** Intent hints to help pipeline selection. */
  useWhen: string[];
  /** Free-form description of typical organisms. */
  organisms: string;
  /** Expected data/sequencing type. */
  dataType: string;
  samplesheet: SamplesheetSpec;
  params: PipelineParam[];
  profiles: {
    /** Recommended container profile ("docker" | "singularity"). */
    recommended: string;
    hasTestProfile: boolean;
    /** Test profile name, e.g. "test". Auto-provides input and references. */
    testProfile?: string;
  };
  /**
   * Rough resource guidance for REAL runs (ignored for the test profile).
   * Used by the resource-awareness pre-flight in Phase D.
   */
  resources?: {
    recommendedMemoryGB?: number;
    minMemoryGB?: number;
    recommendedCpus?: number;
    /** Rough container/conda image footprint (GB), for disk-pressure checks. */
    imageFootprintGB?: number;
    /**
     * Heavy steps for the per-process pre-flight model. When present, Hirsh can
     * name which step won't fit and whether it can be capped or has a hard floor.
     */
    processes?: Array<{
      name: string;
      memoryGB: number;
      cpus?: number;
      note?: string;
      cappable?: boolean;
      /** Params whose presence skips this step (e.g. a prebuilt index). */
      skipIfParams?: string[];
    }>;
  };
  results: {
    /** Name of the param that defines the output directory (usually "outdir"). */
    outdirParam: string;
    outputs: ResultOutput[];
  };
  /**
   * Optional natural next analysis step, surfaced to the user (this pipeline's
   * output is the next one's input). E.g. rnaseq (counts) → differentialabundance
   * (differentially expressed genes). We suggest, and — when the spec below is
   * runnable — offer to run it directly (always with confirmation, never silently).
   */
  followUp?: FollowUpSpec;
}

export interface FollowUpInput {
  /** Follow-up param name (without "--"). */
  name: string;
  /** Plain-language prompt shown when asking the user for it. */
  description: string;
  /** When true, the run can proceed without it. */
  optional?: boolean;
}

export interface FollowUpSpec {
  pipeline: string;
  /** When this follow-up is relevant, in plain terms. */
  when: string;
  /** What the follow-up does with this pipeline's output. */
  note: string;
  /**
   * Pinned revision. Its presence marks the follow-up as *runnable*: Hirsh can
   * offer to launch it, not just suggest it. Without it, it stays a suggestion.
   */
  revision?: string;
  /**
   * Follow-up params sourced from this pipeline's outputs: param name → path
   * relative to the upstream outdir (e.g. matrix → star_salmon/salmon.merged.gene_counts.tsv).
   */
  inputsFromUpstream?: Record<string, string>;
  /** Follow-up params carried over from this run's params when set (e.g. gtf). */
  carryParams?: string[];
  /** Extra inputs Hirsh must ask the user for (paths/values). */
  requiredInputs?: FollowUpInput[];
}
