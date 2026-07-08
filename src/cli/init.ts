/**
 * `hirsh init` — scaffold a project workspace.
 *
 * Creates the few files a scientist wants when starting a study folder: a starter
 * `config.yaml`, a `.gitignore` that keeps runs and private memory out of version
 * control, and the `.hirsh/` data directory. Safe and idempotent — it never
 * overwrites an existing file, and it only appends the entries that are missing
 * from an existing `.gitignore`.
 *
 * Content generation and the gitignore merge are pure (unit-tested); `runInit`
 * does the filesystem work.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Entries a workspace `.gitignore` should carry (runs are large; memory is private). */
export const WORKSPACE_GITIGNORE = [
  "runs/",
  ".hirsh/",
  ".hirsh-cache/",
  ".nextflow/",
  ".nextflow.log*",
  "work/",
];

/** A compact, commented starter `config.yaml` for a new workspace. */
export function starterConfigYaml(): string {
  return `# Hirsh configuration for this project.
# The LLM API key is NEVER stored here — it's read from the env var named below.
# Full reference: the project's config.example.yaml.

# Active LLM provider: "ollama" (local) | "anthropic" (Claude) | "openai" (any
# OpenAI-compatible endpoint, incl. free tiers like Groq).
provider: ollama

ollama:
  host: http://localhost:11434
  model: llama3.1:8b

anthropic:
  apiKeyEnv: ANTHROPIC_API_KEY
  model: claude-fable-5

openai:
  baseUrl: https://api.groq.com/openai/v1
  model: llama-3.3-70b-versatile
  apiKeyEnv: GROQ_API_KEY

execution:
  # Container/env backend: docker | singularity | conda | mamba.
  containerEngine: docker
  # Where jobs run: local | slurm | sge | lsf | pbs | awsbatch.
  executor: local
  # Run outputs land here (relative to this workspace).
  workdir: ./runs

memory:
  # Per-project history lives in ./.hirsh/memory.json. Set 'path' to share one
  # store across projects, or 'enabled: false' to turn memory off.
  enabled: true
`;
}

/**
 * Merges the required entries into an existing `.gitignore` content, appending
 * only the ones that are missing. Returns the new content and which were added
 * (added empty → nothing to write). Pure.
 */
export function mergeGitignore(
  existing: string | null,
  entries: string[],
): { content: string; added: string[] } {
  const lines = existing ? existing.split(/\r?\n/) : [];
  const present = new Set(lines.map((l) => l.trim()).filter(Boolean));
  const added = entries.filter((e) => !present.has(e));
  if (added.length === 0) return { content: existing ?? "", added: [] };

  const block = ["# --- Hirsh (runs are large; memory is private) ---", ...added];
  let base = existing ?? "";
  if (base && !base.endsWith("\n")) base += "\n";
  const prefix = base ? base + "\n" : "";
  return { content: prefix + block.join("\n") + "\n", added };
}

export interface InitResult {
  workspace: string;
  created: string[];
  updated: string[];
  skipped: string[];
}

/**
 * Scaffolds the workspace at `targetDir`. Creates the directory and `.hirsh/`,
 * writes `config.yaml` if absent, and ensures `.gitignore` carries the workspace
 * entries (appending only missing ones). Never overwrites existing files.
 */
export function runInit(targetDir: string): InitResult {
  const workspace = resolve(targetDir);
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  mkdirSync(workspace, { recursive: true });
  const hirshDir = join(workspace, ".hirsh");
  if (!existsSync(hirshDir)) {
    mkdirSync(hirshDir, { recursive: true });
    created.push(".hirsh/");
  } else {
    skipped.push(".hirsh/");
  }

  const configPath = join(workspace, "config.yaml");
  if (existsSync(configPath)) {
    skipped.push("config.yaml");
  } else {
    writeFileSync(configPath, starterConfigYaml(), "utf8");
    created.push("config.yaml");
  }

  const gitignorePath = join(workspace, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : null;
  const merged = mergeGitignore(existing, WORKSPACE_GITIGNORE);
  if (merged.added.length > 0) {
    writeFileSync(gitignorePath, merged.content, "utf8");
    if (existing === null) created.push(".gitignore");
    else updated.push(`.gitignore (+${merged.added.length})`);
  } else {
    skipped.push(".gitignore");
  }

  return { workspace, created, updated, skipped };
}
