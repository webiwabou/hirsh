/**
 * Loads and validates Hirsh configuration.
 *
 * Config file search order:
 *   1. Explicit path in the HIRSH_CONFIG environment variable.
 *   2. ./config.yaml (current working directory).
 *   3. ~/.bioagent/config.yaml
 *
 * The Anthropic API key never lives in the file: it is referenced by env var
 * name (anthropic.apiKeyEnv) and resolved at use time.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AnthropicConfig,
  AutonomyConfig,
  ExecutionConfig,
  HirshConfig,
  MemoryConfig,
  OllamaConfig,
  OpenAICompatConfig,
  ProviderName,
} from "./types.js";

/** Configuration error with a message meant to be shown to the user. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_OLLAMA: OllamaConfig = {
  host: "http://localhost:11434",
  model: "llama3.1:8b",
  temperature: 0.2,
};

const DEFAULT_ANTHROPIC: AnthropicConfig = {
  apiKeyEnv: "ANTHROPIC_API_KEY",
  model: "claude-fable-5",
  temperature: 0.2,
  maxTokens: 4096,
};

// Defaults point at Groq's free tier (OpenAI-compatible, tool-calling capable).
const DEFAULT_OPENAI: OpenAICompatConfig = {
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.3-70b-versatile",
  apiKeyEnv: "GROQ_API_KEY",
  temperature: 0.2,
  maxTokens: 4096,
};

const DEFAULT_EXECUTION: ExecutionConfig = {
  containerEngine: "docker",
  executor: "local",
  workdir: "./runs",
};

function candidatePaths(): string[] {
  const paths: string[] = [];
  if (process.env.HIRSH_CONFIG) paths.push(resolve(process.env.HIRSH_CONFIG));
  paths.push(resolve(process.cwd(), "config.yaml"));
  paths.push(resolve(homedir(), ".bioagent", "config.yaml"));
  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loads config from disk. If no file exists, returns a default config (local
 * Ollama) so the user can start and get clear guidance if the backend is down.
 */
export function loadConfig(): { config: HirshConfig; sourcePath: string | null } {
  const found = candidatePaths().find((p) => existsSync(p)) ?? null;

  let raw: Record<string, unknown> = {};
  if (found) {
    let text: string;
    try {
      text = readFileSync(found, "utf8");
    } catch (err) {
      throw new ConfigError(
        `Could not read the configuration file ${found}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      const parsed = parseYaml(text);
      if (parsed != null && !isRecord(parsed)) {
        throw new ConfigError(
          `The configuration file ${found} must be a YAML map (key: value).`,
        );
      }
      raw = parsed ?? {};
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(
        `The configuration file ${found} is not valid YAML: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const provider = normalizeProvider(raw.provider);

  const config: HirshConfig = {
    provider,
    ollama: mergeOllama(raw.ollama),
    anthropic: mergeAnthropic(raw.anthropic),
    openai: mergeOpenAI(raw.openai),
    execution: mergeExecution(raw.execution),
    memory: mergeMemory(raw.memory),
    autonomy: mergeAutonomy(raw.autonomy),
  };

  return { config, sourcePath: found };
}

const DEFAULT_AUTONOMY: AutonomyConfig = { enabled: false };

function mergeAutonomy(value: unknown): AutonomyConfig {
  if (value === undefined) return { ...DEFAULT_AUTONOMY };
  if (!isRecord(value)) throw new ConfigError('The "autonomy" section must be a map.');
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_AUTONOMY.enabled,
  };
}

const DEFAULT_MEMORY: MemoryConfig = { enabled: true };

function mergeMemory(value: unknown): MemoryConfig {
  if (value === undefined) return { ...DEFAULT_MEMORY };
  if (!isRecord(value)) throw new ConfigError('The "memory" section must be a map.');
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_MEMORY.enabled,
    path: typeof value.path === "string" ? value.path : undefined,
  };
}

function normalizeProvider(value: unknown): ProviderName {
  if (value === undefined) return "ollama";
  if (value === "ollama" || value === "anthropic" || value === "openai") return value;
  throw new ConfigError(
    `Invalid provider: "${String(value)}". Allowed values: "ollama", "anthropic" or "openai".`,
  );
}

function mergeOllama(value: unknown): OllamaConfig {
  if (value === undefined) return { ...DEFAULT_OLLAMA };
  if (!isRecord(value)) throw new ConfigError('The "ollama" section must be a map.');
  return {
    host: typeof value.host === "string" ? value.host : DEFAULT_OLLAMA.host,
    model: typeof value.model === "string" ? value.model : DEFAULT_OLLAMA.model,
    temperature:
      typeof value.temperature === "number"
        ? value.temperature
        : DEFAULT_OLLAMA.temperature,
  };
}

function mergeAnthropic(value: unknown): AnthropicConfig {
  if (value === undefined) return { ...DEFAULT_ANTHROPIC };
  if (!isRecord(value)) throw new ConfigError('The "anthropic" section must be a map.');
  return {
    apiKeyEnv:
      typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : DEFAULT_ANTHROPIC.apiKeyEnv,
    model: typeof value.model === "string" ? value.model : DEFAULT_ANTHROPIC.model,
    temperature:
      typeof value.temperature === "number"
        ? value.temperature
        : DEFAULT_ANTHROPIC.temperature,
    maxTokens:
      typeof value.maxTokens === "number" ? value.maxTokens : DEFAULT_ANTHROPIC.maxTokens,
  };
}

function mergeOpenAI(value: unknown): OpenAICompatConfig {
  if (value === undefined) return { ...DEFAULT_OPENAI };
  if (!isRecord(value)) throw new ConfigError('The "openai" section must be a map.');
  return {
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : DEFAULT_OPENAI.baseUrl,
    model: typeof value.model === "string" ? value.model : DEFAULT_OPENAI.model,
    apiKeyEnv: typeof value.apiKeyEnv === "string" ? value.apiKeyEnv : DEFAULT_OPENAI.apiKeyEnv,
    temperature:
      typeof value.temperature === "number" ? value.temperature : DEFAULT_OPENAI.temperature,
    maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : DEFAULT_OPENAI.maxTokens,
  };
}

function mergeExecution(value: unknown): ExecutionConfig {
  if (value === undefined) return { ...DEFAULT_EXECUTION };
  if (!isRecord(value)) throw new ConfigError('The "execution" section must be a map.');
  const engine = value.containerEngine;
  const validEngines = ["docker", "singularity", "conda", "mamba"];
  if (engine !== undefined && !validEngines.includes(engine as string)) {
    throw new ConfigError(
      `Invalid execution.containerEngine: "${String(engine)}". ` +
        `Use one of: ${validEngines.join(", ")}.`,
    );
  }
  const executor = value.executor;
  const validExecutors = ["local", "slurm", "sge", "lsf", "pbs", "awsbatch"];
  if (executor !== undefined && !validExecutors.includes(executor as string)) {
    throw new ConfigError(
      `Invalid execution.executor: "${String(executor)}". ` +
        `Use one of: ${validExecutors.join(", ")}.`,
    );
  }
  return {
    containerEngine: (engine as ExecutionConfig["containerEngine"]) ?? DEFAULT_EXECUTION.containerEngine,
    executor: (executor as ExecutionConfig["executor"]) ?? DEFAULT_EXECUTION.executor,
    queue: typeof value.queue === "string" ? value.queue : undefined,
    workdir: typeof value.workdir === "string" ? value.workdir : DEFAULT_EXECUTION.workdir,
    maxCpus: typeof value.maxCpus === "number" ? value.maxCpus : undefined,
    maxMemory: typeof value.maxMemory === "string" ? value.maxMemory : undefined,
  };
}

/**
 * Resolves the Anthropic API key from the configured environment variable.
 * Returns null if it is not set (the caller decides how to report it).
 */
export function resolveAnthropicApiKey(config: HirshConfig): string | null {
  const key = process.env[config.anthropic.apiKeyEnv];
  return key && key.trim().length > 0 ? key : null;
}

/**
 * Resolves the OpenAI-compatible API key from the configured env var. Returns
 * null if unset — acceptable for keyless local endpoints.
 */
export function resolveOpenAIApiKey(config: HirshConfig): string | null {
  const key = process.env[config.openai.apiKeyEnv];
  return key && key.trim().length > 0 ? key : null;
}
