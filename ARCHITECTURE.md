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
│   ├── banner.ts     minimal one-line logo, rounded welcome frame and tips
│   ├── terminalIO.ts AgentIO implementation over readline + chalk
│   └── autonomousIO.ts  IO decorator for autonomous mode (auto-answers reversible confirms) (Phase 6)
├── config/           config loading/validation (YAML), API key from env var, and comment-preserving write-back (writeConfig.ts)
├── llm/              LLM provider abstraction
│   ├── provider.ts   LLMProvider interface + types (messages, tools, responses)
│   ├── ollama.ts     Ollama adapter (HTTP /api/chat, streaming + tool calling)
│   ├── anthropic.ts  Anthropic adapter (@anthropic-ai/sdk)
│   ├── openaiCompat.ts  OpenAI-compatible adapter via fetch (Groq/Gemini/Cerebras/OpenRouter/OpenAI/local)
│   └── index.ts      createProvider(config): factory based on config.provider
├── pipelines/        pipeline registry
│   ├── types.ts      PipelineDefinition schema
│   ├── registry.ts   loads the YAML files in definitions/ (with cache + validation)
│   ├── schemaCheck.ts  validates a definition's params/enum defaults against the upstream schema (verify:defs)
│   └── definitions/  one YAML per pipeline (rnaseq, sarek, proteinfamilies)
├── conversation/     state machine (Phases A–E)
│   ├── session.ts    in-memory state + Reset/Exit signals
│   ├── io.ts         AgentIO interface (decouples the flow from the terminal frontend)
│   ├── answers.ts    lenient natural-language yes/no interpretation for confirmations
│   ├── intentExtraction.ts   Phase A (forced tool record_intent)
│   ├── designReview.ts   experimental-design review (replication/controls/batch effects) (Phase 6)
│   ├── pipelineSelection.ts  Phase B (forced tool select_pipeline)
│   ├── (pipelines/nfcoreCatalog.ts)  live nf-core catalog: recommend an established pipeline when none curated fits
│   ├── (pipelines/nfcoreSchema.ts)   synthesize a param interview + samplesheet columns from a catalog pipeline's own schemas (run it on real data)
│   ├── (pipelines/synthDefinition.ts) auto-curate a catalog pipeline into a persistent registry definition (learns params, samplesheet + real result outputs into ~/.bioagent/pipelines)
│   ├── parameterFilling.ts   Phase C (params + samplesheet + params.yaml + command)
│   └── stateMachine.ts       orchestrates A→E (incl. the resource pre-flight)
├── execution/
│   ├── envCheck.ts   verifies nextflow + the chosen backend (docker/singularity/conda/mamba) on PATH
│   ├── environment.ts  detects backends, interactive selection, Nextflow/Conda/Java bootstrap (Phase 3)
│   ├── executor.ts   executor selection (local/Slurm/SGE/LSF/PBS/AWS Batch) + Nextflow -c config (Phase 3)
│   ├── fetchngs.ts   public-data accession detection + nf-core/fetchngs command builders (Phase 6)
│   ├── followUp.ts   runnable follow-up chaining — resolve upstream inputs + build command (Phase 2)
│   ├── negotiation.ts  infrastructure alternatives (cap/cluster/cloud) with rough time/cost/feasibility (Phase 3)
│   ├── staging.ts    disk-footprint estimate, disk-pressure check, image/env cache dirs (Phase 3)
│   ├── git.ts        git init + initial commit for a generated project (Phase 5)
│   ├── publish.ts    assisted GitHub publishing via `gh` (opt-in, private by default) (Phase 5)
│   ├── provenance.ts run manifest + PROVENANCE.md, incl. container images from the execution trace (Phase 2)
│   ├── resources.ts  machine detection + whole-pipeline and per-process memory assessment (ok/adapt/refuse)
│   ├── samplesheet.ts  FASTQ scanning (by extension and by content), pair inference, canonical-name symlinks, CSV writing
│   └── runner.ts     spawns `nextflow`, streams stdout/stderr, forwards SIGINT
├── modules/          live nf-core/modules registry (Phase F4)
│   ├── types.ts      NfCoreModule model + channel helpers
│   └── registry.ts   real-time fetch/parse of modules from GitHub, cached per SHA
├── composition/      compose a pipeline from modules (Phase F4)
│   ├── types.ts      CompositionPlan / ResolvedComposition
│   ├── planner.ts    LLM: suggest tools → search registry → order into a plan
│   ├── wiring.ts     channel-type matcher → runnable DSL2 workflow (pure)
│   ├── localModule.ts  custom (non-nf-core) tools → standards-compliant modules/local/ (Phase 4)
│   ├── localToolProposal.ts  LLM proposes local tools for gaps the modules don't cover (Phase 4)
│   ├── generator.ts  writes an nf-core-structured project + installs the modules
│   ├── run.ts        real-run command builder for a composed pipeline (try-before-you-publish, Phase 5)
│   ├── packaging.ts  LICENSE/CHANGELOG/CoC/CI/docs + manifest patch for sharing (Phase 5)
│   ├── contribution.ts  writes a local tool in nf-core/modules layout + nf-test for a PR (Phase 5)
│   ├── novelty.ts    NOVELTY.md manifest — reused nf-core modules vs new custom tools (Phase 5)
│   ├── inclusion.ts  nf-core inclusion guide + name check for adopting a pipeline (Phase 5)
│   └── validate.ts   `nextflow config` + `-profile test -stub-run` + `nf-core lint` gate
├── results/
│   ├── interpreter.ts  locates outputs, parses tables/JSON, NL summary via LLM
│   ├── charts.ts     compact inline terminal bar charts of the key numbers (Phase 2)
│   ├── report.ts     self-contained REPORT.html (interpretation + inline SVG bar/MultiQC-metric/volcano figures + links) (Phase 6)
│   └── methods.ts    publication-ready methods paragraph + refs from pinned/tool versions (Phase 6)
└── memory/
    └── store.ts      persistent project memory — past runs, references, recall, remembered backend/executor (Phase 6)

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

## How to add another LLM provider

The three shipped providers show the pattern; `llm/openaiCompat.ts` is a worked
example that covers many services at once (any OpenAI-compatible endpoint — Groq,
Gemini, Cerebras, OpenRouter, OpenAI, or a local server).

1. Create `src/llm/<provider>.ts` implementing the `LLMProvider` interface
   (`chat()` with `tools`/`forceTool` support and streaming via `onToken`, plus
   `healthCheck()` with actionable messages).
2. Add its branch in `createProvider()` (`src/llm/index.ts`) and its type in
   `ProviderName` (`src/config/types.ts`) — the `switch` is exhaustive, so
   TypeScript will warn you if a case is missing.
3. Add its config section in `config/types.ts` and its parsing in
   `config/loadConfig.ts`.

No other module depends on the concrete provider. Before reaching for a new
adapter, check whether the service is OpenAI-compatible — if so, the existing
`openai` provider already handles it via `baseUrl`.

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
- **Established-pipeline recommendation (Phase B fallback).** Before composing,
  when Phase B finds no curated match, `stateMachine.ts::suggestEstablishedPipeline`
  searches the live nf-core catalog (`pipelines/nfcoreCatalog.ts`: fetch+cache
  `nf-co.re/pipelines.json`, drop archived, pick latest stable release; pure
  `parseNfCoreCatalog`/`rankNfCorePipelines` token-ranked over name/topics/
  description) for a real production pipeline (e.g. `atacseq`). It recommends the
  best match and offers three paths (`chooseWith`): **run on my own data**, **run
  the test profile**, or **compose**. The test profile is a self-contained smoke
  run (`buildNfCoreTestRunCommand` → `nextflow run <name> -r <rel> -profile
  test,<engine>`). The on-data path (`runEstablishedOnData`) synthesizes a short
  interview from the pipeline's *own* schemas (`pipelines/nfcoreSchema.ts`:
  `fetchSynthesizedSpec` fetches `nextflow_schema.json` + `assets/schema_input.json`;
  `synthesizeSchemaParams` keeps required params + references + the `genome` key
  and drops the optional tail; `parseInputSchema`/`isSimpleFastqSheet` derive the
  samplesheet columns) — it builds the sheet from a folder when columns are simple
  (sample + FASTQ) or validates a user CSV against the real column spec
  (`validateSamplesheetContent`), asks only for what's needed (offering the
  iGenomes `genome` key first to cover FASTA/GTF/index prompts), writes
  `params.yaml` and runs via `buildFollowUpCommand`. Both paths reuse the normal
  environment gate, `runNextflow` and the shared `interpretDirectoryRun`. It's
  honest that a catalog pipeline is schema-driven, not curated; degrades to the
  test profile if the schema is unreachable and to composition when offline. This
  is the co-scientist reflex — reach for the established pipeline a bioinformatician
  would know before assembling one from scratch.
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
- **Follow-up chaining (Phase 2).** A `PipelineDefinition.followUp` with a pinned
  revision is *runnable*: `execution/followUp.ts` resolves the follow-up's inputs
  from the upstream outdir and builds the command (pure). After Phase E,
  `stateMachine.ts::phaseFollowUp` offers to launch it — wiring the upstream count
  matrix into `--matrix`, carrying over `gtf`, and asking only for the
  sample-condition table and contrasts — then runs it through the normal
  confirmed-execution path, reusing the chosen backend/executor. rnaseq points at
  nf-core/differentialabundance. It suggests-then-offers; it never auto-chains.
  The follow-up's results are interpreted like a primary run: `results/interpreter.ts`
  takes an `InterpretablePipeline` (a full `PipelineDefinition` satisfies it), and a
  `de_table_dir` output is parsed by `parsers.ts::countDifferential` into per-contrast
  significant-gene counts (up/down) that ground the same LLM biological summary. The
  follow-up also gets a light resource pre-flight (`followUpResourceCheck`, reusing
  `assessResources`), a project-memory record (`recordFollowUpRun`), and its own
  methods paragraph via the shared `generateMethods` (used by the primary run too).
- **Public-data retrieval (Phase 6).** `execution/fetchngs.ts` detects accession
  ids in the request (SRA/ENA/DDBJ, GEO, BioProject/BioSample, ArrayExpress) with
  anchored regexes and builds a pinned `nf-core/fetchngs` run (all pure/testable).
  `stateMachine.ts::phaseFetchData` runs after pipeline selection: it offers the
  download, executes it through the normal `runNextflow` path, validates the
  emitted samplesheet against the pipeline's columns and sets it on the session.
  `parameterFilling.ts` then skips manual samplesheet construction (the `dataReady`
  guard). Every failure mode falls back to normal local-file parameterization.
- **Content-based ingestion.** `parameterFilling.ts::resolveFastqScan` prefers the
  fast extension-based `scanFastqs`; when a folder has no `.fastq/.fq` files it
  falls back to `samplesheet.ts::scanSequenceDir`, which sniffs each file's bytes
  (`classifySequenceText` for FASTQ/FASTA, `detectBinaryMagic` for BAM/CRAM/fast5,
  gzip head-decompression) and then offers `linkCanonicalSequences` to symlink the
  recognized files to canonical names so the existing pair inference and the
  pipeline's own checks work. The sniff/name helpers are pure and unit-tested;
  unsupported binary formats are reported, not silently ignored.
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
  pipelines and schema-validated definitions will land. It loads the bundled
  curated definitions **and** user-curated ones from `~/.bioagent/pipelines`
  (`userDefinitionsDir`), where `synthDefinition.ts` writes definitions
  auto-generated from a catalog pipeline's schema after a run — params + samplesheet
  from the schema, and `results.outputs` **learned from the completed run's output
  directory** (`detectResultOutputs`: MultiQC report + VCF dirs) so the curated
  pipeline interprets real files next time — so the guided set grows itself
  (bundled hand-curated wins on a name clash).
- **`resources.ts`** is the foundation for per-process modeling and the
  infrastructure negotiation (HPC/cloud) of Phase 3.
- **`runner.ts`** already isolates process execution, the natural place for an
  executor abstraction (local → Slurm → cloud).
