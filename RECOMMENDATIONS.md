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
- ✅ Swappable LLM backends (Ollama, Anthropic) behind one interface
- ✅ Extensible pipeline registry (rnaseq, sarek, proteinfamilies)
- ✅ Samplesheet construction with FASTQ pair inference
- ✅ Live Nextflow streaming, explicit run confirmation
- ✅ Plain-language results summary + MultiQC pointer
- ✅ Terminal UX (ASCII logo, framed banner, tips), global `hirsh` command

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
- 🔵 Wire `npm test` into CI (GitHub Actions running build + tests).

---

## Phase 2 — Robust, reproducible, and genuinely informative

Make every supported pipeline safe to run for real and make its output land as
*science*.

- 🔵 **Validate definitions against upstream.** Check each pinned pipeline against
  its real `nextflow_schema.json` so params/defaults never silently drift.
- ✅ **Richer, quantitative interpretation.** Phase E now reads the numbers that
  matter — per-sample library sizes/column totals from count matrices, per-sample
  metrics from MultiQC's `multiqc_general_stats.txt`, and variant counts from VCFs
  (incl. `.vcf.gz`) — and hands the LLM concrete figures instead of file listings
  (pure parsers in `results/parsers.ts`, unit-tested).
  - ⬜ Remaining: per-tool detail (RSeQC/Picard sections, variant-type breakdowns)
    and small inline tables/charts.
- ✅ **Correct multi-sample designs.** sarek now asks per-sample patient +
  tumor/normal (grouped by patient) and warns when a patient lacks a matched
  normal; rnaseq supports per-sample strandedness (shared default + overrides);
  users can point at an existing samplesheet, which is validated against the
  pipeline's column spec (`validateSamplesheetContent`, unit-tested).
  - ⬜ Remaining: deeper design checks (e.g. balanced conditions, lane merging).
- ⬜ **Schema-validated LLM outputs** with one self-correcting retry, so weaker
  local models stay reliable.
- ⬜ **Reproducibility bundle.** Persist the resolved `params.yaml`, pipeline
  revision, container digests, samplesheet and a plain-language provenance record
  per run under a run directory the scientist can archive or share.
- ⬜ **Resume & re-run.** Offer `-resume` and "run this again with one change".
- ⬜ **The DE gap.** Present rnaseq → `differentialabundance` as an explicit next
  step so "differentially expressed genes" actually gets answered.

## Phase 3 — Environment & infrastructure autonomy

Hirsh should manage *where and how* things run, not just *what* runs — this is
the heart of the "no technical knowledge required" promise.

- ⬜ **Per-process resource modeling.** Move beyond whole-pipeline memory to the
  real bottleneck steps (e.g. STAR indexing), so adapt/refuse verdicts are precise
  and Hirsh can say *which* step won't fit and why.
- ⬜ **Executor abstraction.** Run locally, on HPC schedulers (Slurm/SGE) or in the
  cloud (AWS Batch, Azure, GCP) by choosing profiles and executors — the scientist
  just says "run it on the cluster".
- ⬜ **Infrastructure negotiation.** When the local machine can't do it, Hirsh
  proposes concrete alternatives: cap and run slower, move to an available cluster
  queue, or provision/burst to cloud — with an **estimated time, cost, and
  feasibility** for each, and a clear recommendation.
- ⬜ **Container & data staging.** Manage image pulls (Docker/Singularity/Apptainer),
  cache locations, and staging of large inputs; detect and explain disk pressure.
- ⬜ **Automatic public data retrieval.** `fetchngs` from SRA/ENA accessions so a
  scientist can start from "these GEO samples" with no local files.

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
    exposes best-effort choices for review.
- ✅ **nf-core principles by construction.** Generated projects include real
  modules installed from the pinned commit, `modules.json` with git-SHA-pinned
  modules, `nextflow_schema.json` + samplesheet schema, the `meta` map convention,
  version collection via the `versions` topic, `CITATIONS.md`, `.nf-core.yml`, and
  `nextflow.config` with container profiles, resource limits and a **mandatory
  `test` profile** (wired with placeholder data so the stub run works unedited).
  - ⬜ Remaining: bundled realistic `test`/`test_full` data, `nf-test` tests,
    MultiQC report config by default, and a green `nf-core lint` gate.
- ✅ **Stub-run validation.** `nextflow config` confirms the project parses and a
  `-profile test -stub-run` executes the whole DAG (no data/containers) as the
  real "does it run" gate.
  - ⬜ Remaining: `nf-core lint` in the loop and a functional test on real data.

## Phase 5 — Contributing back to the community

When Hirsh builds something new and good, it should help share it — turning a
one-off analysis into reusable, community-grade software.

- ⬜ **Standards-compliant packaging** of a novel module or subworkflow via the
  nf-core template, with metadata, tests and documentation generated.
- ⬜ **Local quality gate.** Run `nf-core lint` and `nf-test` and iterate until green.
- ⬜ **Assisted contribution.** Draft a module/subworkflow proposal and open a PR to
  nf-core/modules (or the relevant pipeline) — always with explicit human review
  and consent before anything is published.
- ⬜ **Provenance for novelty.** Clearly attribute what was reused vs. newly created,
  so contributions are honest and reviewable.

## Phase 6 — The zero-technical-knowledge co-scientist

The full realization: a scientific collaborator, not a command builder.

- ⬜ **Project memory.** Remember a scientist's datasets, references, past analyses
  and preferences across sessions (opt-in, private).
- ⬜ **Scientific dialogue.** Discuss experimental design, suggest appropriate
  analyses and controls, flag confounders and batch effects, and reason about the
  results' biological meaning.
- ⬜ **Publication-ready output.** Generate figures, methods paragraphs (with correct
  citations and exact versions) and reproducible reports.
- ⬜ **End-to-end autonomy with guardrails.** Take a question all the way to an
  interpreted answer, pausing only at the decisions that are the human's to make —
  destructive actions, spending money, or publishing.

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
- ✅ Selects the right existing pipeline
- ✅ Composes a new pipeline from nf-core modules when none fits (runs via stub; complex DAGs still benefit from review)
- ⬜ Negotiates compute (adapt / relocate / provision) with cost & time estimates
- ⬜ Runs on laptop, HPC and cloud transparently
- ✅ Interprets results as science, quantitatively (numbers today; deeper per-tool detail next)
- ⬜ Produces reproducible, publication-ready provenance
- ⬜ Contributes novel, standards-compliant modules back to nf-core
- ⬜ Requires zero Nextflow/infra knowledge from the scientist
