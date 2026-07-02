/** Hirsh configuration types. */

export type ProviderName = "ollama" | "anthropic";
/**
 * Execution backend for Nextflow. "docker"/"singularity" are container engines;
 * "conda"/"mamba" resolve tools into environments instead of containers. Each
 * maps to the matching nf-core profile name.
 */
export type ContainerEngine = "docker" | "singularity" | "conda" | "mamba";

export interface OllamaConfig {
  host: string;
  model: string;
  temperature: number;
}

export interface AnthropicConfig {
  /** Name of the environment variable holding the API key. */
  apiKeyEnv: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Where Nextflow submits jobs. "local" runs on this machine; the others hand
 * scheduling to an HPC scheduler or the cloud via the matching Nextflow executor.
 */
export type ExecutorName = "local" | "slurm" | "sge" | "lsf" | "pbs" | "awsbatch";

export interface ExecutionConfig {
  containerEngine: ContainerEngine;
  /** Job scheduler / execution backend. Defaults to "local". */
  executor?: ExecutorName;
  /** Default queue/partition for cluster executors. */
  queue?: string;
  /** Base directory where pipelines are launched. */
  workdir: string;
  /** Optional CPU cap for runs (overrides detected machine as the budget). */
  maxCpus?: number;
  /** Optional memory cap for runs, nf-core style e.g. "30.GB". */
  maxMemory?: string;
}

export interface MemoryConfig {
  /** Remember analyses across sessions (stored locally, private). */
  enabled: boolean;
  /** Override the memory file location. */
  path?: string;
}

export interface AutonomyConfig {
  /**
   * Run to an interpreted answer without pausing for reversible confirmations;
   * still asks for missing info and stops at consequential decisions
   * (publishing, spending, overriding a safety recommendation).
   */
  enabled: boolean;
}

export interface HirshConfig {
  provider: ProviderName;
  ollama: OllamaConfig;
  anthropic: AnthropicConfig;
  execution: ExecutionConfig;
  memory: MemoryConfig;
  autonomy: AutonomyConfig;
}
