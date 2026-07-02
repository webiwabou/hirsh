# Hirsh architecture

A short design document and extension guide for future phases.

## Principles

- **Modules split by responsibility.** The rest of the code knows nothing about
  concrete SDKs or concrete pipelines: it depends on interfaces and data.
- **Simplicity over speculative flexibility.** Only the Phase 1 scope is
  implemented; extension points are marked where they matter.
- **Nothing runs without explicit confirmation** from the user, and API keys are
  never written to disk or logged.

## Module map

```
src/
├── cli/              terminal REPL (I/O, commands /status /reset /help /exit)
│   ├── index.ts      startup: config → registry → provider → env → conversation loop
│   ├── banner.ts     ASCII DNA-helix logo, rounded welcome frame and tips
│   └── terminalIO.ts AgentIO implementation over readline + chalk
├── config/           config loading and validation (YAML), API key from env var
├── llm/              LLM provider abstraction
│   ├── provider.ts   LLMProvider interface + types (messages, tools, responses)
│   ├── ollama.ts     Ollama adapter (HTTP /api/chat, streaming + tool calling)
│   ├── anthropic.ts  Anthropic adapter (@anthropic-ai/sdk)
│   └── index.ts      createProvider(config): factory based on config.provider
├── pipelines/        pipeline registry
│   ├── types.ts      PipelineDefinition schema
│   ├── registry.ts   loads the YAML files in definitions/ (with cache + validation)
│   └── definitions/  one YAML per pipeline (rnaseq, sarek, proteinfamilies)
├── conversation/     state machine (Phases A–E)
│   ├── session.ts    in-memory state + Reset/Exit signals
│   ├── io.ts         AgentIO interface (decouples the flow from the terminal frontend)
│   ├── intentExtraction.ts   Phase A (forced tool record_intent)
│   ├── pipelineSelection.ts  Phase B (forced tool select_pipeline)
│   ├── parameterFilling.ts   Phase C (params + samplesheet + params.yaml + command)
│   └── stateMachine.ts       orchestrates A→E (incl. the resource pre-flight)
├── execution/
│   ├── envCheck.ts   verifies nextflow + the chosen backend (docker/singularity/conda/mamba) on PATH
│   ├── environment.ts  detects backends, interactive selection, Nextflow bootstrap (Phase 3)
│   ├── resources.ts  machine detection + whole-pipeline and per-process memory assessment (ok/adapt/refuse)
│   ├── samplesheet.ts  FASTQ scanning, pair inference, CSV writing
│   └── runner.ts     spawns `nextflow`, streams stdout/stderr, forwards SIGINT
├── modules/          live nf-core/modules registry (Phase F4)
│   ├── types.ts      NfCoreModule model + channel helpers
│   └── registry.ts   real-time fetch/parse of modules from GitHub, cached per SHA
├── composition/      compose a pipeline from modules (Phase F4)
│   ├── types.ts      CompositionPlan / ResolvedComposition
│   ├── planner.ts    LLM: suggest tools → search registry → order into a plan
│   ├── wiring.ts     channel-type matcher → runnable DSL2 workflow (pure)
│   ├── generator.ts  writes an nf-core-structured project + installs the modules
│   └── validate.ts   `nextflow config` + `-profile test -stub-run` gate
└── results/
    └── interpreter.ts  locates outputs, parses tables/JSON, NL summary via LLM

test/                 Vitest suite for the pure logic (resources, samplesheet,
                      command building, config loading, workflow generation)
```

### Data flow

`cli/index.ts` builds the dependencies (config, registry, provider, IO) and
creates an `Agent` (`conversation/stateMachine.ts`). The `Agent` drives the
phases using two decoupled collaborators:

- **`AgentIO`** — everything said to / asked of the user. The terminal is one
  implementation; it could be swapped (tests, another frontend) without touching
  the flow.
- **`LLMProvider`** — everything that requires the model. Ollama and Anthropic
  are interchangeable implementations selected by config.

State lives in an in-memory `Session` object (no persistence in Phase 1).

## How to add a fourth pipeline

**No core logic changes needed.** Just:

1. Create `src/pipelines/definitions/<name>.yaml` copying the structure of an
   existing one (see the schema in `src/pipelines/types.ts`). At minimum:
   - `name`, `version` (pinned revision for `-r`), `title`, `purpose`.
   - `purpose` and `useWhen`: this is what the LLM uses for semantic matching, so
     describe it in terms of "which biological question it answers".
   - `samplesheet`: expected columns.
   - `params`: each with `type`, `required`, `default` and a plain-language
     `description` (this drives what to ask in Phase C).
   - `profiles` and `results.outputs` (to locate and interpret results).
2. `npm run build` (the `copy-assets` step copies the YAML into `dist/`).

The registry picks it up automatically at startup and it will appear in the
catalog the LLM sees during pipeline selection.

> **Note:** `parameterFilling.ts` has branches specific to the samplesheet shape
> of paired FASTQ (rnaseq/sarek) and protein FASTA (proteinfamilies). A pipeline
> with a radically different samplesheet format may require a new branch there;
> the current three cover the two common patterns.

## How to add a third LLM provider

1. Create `src/llm/<provider>.ts` implementing the `LLMProvider` interface
   (`chat()` with `tools`/`forceTool` support and streaming via `onToken`, plus
   `healthCheck()` with actionable messages).
2. Add its branch in `createProvider()` (`src/llm/index.ts`) and its type in
   `ProviderName` (`src/config/types.ts`) — the `switch` is exhaustive, so
   TypeScript will warn you if a case is missing.
3. Add its config section in `config/types.ts` and its parsing in
   `config/loadConfig.ts`.

No other module depends on the concrete provider.

## Relevant implementation notes

- **Tool calling for structured extraction.** Phases A and B force a tool
  (`record_intent`, `select_pipeline`) to get reliable JSON instead of parsing
  free text. This targets the known weakness (FlowBench 2026): inferring the
  right pipeline from the biological intent alone.
- **Streaming.** Free-form LLM text (the results summary) is streamed token by
  token; with `tools` streaming is disabled because the full call block is
  needed.
- **Resource awareness.** `resources.ts` compares the pipeline's declared needs
  (the `resources` block in each YAML) against the machine or configured caps and
  returns an `ok` / `adapt` / `refuse` verdict. `stateMachine.ts` runs this
  pre-flight in Phase D; adapting sets `--max_memory`/`--max_cpus` and
  regenerates the command. Skipped for the test profile.
- **Composition from nf-core modules (Phase F4).** When Phase B finds no curated
  pipeline, `stateMachine.ts` runs a compose branch: `modules/registry.ts` tracks
  [nf-core/modules](https://github.com/nf-core/modules) live (resolve commit →
  list ~1,900 modules → parse `meta.yml`, cached per SHA); `composition/planner.ts`
  has the LLM pick and order real modules; `composition/wiring.ts` connects them
  with a **typed channel environment** (match input↔output by data kind, rebuild
  multi-file tuples, carry `meta`, route references to params, collect reports for
  MultiQC, gather versions via the `versions` topic); `composition/generator.ts`
  writes the nf-core-structured project (modules from the pinned commit, SHA-pinned
  `modules.json`, config with resource limits + a `test` profile, schema,
  `CITATIONS.md`) plus placeholder test data; `composition/validate.ts` runs
  `nextflow config` and a `-profile test -stub-run` so the composed pipeline runs
  end-to-end unedited. Non-linear DAGs and an `nf-core lint` gate are the next
  milestone.
- **Execution via `-params-file`.** `parameterFilling.ts` writes a reviewable
  `params.yaml` and the command references it, instead of a long CLI. Booleans and
  resource caps flow through cleanly, and there is no shell (params never touch a
  shell; `runner.ts` uses `spawn` with an argv array).
- **Security.** `runner.ts` is only invoked after an explicit `io.confirm` in
  Phase D, and forwards Ctrl+C to Nextflow for a clean shutdown. The API key is
  resolved from an environment variable and `config.yaml` is in `.gitignore`.

## Built to grow (toward the roadmap)

The seams that later phases (see [RECOMMENDATIONS.md](RECOMMENDATIONS.md)) plug
into already exist:

- **`AgentIO`** lets a future TUI/web frontend reuse the whole conversation.
- **`LLMProvider`** keeps the reasoning engine swappable.
- **Pipeline registry** (data-driven YAML) is the seam where module-composed
  pipelines and schema-validated definitions will land.
- **`resources.ts`** is the foundation for per-process modeling and the
  infrastructure negotiation (HPC/cloud) of Phase 3.
- **`runner.ts`** already isolates process execution, the natural place for an
  executor abstraction (local → Slurm → cloud).
