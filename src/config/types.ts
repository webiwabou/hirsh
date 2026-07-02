/** Hirsh configuration types. */

export type ProviderName = "ollama" | "anthropic";
export type ContainerEngine = "docker" | "singularity";

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

export interface ExecutionConfig {
  containerEngine: ContainerEngine;
  /** Base directory where pipelines are launched. */
  workdir: string;
  /** Optional CPU cap for runs (overrides detected machine as the budget). */
  maxCpus?: number;
  /** Optional memory cap for runs, nf-core style e.g. "30.GB". */
  maxMemory?: string;
}

export interface HirshConfig {
  provider: ProviderName;
  ollama: OllamaConfig;
  anthropic: AnthropicConfig;
  execution: ExecutionConfig;
}
