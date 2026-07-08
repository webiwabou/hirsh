# Hirsh — Roadmap to an AI bioinformatics co-scientist

This is a **roadmap of objectives**, not an implementation manual. It describes
where Hirsh is going across evolutionary iterations, from today's guided
pipeline runner to an autonomous **bioinformatics co-scientist**.

## North star

> A scientist describes a biological question in plain language and Hirsh does
> the rest: it figures out the analysis, finds or **composes** the right workflow
> from real nf-core building blocks, negotiates the compute environment and
> infrastructure it needs, runs it reproducibly, explains the results as science
> (not logs), and — when it invents something genuinely new — packages that work
> to nf-core standards and offers to contribute it back.
>
> The scientist should need **no technical knowledge** of Nextflow, containers,
> samplesheets, cluster schedulers or memory tuning. Hirsh carries that load and
> keeps the human in the loop only for the decisions that are theirs to make.

Every iteration should move a real capability closer to that end state while
keeping the invariant that **nothing runs, is deleted, or is published without
explicit human confirmation**.

## How to read this

Milestones are grouped into evolutionary **phases**. Each item is a checkbox
objective, not a task breakdown. Priorities live inside each phase.

- ✅ done · 🔵 next · ⬜ planned

Phases are cumulative: later phases assume earlier ones are solid.

---

## Phase 1 — Guided single-pipeline runner ✅ (shipped)

The MVP: understand intent → select one of a curated set of nf-core pipelines →
parameterize → confirm → run → interpret.

- ✅ Conversational flow (intent → selection → params → confirm → run → interpret)
  - ✅ Confirmations understand natural language, not just a strict `y/n`: common
    phrasings ("sure", "nope", "go ahead", "sí") are accepted, and at the pipeline
    choice the user can answer in free text ("actually it's paired-end WGS") to have
    Hirsh fold that back into the intent and reconsider (`conversation/answers.ts`,
    `confirmOrText`).
  - ✅ **Path prompts are lenient too.** A "give me a directory" answer is classified
    rather than blindly used as a path: an explicit `@path` reference (spaces
    allowed), a bare path, or a change of mind ("actually, run the test profile") →
    switch to the test profile. Unclear answers re-ask with guidance instead of
    silently failing with "no files found" (`conversation/pathInput.ts`, unit-tested).
  - ✅ **Recommended-options prompts** ("pick one, or type your own"). Where a
    scientist would otherwise face nf-core jargon, Hirsh presents numbered options
    with a plain-language description and a recommended default, still accepting a
    number, a label, an `@path`, or free text (`conversation/choice.ts`,
    unit-tested). Applied to the custom-tool collector (software env, input/output
    kinds, patterns) so someone who has never used Nextflow can add their own tool;
    output kinds are sanitized so a stray answer can't produce a broken file
    pattern. `@` path references work at file prompts too.
  - ✅ **Interactive selection.** In a rich terminal the recommended-options prompt
    is an **arrow-key menu** (`@inquirer/prompts`) — each option with its
    description and a "Something else (type it)" row — with a numbered text fallback
    for non-interactive terminals (`AgentIO.select`, `chooseWith` delegates;
    unit-tested via a stub). Typing `/` then Tab completes commands, and **`@path`
    references Tab-complete against the filesystem** (`parseAtToken`, unit-tested).
  - ✅ **Arrow-key confirmations.** Yes/No prompts are an arrow menu too (select the
    pointer, no typing), with the natural-language text confirm as the fallback.
  - ✅ **Multi-line paste (bracketed paste).** On a TTY, a pasted block (e.g. a FASTA
    with newlines) no longer submits line-by-line and truncates: Hirsh enables
    bracketed paste and filters it (markers stripped, in-paste newlines collapsed to
    spaces) so the paste lands as one editable line to review and submit. Applied via
    a TTY-preserving Transform shared by readline and inquirer; opt out with
    `HIRSH_NO_PASTE_FILTER` (`cli/paste.ts::filterBracketedPaste`, unit-tested).
  - ✅ **Backend/executor selection uses the menu too.** Choosing the execution
    backend (Docker/Singularity/Conda/Mamba) and the executor (local/Slurm/…/AWS
    Batch) is now the same arrow-key recommended-options menu, not a numbered text
    prompt (`chooseBackend`/`chooseExecutor` delegate to `chooseWith`).
  - ✅ **Fewer redundant intent questions.** Deterministic guards stop the intent
    phase from over-probing (a weak model's habit): once organism + data type +
    objective are known it proceeds to selection, and it won't re-ask a question it
    effectively already asked (`hasEnoughContext`/`isDuplicateQuestion`, unit-tested).
  - ⬜ Remaining: apply the menu to the LLM-proposed gap-tool prompts; live-color the
    `@` fragment as it's typed and a fuller inline command/@ dropdown (today it's
    Tab-completion); and fuller free-form redirection everywhere.
- ✅ Swappable LLM backends behind one interface: Ollama (local), Anthropic
  (Claude), and any OpenAI-compatible endpoint (Groq/Gemini/Cerebras/OpenRouter/
  OpenAI/local) — the last one lets a new user try Hirsh on a free tier before
  they have Claude credits
- ✅ Extensible pipeline registry (rnaseq, sarek, proteinfamilies)
- ✅ **Discovery beyond the curated set.** When no curated pipeline fits, Hirsh
  searches the **live nf-core catalog** (~100 production pipelines,
  `nf-co.re/pipelines.json`) and recommends the established one a bioinformatician
  would reach for (e.g. `atacseq`, `methylseq`, `scrnaseq`) instead of only
  composing from modules. It offers to run the recommended pipeline's bundled
  `test` profile — a self-contained smoke run on nf-core's example data that
  proves the pipeline and the local environment work and previews real outputs —
  reusing the normal environment gate, runner and results interpreter. Honest
  about the limit: a catalog pipeline isn't curated yet, so there's no
  step-by-step parameterization on real data — it points at the pipeline's docs
  and offers to curate it into Hirsh. Degrades silently to composition when
  offline (`pipelines/nfcoreCatalog.ts`: `parseNfCoreCatalog`/`rankNfCorePipelines`/
  `buildNfCoreTestRunCommand` pure + unit-tested; `suggestEstablishedPipeline`
  wired into Phase B).
- ✅ **Run a catalog pipeline on your own data (schema-synthesized).** A
  recommended catalog pipeline is no longer test-profile-only: Hirsh reads the
  pipeline's **own schemas** (`nextflow_schema.json` + `assets/schema_input.json`)
  and synthesizes a short parameter interview — it builds the samplesheet from a
  folder when the required columns are just sample + FASTQ, otherwise asks for a
  ready CSV and **validates it against the real column spec** (never guessing
  per-sample biology like `replicate`/`condition`); it asks only for required
  params and references, offering the iGenomes `genome` key first (which then
  covers the FASTA/GTF/index prompts) and leaving optional settings at nf-core's
  defaults. Then it writes `params.yaml` and runs through the normal environment
  gate, runner and results interpreter — honest that it's schema-driven, not a
  curated recipe. So any of the ~100 nf-core pipelines is runnable on real data,
  not just the 3 curated ones (`pipelines/nfcoreSchema.ts`:
  `synthesizeSchemaParams`/`parseInputSchema`/`isSimpleFastqSheet` pure +
  unit-tested, verified live against atacseq/scrnaseq/methylseq/ampliseq/
  taxprofiler; `runEstablishedOnData` wired).
  - ⬜ Remaining: honor `dependentRequired`/conditional-required params and
    param-level `pattern` validation; and a resource pre-flight for a catalog run
    (no curated per-process model exists for it).
- ✅ **Auto-curate a catalog pipeline (Hirsh learns pipelines).** After running a
  catalog pipeline, Hirsh offers to **curate it into a persistent definition** so
  it becomes a first-class, guided pipeline next session — not schema-driven each
  time. It generates a full `PipelineDefinition` YAML from the pipeline's schema +
  catalog metadata (params with enum choices, samplesheet columns, a `test`
  profile) and writes it to a **user definitions directory** (`~/.bioagent/
  pipelines`), which the registry now loads alongside the bundled curated ones (a
  hand-curated definition wins on a name clash; a broken user file can't sink
  startup). The write is validated by reloading the registry (removed if it
  doesn't load), and the file carries an honest "auto-generated, NOT hand-curated"
  header naming what to refine (result output paths, resources, citation DOI). So
  the curated set **grows itself** as the scientist uses pipelines
  (`pipelines/synthDefinition.ts`: `buildSynthesizedDefinition`/
  `renderDefinitionYaml`/`definitionFileName` pure + unit-tested;
  `registry.ts::userDefinitionsDir`/`invalidateRegistryCache`; `offerCuration`
  wired; verified end-to-end that atacseq curated from its live schema loads as a
  guided pipeline).
  - ✅ **Learns real result outputs.** When curating after a run, Hirsh scans the
    completed output directory and fills `results.outputs` with the concrete files
    worth interpreting — the MultiQC report (shallowest match) and VCF directories,
    by nf-core convention, plus a catch-all — so next session's interpretation is
    rich (per-sample QC stats, variant counts) instead of a generic directory
    listing (`synthDefinition.ts::detectResultOutputs` +
    `interpreter.ts::listRelativeFiles`, pure/unit-tested; integration verified).
  - ⬜ Remaining: add a `resources` block automatically (deferred — a test run's
    memory peaks are tiny/misleading and parsing the pipeline's Groovy config is
    fragile; better sourced from a real run's Nextflow trace over representative
    data); learn per-tool table outputs (counts/DE tables) beyond MultiQC/VCF; and
    let the scientist edit a curated definition through Hirsh.
- ✅ Samplesheet construction with FASTQ pair inference
- ✅ Live Nextflow streaming, explicit run confirmation
- ✅ Plain-language results summary + MultiQC pointer
- ✅ Terminal UX, global `hirsh` command — refreshed to a minimal look: a compact
  one-line logo (`●──●──●  hirsh`) + tagline, a light framed welcome, section
  headings with a cyan left bar, and a `⚠` glyph on warnings (`cli/banner.ts`,
  unit-tested).

## Phase 1.5 — Trustworthy runs on real machines ✅ (this iteration)

Hardening that makes real runs safe and reviewable, and the first taste of the
infrastructure intelligence that defines the north star.

- ✅ **Resource awareness (memory negotiation).** Before a real run Hirsh compares
  the pipeline's typical needs against the machine (or configured caps) and gives
  an honest verdict: **ok** → run; **adapt** → offer to cap Nextflow to available
  memory/CPUs and warn about the trade-off; **refuse** → recommend *not* running
  here. (The "40 GB pipeline on a 30 GB vs 2 GB machine" story.)
- ✅ **`-params-file` execution.** Parameters are written to a reviewable
  `params.yaml` instead of a long, fragile command line.
- ✅ **Ctrl+C forwarding** so Nextflow shuts its jobs/containers down cleanly.
- ✅ **Test suite** (Vitest) for the pure logic: resource assessment, pair
  inference, command building, config loading.
- ✅ Wire `npm test` into CI (GitHub Actions running build + tests on push/PR).

---

## Phase 2 — Robust, reproducible, and genuinely informative

Make every supported pipeline safe to run for real and make its output land as
*science*.

- ✅ **Validate definitions against upstream.** `npm run verify:defs`
  (`scripts/verify-definitions.mjs`) fetches each pinned pipeline's real
  `nextflow_schema.json` and confirms the revision tag exists and every declared
  param is a real upstream parameter. It **also validates enum defaults/choices**
  against the upstream schema — so a wrong default like proteinfamilies'
  `clustering_tool: mmseqs` is caught, not shipped (the pure check lives in
  `pipelines/schemaCheck.ts`, unit-tested; the script runs via `tsx`). Verified
  live: all three pass. It runs in **CI on a weekly schedule** (plus manual
  dispatch) — off the per-PR checks since it needs network to fetch upstream
  schemas (`.github/workflows/verify-defs.yml`).
  - ⬜ Remaining: diff non-enum default *values* too (informational).
- ✅ **Self-correcting runs.** When a run fails nf-core's parameter validation
  ("Expected any of [...]"), Hirsh parses the error, shows the offending
  parameter(s) and their allowed values, and offers to fix each to a valid value
  (via the menu) and run again — once, so a persistent error can't loop — instead
  of blindly re-running the same command (`execution/nextflowErrors.ts`, unit-tested).
- ✅ **Richer, quantitative interpretation.** Phase E now reads the numbers that
  matter — per-sample library sizes/column totals from count matrices, per-sample
  metrics from MultiQC's `multiqc_general_stats.txt`, and variant counts from VCFs
  (incl. `.vcf.gz`) — and hands the LLM concrete figures instead of file listings
  (pure parsers in `results/parsers.ts`, unit-tested). Those numbers also render as
  **compact inline bar charts** before the prose summary — per-sample library sizes
  from count matrices, significant genes per contrast — so the scientist sees the
  shape of the data at a glance (`results/charts.ts::renderBarChart`, unit-tested;
  shown for primary, follow-up and composed runs).
  - ✅ **Variant-type breakdown.** VCF interpretation now reports the SNP/indel/MNP
    split and the **transition/transversion ratio** (a standard variant-calling QC
    metric) per file and overall, with a "Variant types" bar chart, instead of a
    bare variant count (`results/parsers.ts::summarizeVcf`, pure/unit-tested;
    integration verified).
  - ⬜ Remaining: per-tool MultiQC sections (RSeQC/Picard) beyond general-stats.
    (MultiQC per-sample metric charts now render in the HTML report — see Phase 6.)
- ✅ **Correct multi-sample designs.** sarek now asks per-sample patient +
  tumor/normal (grouped by patient) and warns when a patient lacks a matched
  normal; rnaseq supports per-sample strandedness (shared default + overrides);
  users can point at an existing samplesheet, which is validated against the
  pipeline's column spec (`validateSamplesheetContent`, unit-tested).
  - ⬜ Remaining: deeper design checks (e.g. balanced conditions, lane merging).
  - ✅ **Content-based ingestion (extension-agnostic).** When a FASTQ folder has no
    `.fastq/.fq` files, Phase C sniffs file *content* — gzip magic bytes
    (decompressing just the head), a FASTQ record (`@` with a `+` line, told apart
    from SAM) or FASTA (`>`) — to recognize sequence files regardless of extension,
    and offers to **symlink them to canonical `.fastq(.gz)`/`.fasta(.gz)` names** so
    the pipeline (and its own name checks) accept them, then reuses the normal pair
    inference (`classifySequenceText`/`detectBinaryMagic`/`canonicalSequenceName`
    pure + `scanSequenceDir`/`linkCanonicalSequences`, unit-tested). **Honest
    limits (enforced):** it recognizes plain-text/gzipped FASTQ/FASTA only;
    aligned/binary formats (BAM/CRAM/HDF5-fast5) are detected by magic bytes and
    reported as unsupported ("convert to FASTQ first") rather than silently
    ignored; it links, never rewriting sequence data; grouping still follows the
    filename convention (ambiguous R1/R2 still asks). The same content fallback
    also covers the **protein-FASTA branch** (proteinfamilies): a FASTA recognized
    by content is symlinked to a canonical `.fasta` name. Unsupported binary
    formats are named specifically by magic bytes — BAM, CRAM, HDF5/fast5, POD5,
    SRA — so the "convert to FASTQ first" hint is precise (an undetected binary
    still degrades to a generic "binary" warning, never mislabeled as usable).
- ✅ **Schema-validated LLM outputs** with one self-correcting retry. Tool-call
  arguments (intent, pipeline selection, composition planning) are validated with
  Zod via `llm/structured.ts`; on a missing/invalid call the model is re-prompted
  once and, if it still fails, the caller falls back gracefully. Makes weaker local
  models (e.g. small Ollama models) far more reliable. Unit-tested with a mock
  provider; verified live end-to-end. Also tolerant of **strict server-side tool
  validation**: some endpoints (e.g. Groq) 400 when a model emits a wrong-typed
  argument — the boolean field accepts a stringified value (coerced on our side)
  and the OpenAI-compatible provider treats a `tool_use_failed` 400 as a retry/
  fallback signal rather than a fatal error, so a weak model's slip no longer
  aborts the session.
- ✅ **Reproducibility bundle.** Every run writes `run_manifest.json` +
  `PROVENANCE.md` into the run directory, capturing the pipeline + pinned revision,
  the exact command, resolved params (`params.yaml`), samplesheet, environment
  (Nextflow version, container engine, machine/OS), LLM used, and execution status
  — for prepared-but-not-run commands too (`execution/provenance.ts`, unit-tested).
  After a real run it also **captures the container images Nextflow actually used**
  — read from the nf-core execution trace (`pipeline_info/execution_trace_*.txt`)
  and recorded in the manifest + PROVENANCE.md, digest-pinned where the engine
  resolved one — for byte-exact reproduction (`parseTraceContainers`/
  `readRunContainers`, unit-tested; empty for conda/prepared runs, stated honestly).
- ✅ **Resume & re-run.** After a run, Hirsh offers to run it again — reusing cached
  results with `-resume`, or after changing one parameter (rebuilding `params.yaml`
  and the command, preserving the chosen backend/executor). The `-resume` flag is
  normalized so repeated re-runs never duplicate it; each re-run re-interprets the
  results (`applyResume`/`coerceLike` unit-tested).
- ✅ **The DE gap.** Pipelines can declare a `followUp`; rnaseq tells the user (at
  selection and in the results) that it produces counts and that
  `nf-core/differentialabundance` is the next step to actually call DEGs. When the
  `followUp` is **runnable** (a pinned revision plus wiring — `inputsFromUpstream`,
  `carryParams`, `requiredInputs`), Hirsh now **offers to run it directly** after
  interpreting the results: it maps the upstream count matrix into the follow-up's
  `--matrix`, carries over the annotation (`gtf`), asks only for what it can't
  infer (the sample-condition table and the contrasts), and launches it through
  the usual confirmed path, reusing the chosen backend/executor. Always confirmed,
  never a silent auto-chain (`execution/followUp.ts` pure builders unit-tested;
  `phaseFollowUp` wired). Its results are then **interpreted biologically like a
  primary run**: a runnable follow-up declares its key outputs, and Hirsh parses
  the per-contrast differential tables into concrete numbers — how many genes are
  significant and the up/down split (recognizing DESeq2/limma/edgeR column names;
  padj<0.05, |log2FC|>1 by default) — then asks the LLM for a plain-language
  summary in the context of the objective, revisiting the same pre-run design
  caveats and surfacing the HTML report (`results/parsers.ts::countDifferential`
  and the `de_table_dir` output kind, unit-tested). The follow-up is now a
  first-class run: a **light resource pre-flight** checks its declared memory
  guidance against the budget before running (honest ask if it won't fit; skipped
  on a scheduler), it's **recorded in project memory** (so it surfaces next
  session), and it gets its own **publication-ready methods** paragraph — the
  methods generator is shared with the primary run
  (`followUpResourceCheck`/`recordFollowUpRun`/`generateMethods`).
  - ⬜ Remaining: chain further follow-ups (a DAG of pipelines), and a runnable
    follow-up for pipelines beyond rnaseq.

## Phase 3 — Environment & infrastructure autonomy ✅ (shipped; Docker install stays guided)

Hirsh should manage *where and how* things run, not just *what* runs — this is
the heart of the "no technical knowledge required" promise. Backend selection,
per-process resource modeling, the executor abstraction, infrastructure
negotiation and container/data staging are in; full toolchain bootstrapping
(installing the backend itself) is the main gap.

- ✅ **Per-process resource modeling.** Pipelines can declare their heavy steps
  (`resources.processes`); the pre-flight then compares each step against the
  memory budget, shows a per-step fit breakdown, and names the specific
  bottleneck. It distinguishes a step whose memory can be capped (slower) from one
  with a hard floor (e.g. STAR/BWA-MEM2 genome indexing) that would simply run out
  of memory — so e.g. rnaseq on a 30 GB machine now *honestly refuses* (indexing
  needs ~38 GB and can't be reduced) instead of vaguely "adapting"
  (`assessProcesses` in `execution/resources.ts`, unit-tested; declared for rnaseq
  and sarek). Falls back to the whole-pipeline model when no steps are declared.
  A step can also declare `skipIfParams`: when the user supplies a prebuilt
  index/reference (or an iGenomes key), that step's memory floor is dropped from
  the assessment — so rnaseq on a 30 GB machine *refuses* when it must build the
  index but is *fine* when `--genome`/a STAR index is provided.
  - ⬜ Remaining: read real per-process peaks from Nextflow trace/execution reports
    instead of curated estimates.
- ✅ **Executor abstraction.** Before a run Hirsh asks *where* to run — local
  machine, an HPC scheduler (Slurm/SGE/LSF/PBS) or AWS Batch — and writes a small
  Nextflow `-c` config that sets `process.executor` (+ queue, and region/S3 work
  dir for AWS Batch), passed on the command line. This works with any pipeline
  without depending on a matching nf-core institutional profile. On a non-local
  executor the local-memory pre-flight is skipped (the scheduler sizes each job),
  and the chosen target is recorded in provenance (`execution/executor.ts`,
  unit-tested).
  - ⬜ Remaining: reuse existing nf-core/configs institutional profiles when the
    scientist names their cluster; Azure/GCP; per-executor account/credential checks.
- ✅ **Infrastructure negotiation.** When the local machine can't run a pipeline
  comfortably, Hirsh no longer just refuses: it presents concrete alternatives —
  cap and run slower here, move to an HPC cluster, or burst to AWS Batch — each
  with a rough **feasibility, time and cost** (e.g. "~$0.49/hour for a ≥38 GB
  node") and a clear recommendation, then carries out the choice (applying caps or
  re-pointing the executor). Estimates are deliberately rough and labeled as such
  (`execution/negotiation.ts`, unit-tested).
  - ⬜ Remaining: detect actual cluster availability/queues, real runtime estimates
    from prior runs, and live cloud pricing instead of a nominal rate.
- ✅ **Container & data staging.** Before a run Hirsh points image/env downloads at
  a stable cache so they're reused across runs (`NXF_SINGULARITY_CACHEDIR` /
  `NXF_CONDA_CACHEDIR`; Docker manages its own store), estimates the run's disk
  footprint (image footprint + input size read from the samplesheet + intermediate
  work ≈ 3× inputs), compares it to the free space on the run filesystem, and warns
  on disk pressure (ok / tight / insufficient) — refusing to silently start a run
  that would hit "no space left" (`execution/staging.ts`, unit-tested). Skipped on a
  non-local executor (data stages on the target).
  - ⬜ Remaining: real image sizes from the pipeline's container manifest, work-dir
    relocation to a bigger disk, and pruning the cache when it grows.
- ✅ **Toolchain bootstrapping.** On a fresh machine, Hirsh installs what's missing
  with explicit confirmation and makes it usable in the same session (prepending
  the new bin dirs to PATH): **Nextflow** (official installer), **Conda/Mamba**
  (the Miniforge installer, when no backend is available), and **Java 17+** for
  Nextflow (via Conda when present). Each degrades gracefully with guidance if it
  can't proceed (`execution/environment.ts::bootstrap{Nextflow,Conda,Java}`; the
  platform/PATH helpers are unit-tested).
  - ⬜ Remaining: Docker/Singularity install (needs root and is OS-specific, so it
    stays detect-and-guide), and a system JDK without Conda.
- ✅ **Interactive environment selection.** Before each run Hirsh detects which
  backends are actually available — **Docker, Singularity/Apptainer, Conda or
  Mamba** — recommends the most reproducible one present (keeping the configured
  default if available), and lets the scientist confirm or switch in a short Q&A;
  the choice sets the matching nf-core profile and is recorded in provenance
  (`execution/environment.ts`, unit-tested). Conda/Mamba are now supported backends.
  The choice can be **saved back to config** as the default (see Phase 6).
  - ⬜ Remaining: gate on Docker daemon reachability (not just the CLI being present).

## Phase 4 — Composing pipelines from nf-core building blocks ✅ (runnable; refinements remain)

The capability jump: instead of only *choosing* a whole pipeline, Hirsh
*assembles* one by connecting real, versioned **nf-core/modules**. When no
curated pipeline fits, Hirsh composes one from the live catalog, generates a
pinned nf-core-structured project with **channel-type-matched wiring**, and
validates that it **runs end-to-end** — a composed pipeline executes via
`-stub-run` with no hand-editing.

- ✅ **Live module registry.** Tracks [nf-core/modules](https://github.com/nf-core/modules)
  in real time: resolves the current commit, lists all ~1,900 modules, and
  parses each module's `meta.yml` (inputs/outputs/tools), cached per commit SHA.
- ✅ **Explainable composition.** The LLM proposes an ordered chain of real
  modules with a rationale per step; the scientist reviews it before generation.
- ✅ **Channel-type-matched synthesis.** A typed channel environment connects each
  module input to the right upstream output by data kind (reads, bam, vcf, fasta,
  indexes, reports…), rebuilds multi-file tuples (e.g. fastp's
  `[meta, reads, adapter]`), carries the `meta` map, routes reference inputs to
  pipeline params, collects reports into MultiQC, and gathers versions via the
  nf-core `versions` channel topic. Verified: real QC and alignment chains
  (fastqc→fastp→bwa/mem→samtools/sort→multiqc) run end-to-end.
  - ⬜ Remaining: smarter semantic disambiguation for unusual channel shapes and
    non-linear (branching/joining) DAGs; today's matcher targets linear flows and
    exposes best-effort choices for review. Also: **module-choice quality depends
    heavily on the model** — a small local model (e.g. Llama-8B/70B) tends to pick
    modules by fuzzy name match (proposing unrelated ones like `agat`/`hlala` for a
    protein-graph task), so surface a relevance/confidence signal per proposed
    module and let the scientist prune before generation (Claude picks far better).
- ✅ **nf-core principles by construction.** Generated projects include real
  modules installed from the pinned commit, `modules.json` with git-SHA-pinned
  modules, `nextflow_schema.json` + samplesheet schema, the `meta` map convention,
  version collection via the `versions` topic, `CITATIONS.md`, `.nf-core.yml`, and
  `nextflow.config` with container profiles, resource limits and a **mandatory
  `test` profile** (wired with placeholder data so the stub run works unedited).
  - ⬜ Remaining: bundled realistic `test`/`test_full` data, `nf-test` tests, and
    MultiQC report config by default.
- ✅ **Stub-run + lint validation.** `nextflow config` confirms the project parses,
  a `-profile test -stub-run` executes the whole DAG (no data/containers) as the
  real "does it run" gate, and — when the `nf-core` CLI is available — Hirsh offers
  to run **`nf-core lint` in the loop**, parsing the pass/warn/fail counts and
  surfacing the top failures (advisory: a freshly composed project isn't fully
  green yet). Degrades gracefully when the CLI is missing/unusable
  (`composition/validate.ts::lintPipeline`, parser unit-tested).
  - ⬜ Remaining: a functional test on real data, and iterating fixes until lint is
    green (see Phase 5).
- ✅ **Custom & non-nf-core tools.** A composed pipeline is no longer limited to the
  catalog. During composition Hirsh can take a scientist's own tool/script and
  generate a standards-compliant `modules/local/<name>/main.nf` — the `meta` map, a
  container/conda directive, `versions.yml`, a `when:` guard and a `stub:` block —
  then wire it into the workflow like any nf-core module (mixing `modules/nf-core/`
  with `modules/local/`, as real nf-core pipelines do). Verified end-to-end: a
  pipeline with a generated local module executes via `-profile test -stub-run` with
  no edits (`composition/localModule.ts`, unit-tested).
  - ✅ The LLM now also *proposes* local tools: during composition it flags steps the
    objective needs that the selected nf-core modules don't cover and proposes a
    minimal custom tool (command sketch, I/O kinds, conda/container if a real tool
    fits) for each gap, which the scientist reviews before it's added
    (`composition/localToolProposal.ts`, schema-validated, unit-tested).
  - ✅ The manual custom-tool collector is now **scientist-friendly**: recommended
    options with plain descriptions instead of nf-core jargon (see Phase 1).
  - ⬜ Remaining: multi-input local modules, per-tool test data, and a
    **visualization output** convention (a graph/network or an interactive HTML
    report as a first-class, recommended output kind) so composed analyses can be
    *seen*, not just produced.

## Phase 5 — Contributing back to the community 🔵 (largely shipped)

When Hirsh builds something new and good, it should help share it — turning a
one-off analysis into reusable, community-grade software.

- ✅ **Standards-compliant packaging.** With explicit opt-in, Hirsh adds the files a
  full nf-core template carries and that lint flags as missing — `LICENSE` (MIT by
  default), `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `.gitignore`, a CI workflow, and
  `docs/usage.md` + `docs/output.md` — and fills in the `nextflow.config` manifest
  (author/homePage). It then `git init`s the project with an initial commit (which
  also stops lint failing for "not a git repository") and re-runs lint to show the
  improvement (`composition/packaging.ts` + `execution/git.ts`, unit-tested; the
  patched config verified to still parse).
  - ⬜ Remaining: generated `nf-test` tests and full-size `test`/`test_full` data.
- ✅ **Local quality gate (iterates toward green).** `nf-core lint` runs in the
  composition loop, and after packaging Hirsh now **iterates lint → auto-fix →
  lint** (up to 3 rounds): it applies the fixes it can — re-adding missing standard
  files and manifest fields, and stripping leftover `TODO nf-core:` markers (never
  rewriting pinned `modules/nf-core` files) — and stops when the project is
  lint-clean or the failure count stops improving, reporting the trajectory
  (e.g. `12 → 6 → 5`). Packaging also writes more of the standard files lint
  expects (`.editorconfig`, `.gitattributes`, `CITATION.cff`, `.github/CONTRIBUTING.md`,
  a PR template). Honest that the remaining failures (`files_unchanged`, schema
  specifics) need the full nf-core template or manual edits — a freshly composed
  pipeline won't be fully green yet (`composition/lintFix.ts`:
  `planLintFixes`/`stripNfCoreTodos`/`shouldContinueFixing`, pure/unit-tested;
  `iterateLintFixes` wired).
  - ⬜ Remaining: reach a fully green lint by generating from the official nf-core
    template (`nf-core pipelines create`) rather than a minimal scaffold.
- 🔵 **Assisted contribution.** For a custom local tool, Hirsh writes it out in the
  nf-core/modules layout — `main.nf` (no generator comment), `meta.yml`,
  `environment.yml` (conda) and an `nf-test` stub test with the right tags — under
  `contributions/<name>/`, then guides the PR (fork, add real test data, run
  `nf-core modules test`/`lint`, open the PR). Opening the PR stays a deliberate
  human step, and Hirsh is explicit that nf-core acceptance is a community decision
  (`composition/contribution.ts`, unit-tested).
  - ⬜ Remaining: automate the fork+branch+draft-PR via `gh` (with consent), and
    generate the nf-test snapshot from real bundled test data.
- ✅ **Publish a whole pipeline.** With explicit, double confirmation and defaulting
  to **private**, Hirsh creates and pushes a GitHub repository via the `gh` CLI
  (`execution/publish.ts`). It warns plainly that a public repo is visible and may
  be indexed/cached, checks `gh auth`, and never publishes without consent; it does
  not handle credentials itself.
  - ⬜ Remaining: reach a green `nf-core pipelines lint` and bundle full-size test
    data before recommending publication.
- ✅ **nf-core inclusion guidance.** After packaging, Hirsh can write a step-by-step
  `NFCORE_INCLUSION.md` guide: a name check (nf-core naming rules, with a normalized
  suggestion), the scope proposal (Slack #new-pipelines / nf-core/proposals), the
  official-template + lint + full-test-data + review requirements, and the
  request/creation steps — stating plainly that acceptance is a community decision it
  cannot guarantee (`composition/inclusion.ts`, unit-tested).
- ✅ **Try-before-you-publish.** Once a composed pipeline validates it runs
  (`-stub-run`), Hirsh offers to **run it on the scientist's own data** first: it
  reuses the normal backend/executor selection, asks for the input samplesheet and
  each reference parameter (all `@`-path aware and skippable), executes it, and
  gives a light biological interpretation of the outputs (directory listing + HTML
  reports). Best-effort — a composed pipeline is a draft, so a failed run is
  reported and the flow continues. Packaging/publishing is now framed as an ongoing
  **recommendation** rather than a linear gate: a gentle "when you're happy, I can
  help you share it" before packaging, and a closing reminder that publishing/
  contributing is always available and feedback welcome
  (`composition/run.ts::buildComposedRunCommand` unit-tested; `offerComposedRun`
  wired). The scientist can also choose to **run the composed pipeline's `test`
  profile** first (a smoke test on placeholder data, labelled honestly), and if a
  real run is chosen without an input samplesheet Hirsh doesn't launch a doomed run
  — it warns and offers the test profile instead.
  - ✅ **Builds the composed pipeline's samplesheet** from a sequence file/folder:
    at the input step the scientist can point at a `.fasta`/`.fastq` (or a folder)
    with `@`, and Hirsh writes the `sample,fastq_1,fastq_2` sheet — inferring FASTQ
    pairs, recognizing sequences by content when extensions are non-standard, or one
    row for a single file — instead of demanding a hand-written CSV
    (`composedRowsFromFiles`/`resolveComposedInput`, unit-tested).
  - ⬜ Remaining: match the composed input *channel* to the actual data kind (today
    the generator hard-codes a reads-style reader, so a protein FASTA is wired
    generically); bundle realistic test data so the test profile gives *real*
    results, not just a smoke test; and a fuller results interpretation from
    declared outputs.
- ✅ **Provenance for novelty.** Generated projects separate what was reused from
  what's new: `CITATIONS.md` lists nf-core tools and, under a distinct heading, the
  custom local tools ("not from nf-core"); `modules.json` pins only the real nf-core
  modules. Every composed project also gets a **`NOVELTY.md` manifest** summarizing
  the reused nf-core modules (pinned to the commit SHA) vs the new custom tools,
  with a one-line count — an honest, at-a-glance origin record
  (`composition/novelty.ts`, unit-tested).

## Phase 6 — The zero-technical-knowledge co-scientist

The full realization: a scientific collaborator, not a command builder.

- ✅ **Project workspaces.** Like opening an editor (or Claude Code) in a
  directory, Hirsh runs inside the scientist's own **project folder** — so a
  researcher keeps a dedicated folder per study instead of everything piling up
  inside the Hirsh install. The workspace is chosen with `hirsh [path]`,
  `--workdir/-C <path>`, `HIRSH_WORKSPACE`, or the current directory; Hirsh
  `chdir`s into it, so `./config.yaml`, `./runs` and per-project memory
  (`<workspace>/.hirsh/memory.json`) are all workspace-local, and the banner shows
  the workspace. **Per-project history**: each project keeps its own remembered
  runs and environment-preference defaults, so juggling projects doesn't mix them
  (an explicit `config.memory.path` still overrides for a shared store)
  (`cli/workspace.ts::resolveWorkspace` pure + unit-tested;
  `memory/store.ts::defaultMemoryPath(baseDir)`).
  - ✅ **`hirsh init [path]`** scaffolds a workspace — a starter `config.yaml`, a
    `.gitignore` (keeping `runs/` and the private `.hirsh/` out of git), and the
    `.hirsh/` data dir. Safe and idempotent: never overwrites an existing file,
    only tops up missing `.gitignore` entries (`cli/init.ts`:
    `starterConfigYaml`/`mergeGitignore`/`runInit`, unit-tested).
  - ⬜ Remaining: optionally per-project curated pipelines
    (`<workspace>/.hirsh/pipelines`) in addition to the global ones; and a `runs/`
    index/listing command.
- ✅ **Automatic public-data retrieval.** A scientist rarely has FASTQ files on
  hand — they have *accession numbers* from a paper. Hirsh now recognizes public
  accessions in the request (SRA/ENA/DDBJ runs, experiments, studies; GEO series/
  samples; BioProject/BioSample; ArrayExpress) and, after pipeline selection,
  offers to **download the data with nf-core/fetchngs** and build a samplesheet —
  formatted for the target pipeline via `--nf_core_pipeline` when supported —
  which then feeds Phase C, so parameterization skips manual samplesheet
  construction. The download runs through the same confirmed-execution path and
  degrades gracefully to asking for local files if there are no accessions, the
  user declines, the toolchain is missing, or the run fails (`execution/fetchngs.ts`
  detection/command builders unit-tested; `phaseFetchData` + the Phase C
  fetched-data guard wired and unit-tested). When fetchngs **can't** format the
  samplesheet for the target pipeline (it supports rnaseq/atacseq/… but not sarek),
  Hirsh **re-shapes** it: it pulls the FASTQ pairs from the generic samplesheet and
  Phase C builds the pipeline's proper one — for sarek, asking per-sample patient +
  tumor/normal — so "fetch public data → run sarek" works too
  (`fastqPairsFromSamplesheet` + `session.fetchedPairs`, unit-tested).
  - ⬜ Remaining: resolve/preview sample metadata before downloading, and cache
    fetched data across runs.
- 🔵 **Project memory.** Hirsh remembers past analyses across sessions in a local,
  private JSON store (`~/.bioagent/memory.json`): each run's pipeline, intent
  (organism/data/objective), references used, outdir and status. When a new request
  resembles a past one it surfaces the relevant history ("similar past analyses:
  …"), so it behaves like a collaborator that remembers rather than a command
  builder that forgets. During parameterization it also **offers to reuse a
  remembered reference** (genome/FASTA/GTF) or **samplesheet** from a relevant past
  run, so you don't re-enter them. Enabled by default, disable with
  `memory.enabled: false` (`memory/store.ts` + Phase C reuse, unit-tested;
  persistence verified round-trip).
  - ✅ **Remembered environment preferences.** Memory also records the execution
    backend and executor (with queue) each run used, and before the next run Hirsh
    **defaults to the backend/executor last used on this machine** (memory is
    per-home, so per-machine) instead of the static config — announcing it ("the
    last run on this machine used Conda; I'll default to it") and still letting you
    switch. Stale/invalid records are ignored, so a bad value can't force a wrong
    default (`preferredEnvironment` in `memory/store.ts`, unit-tested; wired into
    the backend/executor selection). This directly serves the multi-machine story:
    your laptop keeps defaulting to Docker+local, your HPC login node to
    Singularity+Slurm, without re-picking each session.
  - ✅ **First-run consent.** Memory no longer records silently: on the first run
    Hirsh asks once whether it may remember analyses (stating plainly the store is
    local and never uploaded), persists the answer (`consent` in the store), and
    never asks again; declining gates off all memory reads/writes
    (`ensureMemoryConsent`/`memoryEnabled`, unit-tested).
  - ✅ **Persist the env choice to config.** When the chosen backend/executor
    differs from config, Hirsh offers (once per session, opt-in) to save it as the
    default, editing the config file in place with the YAML Document API so
    **comments and the rest of the file are preserved** (creating a clean block map
    if there's no file yet). Works even when memory is off
    (`config/writeConfig.ts::updateExecutionConfig`, unit-tested).
- 🔵 **Scientific dialogue.** Between understanding the intent and choosing a
  pipeline, Hirsh reviews the **experimental design** — biological replication,
  controls, confounders and batch effects, group balance, fit to the objective —
  and reports constructive, plain-language observations graded info/caution/risk
  with suggestions. Advisory (it asks whether to continue on a serious concern,
  never blocks). Schema-validated LLM output; verified live (it caught n=2
  under-replication and a treatment/processing-date batch confound)
  (`conversation/designReview.ts`, unit-tested).
  - ✅ Extended to results: the pre-run caveats (batch effects, low replication) are
    carried into Phase E, where the interpretation revisits their impact and
    explains findings biologically in the context of the objective, ending with a
    concrete next step (`results/interpreter.ts`, prompt wiring unit-tested).
  - ✅ **Grounded in the built samplesheet.** The review now reasons about what the
    samplesheet actually *contains*, not only what was described: after Phase C
    builds it, Hirsh finds the grouping column (condition/treatment/status…),
    counts **biological replicates per group** (merging technical replicates that
    share a sample id), and raises concrete, deterministic concerns — a group with
    no replication (risk), the bare minimum of two (caution), or badly unbalanced
    groups (caution) — surfacing the per-group counts even when the design is sound.
    Advisory (the run confirmation is the decision point), and merged into
    `session.designReview` so Phase E revisits them
    (`conversation/samplesheetReview.ts::reviewSamplesheetContent`, pure/unit-tested).
  - ✅ **Suggests controls and builds the contrasts.** The review now recognizes a
    control/reference level (untreated/vehicle/WT/normal/day0…) among the groups
    and flags when none is present (a clear reference is needed for any
    comparison). And in the differential-abundance follow-up, when the scientist
    provides the condition samplesheet, Hirsh **reviews it too** (per-group
    replicates, missing control) and **proposes the contrasts** from its grouping
    column — each group vs the detected control, or vs an assumed reference
    (flagged) when none is recognizable — writing a reviewed `contrasts.csv`
    instead of demanding a hand-written one (always confirmed; they can supply
    their own) (`conversation/contrasts.ts` + `samplesheetReview.ts::detectControlGroup`,
    pure/unit-tested; `collectFollowUpInputs` wired).
  - ✅ **Batch confounding / covariate.** The review inspects a technical batch
    variable (batch/lane/run/date/prep…) against the condition: it flags a
    **confounded** design (risk — every batch holds one condition, so batch can't
    be separated from biology) or, when batch crosses conditions, recommends
    modelling it as a **covariate** (`~ batch + condition`)
    (`samplesheetReview.ts::classifyBatchDesign`, pure/unit-tested).
  - ✅ **Blocking factor in the contrasts.** When a batch **crosses** the
    conditions, the proposed contrasts carry it as a `blocking` factor (the CSV
    gains a blocking column) so differentialabundance models the batch out; a
    *confounded* batch is not added (it isn't a usable covariate)
    (`contrasts.ts::proposeContrasts`/`proposeContrastsFromSheet`, unit-tested).
  - ⬜ Remaining: propose interaction contrasts for a full multi-factor design.
- 🔵 **Publication-ready output.** After interpreting results, Hirsh generates a
  paste-ready **methods paragraph** and references (`METHODS.md`) from the run's
  pinned pipeline + Nextflow versions, the container engine, and the *real* tool
  versions nf-core records in `pipeline_info/…software_versions` — with the
  pipeline's citation (DOI) plus the nf-core and Nextflow papers
  (`results/methods.ts`, unit-tested; verified render).
  - ✅ **Shareable HTML report.** After interpreting a run, Hirsh writes a
    self-contained `REPORT.html` into the run directory — the plain-language
    interpretation, the study metadata, the key numbers (outputs table, flagging
    anything not generated), **inline SVG figures** (per-sample library sizes,
    significant genes per contrast — no external libraries), and links to the
    MultiQC report, `METHODS.md` and `PROVENANCE.md`. It opens in any browser and
    is safe to share or archive (no external dependencies). Wired into all four
    interpretation paths — primary, composed, follow-up and established/test-profile
    runs — by capturing the summary the interpreter already produces
    (`results/report.ts`: `chartToSvg`/`renderResultsReportHtml` pure + unit-tested;
    `writeResultsReport` best-effort, never blocks a run).
    - ✅ **Volcano plots.** Every differential-expression contrast (a `de_table_dir`
      output) gets a **volcano plot** in the report — the canonical DE figure,
      log2FC vs -log10 padj, significant up/down genes coloured, thresholds drawn —
      as a dependency-free inline SVG. The parser keeps all significant points and
      down-samples the rest so the figure stays small (`parsers.ts::extractVolcano`
      + `report.ts::volcanoToSvg`, pure/unit-tested; verified on a 2,000-gene table).
    - ✅ **MultiQC per-sample metric charts.** The report also draws a per-sample bar
      chart for each numeric MultiQC general-stats metric (%GC, %dups, read counts,
      %aligned…) — so QC differences across samples are visible at a glance. Skips
      non-numeric/constant metrics and caps the count; report-only so the terminal
      stays lean (`parsers.ts::metricSeries`/`prettyMetric`, pure/unit-tested).
  - ⬜ Remaining: per-tool citations inline in the report (today they point to
    CITATIONS.md); and an optional PDF export.
- 🔵 **End-to-end autonomy with guardrails.** With `autonomy.enabled` (or `--auto`),
  Hirsh runs a request to an interpreted answer without pausing for reversible
  confirmations — it auto-answers those with their intended value and announces each
  `[auto]` decision — while still **asking for genuinely missing information** and
  **stopping at decisions only a human should make**: publishing, overriding a
  safety recommendation (resource/disk refusal), or running against advice.
  Implemented as an `AutonomousIO` decorator over the confirmation layer, so the
  guardrail is structural: consequential confirms are tagged and never auto-answered
  (`cli/autonomousIO.ts`, unit-tested).
  - ✅ **Derives the reference from the organism.** Rather than blocking on "which
    genome?", Hirsh maps the organism to its iGenomes key (human→GRCh38,
    mouse→GRCm39, and rat/zebrafish/fly/worm/yeast/arabidopsis/…), constrained to
    the pipeline's accepted keys. In autonomous mode it fills the reference itself
    (`[auto] genome → GRCh38`); interactively it offers the derived key as the
    prompt default. Prefers a remembered key over a derived one, so it combines with
    per-project memory (first run derives, later runs remember); an underivable
    organism still asks — genuinely missing info is never fabricated
    (`conversation/inference.ts::deriveGenomeKey`, pure/unit-tested; wired into
    `fillReferenceParams`).
  - ⬜ Remaining: derive more from context/memory (data type, common optional
    params) and a fully non-interactive one-shot that never blocks (e.g. falls back
    to the test profile when a required input truly can't be resolved).

---

## Cross-cutting principles (hold across every phase)

- **Human-in-the-loop for consequential actions.** Explicit confirmation before
  running, deleting, spending, or publishing — no exceptions.
- **nf-core compliance is non-negotiable** for anything Hirsh generates.
- **Reproducibility & provenance by default** — pinned versions, container digests,
  saved params, and a record of what was done and why.
- **Honesty over optimism** — when something is unlikely to work (too little RAM,
  a bad pipeline match), say so plainly and recommend the better path.
- **Provider- and frontend-agnostic** — the conversation logic never hard-codes a
  specific LLM or a specific UI.

## North-star capability checklist

- ⬜ Understands biological intent without the tool being named
- ✅ Fetches public data from accessions on its own (SRA/ENA/GEO/… via nf-core/fetchngs → samplesheet)
- ✅ Selects the right existing pipeline — from the curated set, and (when none is curated) recommends the established nf-core pipeline from the live catalog of ~100 and runs it on the scientist's own data via a schema-synthesized interview (or its test profile); it can then **curate that pipeline** so the guided set grows itself
- ✅ Composes a new pipeline from nf-core modules when none fits (runs via stub; complex DAGs still benefit from review)
- 🔵 Negotiates compute (adapt / relocate / provision) with rough cost & time estimates (live pricing and real runtime estimates next)
- ✅ Sets up its own toolchain & environment (picks Docker/Singularity/Conda/Mamba, and installs Nextflow, Conda/Mamba and Java on a fresh machine; Docker install stays guided)
- 🔵 Runs on laptop, HPC and cloud transparently (executor selection for local/Slurm/SGE/LSF/PBS/AWS Batch today; Azure/GCP and credential handling next)
- ✅ Composes pipelines that mix nf-core modules with the scientist's own tools (generated modules/local/ + nf-core, runs via stub)
- ✅ Interprets results as science, quantitatively and biologically — concrete numbers, meaning in context of the objective, and revisiting pre-run design caveats
- 🔵 Produces reproducible, publication-ready provenance (run manifest + PROVENANCE.md, a paste-ready methods paragraph, and a self-contained REPORT.html with inline figures; richer figures and per-tool inline citations next)
- 🔵 Contributes novel, standards-compliant modules and pipelines back to nf-core (packages + publishes to GitHub today; nf-core/modules PRs and inclusion next)
- 🔵 Requires zero Nextflow/infra knowledge from the scientist (guided throughout; an autonomous mode runs reversible steps unattended and derives references from the organism)
