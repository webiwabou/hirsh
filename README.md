# Hirsh

A conversational bioinformatics agent for the terminal. It takes you from a
plain-language request ("I want to analyze RNA-seq from these samples to find
differentially expressed genes") to running the right
[nf-core](https://nf-co.re) pipeline and interpreting its results.

Hirsh works in phases: it understands your biological intent, picks the
pipeline, parameterizes it with you, runs it with Nextflow (only after your
explicit confirmation) and explains the results in plain language.

> **Where it is today.** Supports three curated pipelines (`rnaseq`, `sarek`,
> `proteinfamilies`) and two LLM backends (local Ollama and the Anthropic API),
> with resource-aware execution (it checks whether your machine can actually run
> the pipeline and adapts or advises against it). When no curated pipeline fits,
> it first **recommends an established nf-core pipeline** from the live catalog of
> ~100 (e.g. `atacseq`, `methylseq`, `scrnaseq`) and can **run it on your own
> data** — reading the pipeline's own schema to ask only for the samplesheet and
> references it needs — or run its bundled test profile; failing that, it can
> **compose a new one from the live
> [nf-core/modules](https://github.com/nf-core/modules) catalog** and generate a
> pinned, nf-core-structured project (a reviewable draft). See
> [ARCHITECTURE.md](ARCHITECTURE.md) for the design and how to extend it, and
> [RECOMMENDATIONS.md](RECOMMENDATIONS.md) for the roadmap toward a full
> bioinformatics **co-scientist** (composing pipelines from nf-core modules,
> managing HPC/cloud infrastructure, contributing modules back to nf-core, and
> requiring zero technical knowledge from the scientist).

```
    ●──●──●  hirsh   ·   bioinformatics co-scientist
```

## Requirements

- **Node.js ≥ 20** (tested on Node 26).
- **Nextflow** on `PATH` — required to run pipelines. If it's missing, Hirsh can
  install it for you (official installer) with your confirmation, or you can
  install it yourself: `curl -s https://get.nextflow.io | bash`.
- An **execution backend** — **Docker**, **Singularity/Apptainer**, **Conda** or
  **Mamba**. Before a run Hirsh detects which of these are available and lets you
  pick one interactively (recommending the most reproducible option present). On a
  fresh machine it can install **Conda/Mamba** (Miniforge) and **Java** for you
  with confirmation; Docker/Singularity installs stay guided (they need root).
- An **LLM backend** (any one):
  - **Ollama** running locally (`ollama serve`) with a tool-calling capable model
    pulled (`ollama pull <model>`),
  - an **Anthropic API key** (Claude) in an environment variable, **or**
  - any **OpenAI-compatible endpoint** — including **free tiers** like
    [Groq](https://console.groq.com), [Google Gemini](https://aistudio.google.com)
    and Cerebras. Handy to try Hirsh with a non-local model before you have Claude
    credits (see [No local model and no Claude credits yet?](#no-local-model-and-no-claude-credits-yet)).

Hirsh checks Nextflow and the execution backend at startup and again before a
run. If something is missing it tells you (and offers to install Nextflow), and
**does not run** pipelines until it's resolved — but you can still converse and
prepare the command.

## Installation

```bash
npm install
npm run build
```

This compiles TypeScript to `dist/`. To start:

```bash
npm start
# or, in development (no build) with direct TS execution:
npm run dev
```

### Run `hirsh` from anywhere

Once built, expose the `hirsh` command globally. Pick the option that matches
your setup:

```bash
# Option A — npm global link (uses your npm prefix; may need sudo if it is /usr):
npm link

# Option B — no sudo: a small launcher in a user bin dir already on PATH
#            (e.g. ~/.local/bin). Adjust the project path if you move it.
cat > ~/.local/bin/hirsh <<'EOF'
#!/bin/sh
exec node "$HOME/Projects/hirsh-agent/dist/cli/index.js" "$@"
EOF
chmod +x ~/.local/bin/hirsh
```

Then just run `hirsh` from any directory. When run outside the project, put your
configuration in `~/.bioagent/config.yaml` (see below) so it is always found.

### Project workspaces

Hirsh works like an editor opened in a directory: it operates inside a
**workspace** — your project folder — so each study keeps its own runs, config and
history instead of everything piling up in one place. Point Hirsh at a folder in
any of these ways (highest precedence first):

```bash
hirsh /path/to/my-study      # a bare path argument
hirsh --workdir /path/to/my-study   # or -C /path/to/my-study
HIRSH_WORKSPACE=/path/to/my-study hirsh
cd /path/to/my-study && hirsh       # or just launch from inside it
```

Inside the workspace, Hirsh reads `./config.yaml`, writes runs to `./runs/…`, and
keeps **per-project memory** in `./.hirsh/memory.json` — so different projects
don't mix their remembered analyses or environment defaults. The banner shows the
active workspace. (Set `memory.path` in config to share one memory store across
projects instead.)

To scaffold a new workspace, run **`hirsh init [path]`**: it creates a starter
`config.yaml`, a `.gitignore` (keeping `runs/` and the private `.hirsh/` out of
git), and the `.hirsh/` data directory. It's safe to re-run — it never overwrites
an existing file and only tops up a missing `.gitignore` entry.

```bash
hirsh init my-study    # scaffold ./my-study
cd my-study
hirsh                  # start working in it
```

## Configuration

Copy the example and edit it:

```bash
cp config.example.yaml config.yaml
```

Hirsh looks for configuration in this order:

1. Path in the `HIRSH_CONFIG` environment variable.
2. `./config.yaml` (current directory).
3. `~/.bioagent/config.yaml`.

If none is found, it uses defaults (local Ollama).

### Example — Ollama (local)

```yaml
provider: ollama
ollama:
  host: http://localhost:11434
  model: llama3.1:8b        # must be pulled and support tool calling
  temperature: 0.2
execution:
  containerEngine: docker   # default backend: docker | singularity | conda | mamba
                            # (you can switch interactively before each run)
  executor: local           # where jobs run: local | slurm | sge | lsf | pbs | awsbatch
                            # (you also pick this interactively before each run)
  # queue: short            # default queue/partition for cluster executors
  workdir: ./runs
  # Optional resource caps for real runs (nf-core --max_memory / --max_cpus).
  # If unset, Hirsh uses the detected machine as the budget.
  # maxMemory: 30.GB
  # maxCpus: 8
memory:
  enabled: true             # remember past analyses across sessions (local, private)
  # path: ~/.bioagent/memory.json
autonomy:
  enabled: false            # or pass --auto: run reversible steps unattended,
                            # still asking for missing info and consequential decisions
```

> **Tool calling required.** Intent extraction and pipeline selection use tool
> calls, so pick an Ollama model that supports them (e.g. `llama3.1`, `qwen2.5`,
> `mistral`). Small/old models without tool support will not work well.

### Example — Anthropic (Claude)

```yaml
provider: anthropic
anthropic:
  apiKeyEnv: ANTHROPIC_API_KEY   # NAME of the env var, not the key itself
  model: claude-fable-5          # any tool-calling-capable Claude model works
  temperature: 0.2
  maxTokens: 4096
execution:
  containerEngine: docker
  workdir: ./runs
```

The API key is **never** written in the config file. It is read from the
environment variable named in `apiKeyEnv`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Example — OpenAI-compatible (Groq / Gemini / …)

```yaml
provider: openai
openai:
  baseUrl: https://api.groq.com/openai/v1   # any OpenAI-compatible endpoint
  model: llama-3.3-70b-versatile            # must support tool/function calling
  apiKeyEnv: GROQ_API_KEY                    # NAME of the env var, not the key
  temperature: 0.2
  maxTokens: 4096
execution:
  containerEngine: docker
  workdir: ./runs
```

### No local model and no Claude credits yet?

You can try Hirsh right now on a **free**, non-local model — no Claude credits and
no GPU needed — because the `openai` provider works with any OpenAI-compatible
endpoint, and several have free tiers with the **tool calling** Hirsh needs:

- **[Groq](https://console.groq.com)** (recommended to start): sign up, create an
  API key, and use `baseUrl: https://api.groq.com/openai/v1` with a tool-calling
  model like `llama-3.3-70b-versatile`. Then `export GROQ_API_KEY=gsk_...`.
- **[Google Gemini](https://aistudio.google.com)**: free API key; use
  `baseUrl: https://generativelanguage.googleapis.com/v1beta/openai`, model
  `gemini-2.0-flash`, `apiKeyEnv: GEMINI_API_KEY`.
- **Cerebras / OpenRouter**: also free tiers; same shape, different `baseUrl`.

The key is read from the env var you name in `apiKeyEnv` (never written to the
config). When your Claude credits arrive, just switch `provider: anthropic` — the
rest of your setup is unchanged. A **keyless local** OpenAI server (vLLM, LM
Studio) works too: point `baseUrl` at it and leave the key env var unset.

## Usage

```bash
hirsh          # or: npm start
```

Special commands during the conversation:

| Command   | Action                                          |
|-----------|-------------------------------------------------|
| `/status` | Show the current phase and gathered context.    |
| `/help`   | Help.                                           |
| `/reset`  | Restart the conversation from scratch.          |
| `/exit`   | Quit Hirsh.                                      |

Confirmations are conversational: besides `y`/`n` you can answer naturally
("sure", "nope", "go ahead"), and at the pipeline choice you can reply in plain
language (e.g. "actually it's paired-end WGS") to have Hirsh reconsider instead
of just accepting or rejecting.

When Hirsh asks for a **folder or file path**, you can:
- reference a path explicitly with **`@`** — e.g. `@/data/reads` (this also lets
  paths with spaces through: `@/home/My Data/reads`), or just type a bare path;
- **change your mind** — e.g. answer "actually, run the test profile" and Hirsh
  switches to the bundled test data instead of treating your sentence as a path.

Confirmations and option prompts are **arrow-key menus** in a rich terminal — for
a yes/no you just arrow to Yes or No and press Enter (no typing). Option prompts
show a short list, each with a plain-language description, a recommended default,
and a "Something else (type it)" row for a free-text answer.
So you don't need to know nf-core jargon to (for example) add your own tool to a
composed pipeline. (On a basic terminal it falls back to a numbered prompt.)

Type **`/`** then **Tab** to complete a command (`/help`, `/status`, `/reset`,
`/exit`), and **`@`** then **Tab** to complete a file path (e.g. `@./da`→`@./data/`).
Pasting a multi-line block (e.g. a FASTA sequence) lands as one line to review
rather than submitting line-by-line (set `HIRSH_NO_PASTE_FILTER` to disable). For
sequence data, pointing at a file with `@path` is usually cleaner than pasting.

### Example session

```
    ●──●──●  hirsh   ·   bioinformatics co-scientist

What bioinformatics analysis would you like to run?
› I have mouse RNA-seq, treated vs control with 3 replicates, and I want to find differentially expressed genes.

── Phase B · Pipeline selection ──
I suggest nf-core/rnaseq — RNA-seq (gene expression quantification).
It is designed for short-read RNA: QC, alignment and quantification,
the basis for differential expression.
Continue with nf-core/rnaseq? (yes, no, or tell me what to change) › yes

── Phase C · Parameterization ──
The test profile runs the pipeline with bundled test data...
Run a TEST run (test profile)? [Y/n] › y

── Phase D · Confirmation and execution ──
Command to run:
  nextflow run nf-core/rnaseq -r 3.14.0 -profile test,docker -params-file /.../params.yaml
Parameters (params.yaml):
  outdir: /.../results
  aligner: star_salmon
Working directory: /.../runs/rnaseq-2026-07-01T...
Run this command now? [y/N] › y

── Running Nextflow (live log) ──
[... live Nextflow log ...]
Run completed successfully.

── Phase E · Results interpretation ──
Results summary:
N genes were quantified across the samples... (plain-language summary)
HTML reports (open them in your browser):
  • /.../results/multiqc/star_salmon/multiqc_report.html
```

> **Tip:** for your first run use the *test profile* (the default in Phase C for
> `rnaseq`): it needs no real data and validates the whole chain.

## Flow phases

- **A · Intent** — extracts organism, data type, objective and experimental
  design; asks for what is missing, one thing at a time.
- **Design review** — before selecting a pipeline, Hirsh reviews the experimental
  design (biological replication, controls, confounders/batch effects, group
  balance) and flags concerns with suggestions — advice, not a blocker. Once the
  samplesheet is built it reviews the design **again from the real data** —
  counting biological replicates per group and flagging a group with no
  replication, only two, or badly unbalanced groups.
- **B · Selection** — picks the right curated nf-core pipeline (or honestly says
  none applies), lets you correct it, and — if none fits — **recommends an
  established nf-core pipeline** from the live catalog (offering to run its test
  profile as a smoke run), or **composes** one from nf-core modules (see below).
- **Data retrieval** — if your request named public accessions (SRA/ENA/GEO/…),
  Hirsh offers to download them with nf-core/fetchngs and build the samplesheet
  before parameterization (see below).
- **C · Parameterization** — fills parameters and builds the samplesheet:
  infers R1/R2 pairs from a FASTQ directory, asks per-sample tumor/normal +
  patient for sarek somatic runs (and per-sample strandedness for rnaseq),
  validates an existing samplesheet you point it at, or uses the one just fetched.
  If the folder's files don't have `.fastq/.fq` extensions, it recognizes FASTQ
  **by content** and offers to symlink them to canonical names (see below).
- **D · Confirmation and execution** — checks whether the machine can meet the
  pipeline's resource needs (adapting the caps or advising against the run),
  shows the full command and `params.yaml`, and only runs after your explicit
  confirmation. Ctrl+C is forwarded to Nextflow for a clean shutdown. Afterwards
  it offers to **re-run** — reusing cached results with `-resume`, or after
  changing one parameter — without redoing the whole setup.
- **E · Interpretation** — locates the outputs, extracts concrete numbers
  (per-sample library sizes from count matrices, MultiQC per-sample metrics,
  variant counts from VCFs), shows a **compact inline bar chart** of the key
  figures, and explains the findings **biologically** in the
  context of your objective — revisiting any design caveats flagged before the run
  (e.g. a batch effect) and ending with a concrete next step. It writes a
  **shareable `REPORT.html`** into the run directory — the interpretation, the key
  numbers, **inline SVG figures** (per-sample library sizes, per-sample MultiQC QC
  metrics, and a **volcano plot** for each differential-expression contrast) and
  links to MultiQC/methods/provenance, all self-contained (no external
  dependencies) so you can open or share it directly.
  It can also write a paste-ready **methods paragraph** (`METHODS.md`) with the
  exact pipeline/Nextflow/tool versions and citations (DOIs). When the pipeline has
  a runnable **follow-up** (e.g. rnaseq → differentialabundance), it offers to run
  it directly on these results (see below).

Every run also writes a **reproducibility bundle** into its run directory —
`run_manifest.json` and a plain-language `PROVENANCE.md` recording the pipeline
and pinned revision, the exact command, resolved parameters, samplesheet,
environment and execution status — so an analysis can be archived, shared and
reproduced. After a real run it also records the **container images Nextflow
actually used** (read from its execution trace, digest-pinned where resolved),
for byte-exact reproduction.

## Autonomous mode

With `autonomy.enabled` in the config (or the `--auto` flag), Hirsh runs a request
to an interpreted answer without pausing for **reversible** confirmations — it
auto-answers those with their intended value and prints each `[auto]` decision —
while still **asking when information is genuinely missing** (e.g. where your FASTQ
files are) and **stopping at decisions only you should make**: publishing,
overriding a resource/disk safety refusal, or otherwise running against advice. The
guardrail is structural — consequential prompts are tagged and never auto-answered.

Where it can, Hirsh **derives** answers instead of asking: told the organism is
human it fills the reference genome itself (`[auto] genome → GRCh38`), mouse →
GRCm39, and so on — constrained to the keys the pipeline accepts, preferring a key
remembered from a past run. An organism it can't map still prompts you (it never
fabricates a reference).

## Project memory

Hirsh remembers your past analyses across sessions in a **local, private** store
(`~/.bioagent/memory.json`): each run's pipeline, intent (organism/data/objective),
references used, output directory and status. When a new request resembles a past
one, it surfaces the relevant history ("From your project memory — similar past
analyses: …") so you can pick up where you left off. During parameterization it
also offers to **reuse a remembered reference** (genome/FASTA/GTF) or
**samplesheet** from a relevant past run, so you don't retype them. The first time,
Hirsh **asks for your consent** to keep this memory (it's local and never uploaded)
and remembers your choice.

It also remembers the **execution environment** you last used *on this machine*
(the backend — Docker/Singularity/Conda/Mamba — and the executor with its queue)
and defaults to it before the next run instead of the static config, announcing
the choice and still letting you switch. Since the store is per-home (per-machine),
your laptop keeps defaulting to e.g. Docker+local while your HPC login node
defaults to Singularity+Slurm, with no re-picking each session.

It's on by default and stays on your machine; disable it with
`memory.enabled: false`.

## Building the samplesheet from a folder

Point Hirsh at a directory of FASTQ files and it builds the samplesheet for you —
inferring R1/R2 pairs and sample names by convention. If those files **don't have
`.fastq/.fq` extensions** (e.g. sequences saved as `.txt`, or oddly named), it
falls back to recognizing them **by content**: it sniffs each file's bytes for a
FASTQ record, a FASTA header, or gzip, and offers to symlink the recognized files
to canonical `.fastq(.gz)` names so the pipeline accepts them — it links, it never
rewrites your data.

> **Limits (by design).** It recognizes plain or gzipped FASTQ/FASTA only. Aligned
> or binary formats (BAM, CRAM, fast5) are detected and reported as unsupported —
> convert them to FASTQ first (e.g. `samtools fastq input.bam`) — rather than
> silently skipped. Sample grouping still follows the filename convention.

## Public data from accessions

Most analyses start from data in a public archive, not FASTQ files on your disk.
If your request names **accession numbers** — SRA/ENA/DDBJ (`SRR…`, `ERR…`,
`SRP…`, experiments/samples), GEO (`GSE…`, `GSM…`), BioProject/BioSample
(`PRJNA…`, `SAMN…`) or ArrayExpress (`E-MTAB-…`) — Hirsh recognizes them after
picking the pipeline and offers to **download the data automatically with
[nf-core/fetchngs](https://nf-co.re/fetchngs)**, building a samplesheet (formatted
for the target pipeline when supported). That samplesheet then feeds
parameterization, so you skip building it by hand. When fetchngs can't format the
samplesheet for your pipeline (e.g. sarek), Hirsh re-shapes it — pulling the FASTQ
pairs out and building the proper samplesheet in Phase C (for sarek, asking each
sample's patient and tumor/normal status) — so fetching public data works for
those pipelines too. The download runs only after your confirmation, and if there
are no accessions — or you'd rather not fetch — Hirsh just asks for your local
files instead.

## Chaining the follow-up analysis

Many analyses don't end at one pipeline: `rnaseq` produces **count matrices**, but
the real question — *which genes are differentially expressed?* — is answered by
[`nf-core/differentialabundance`](https://nf-co.re/differentialabundance) run on
those counts. After interpreting the results, Hirsh **offers to run that follow-up
directly**: it wires the upstream count matrix into the follow-up's `--matrix`,
carries over the annotation (`gtf`) from your run, and asks only for what it can't
infer — a **sample-condition table** and a **contrasts** file (which comparisons to
test). It then runs the follow-up through the same confirmed path, reusing the
backend/executor you already chose. It always asks first and never auto-chains; if
an expected output or a required input is missing, it degrades gracefully and
leaves everything prepared for you.

The follow-up is treated as a first-class run: before launching, a **light
resource check** compares its typical memory needs against your machine (asking
honestly if it won't fit); once it finishes, Hirsh **interprets its results
biologically**, just like a primary run — parsing the per-contrast
differential-expression tables into concrete numbers (how many genes are
significant and the up/down split, padj<0.05, |log2FC|>1 by default) and explaining
what they mean for your objective, revisiting any design caveats and pointing you
at the HTML report. It also **remembers the run** in project memory and offers a
paste-ready **methods paragraph** for the follow-up.

> **Limitation.** Chaining is one step deep (rnaseq → differentialabundance); a
> full pipeline DAG and runnable follow-ups for other pipelines are on the roadmap.
> See [RECOMMENDATIONS.md](RECOMMENDATIONS.md), Phase 2.

## Resource awareness

For real runs Hirsh compares the pipeline's typical memory/CPU needs against your
machine (or the caps in `execution.maxMemory` / `execution.maxCpus`) and:

- **runs** if you have enough headroom,
- **offers to adapt** (cap Nextflow to what you have) when you are below the
  recommended amount but above a workable floor, warning about the trade-off, or
- **recommends against running** when the machine is far too small — e.g. a
  ~40 GB pipeline on a 2 GB laptop.

When a pipeline declares its **heavy steps**, Hirsh models them individually: it
shows which steps fit your budget and names the specific bottleneck, telling apart
a step whose memory it can cap (slower) from one with a hard floor — e.g. STAR/
BWA-MEM2 genome indexing, which can't be reduced. So instead of a vague "maybe",
you get "the genome-indexing step needs ~38 GB and can't be capped; this machine
has 30 GB".

When the machine falls short, Hirsh **negotiates infrastructure**: instead of a
flat refusal it lays out concrete alternatives — cap and run slower here, move to
an HPC cluster, or burst to AWS Batch — each with a rough feasibility, time and
cost (e.g. "~$0.49/hour for a ≥38 GB node") and a recommendation, then applies
your choice (setting caps or re-pointing the executor). The estimates are rough
and labeled as such.

The test profile skips this check (it uses tiny bundled data).

## Where it runs (executor)

Before a real run Hirsh asks *where* to run: the **local machine**, an **HPC
scheduler** (Slurm, SGE, LSF, PBS) or **AWS Batch**. It writes a small Nextflow
config selecting the executor (queue, and region/S3 work directory for AWS Batch)
and passes it with `-c`, so it works with any pipeline without needing a matching
nf-core institutional profile. On a cluster/cloud executor the local-memory check
is skipped — the scheduler sizes each job — and the chosen target is recorded in
the run's provenance. Set a default with `execution.executor` (and
`execution.queue`) in the config.

## Container & data staging

Before a local run Hirsh also checks disk: it points image/env downloads at a
stable cache (`NXF_SINGULARITY_CACHEDIR` / `NXF_CONDA_CACHEDIR`) so they're reused,
estimates the run's footprint (images + input size read from the samplesheet +
intermediate work) and compares it to the free space — warning you if disk is
tight and refusing to silently start a run that would run out of space. (Docker
manages its own image store; on a cluster/cloud executor this check is skipped.)

## Discovering an established nf-core pipeline

Hirsh curates a few pipelines in depth, but nf-core ships ~100. When no curated
pipeline fits, Hirsh first searches the **live nf-core catalog**
(`nf-co.re/pipelines.json`) for the established pipeline that matches your intent —
the one a bioinformatician would reach for (e.g. `atacseq`, `methylseq`,
`scrnaseq`, `ampliseq`, `taxprofiler`) — and offers three ways forward:

- **Run it on your own data.** Hirsh reads the pipeline's own schemas
  (`nextflow_schema.json` + `assets/schema_input.json`) and asks only for what it
  needs: it builds the samplesheet from a folder of reads when the columns are
  simple (sample + FASTQ), or validates a CSV you provide against the pipeline's
  real column spec (so it never guesses per-sample fields like `replicate`); then
  it asks for the references (offering the iGenomes `genome` key first, which
  covers FASTA/GTF), leaves optional settings at nf-core's defaults, writes
  `params.yaml` and runs it. It's honest that this is schema-driven, not a curated
  recipe — review `params.yaml` to tune it.
- **Run its `test` profile.** A self-contained smoke run on nf-core's example data
  that proves the pipeline and your environment work and previews its outputs.
- **Compose one from modules** instead (below).

**Hirsh learns pipelines.** After a run, it offers to **curate** the catalog
pipeline into a persistent definition — generated from its schema and written to
`~/.bioagent/pipelines` — so next session it's a first-class, guided pipeline (with
step-by-step parameters), not schema-driven each time. It even **learns the real
result outputs** from the completed run (the MultiQC report, variant-call
directories) so next session's interpretation is rich, not a generic listing. The
generated file is honest boilerplate: it carries an "auto-generated, NOT
hand-curated" header naming what to refine (remaining output paths, a resources
block, the citation DOI), and deleting it reverts to the on-the-fly flow. A
bundled, hand-curated definition always wins over a learned one of the same name.
This way the curated set grows itself as you use pipelines.

## Composing a pipeline from nf-core modules

If no curated *or* established pipeline fits your request (or you type `compose`
at the selection step), Hirsh builds one from real
[nf-core/modules](https://github.com/nf-core/modules):

1. It resolves the current `nf-core/modules` commit and searches the live catalog
   (~1,900 modules) for candidates matching your intent.
2. The LLM proposes an ordered chain of real modules, each with a rationale, for
   you to review.
2b. If some step the objective needs isn't covered by the modules, Hirsh **proposes
   a custom tool** for the gap (command sketch, I/O kinds, a conda package if one
   fits) for you to review — and you can also add **your own (non-nf-core) tools**.
   Each becomes a standards-compliant `modules/local/` module (the `meta` map, a
   container/conda directive, `versions.yml`, a `when:` guard and a `stub:` block),
   wired in exactly like an nf-core module.
3. On confirmation it generates a **pinned, nf-core-structured project** under
   your `workdir` with **channel-type-matched wiring**: the selected modules
   installed from the pinned commit, a `modules.json` pinning each module's git
   SHA, `nextflow.config` with container profiles/resource limits and a mandatory
   `test` profile, `nextflow_schema.json`, a samplesheet schema, version
   collection via the nf-core `versions` topic and `CITATIONS.md`.
4. It validates that the config parses (`nextflow config`) and **runs the whole
   pipeline end-to-end via `-profile test -stub-run`** (no data or containers) as
   the "does it actually run" gate.
5. If the `nf-core` CLI is available, it offers to run **`nf-core lint`** on the
   project and reports the pass/warn/fail counts and top failures (advisory — a
   freshly composed project isn't fully lint-green yet).
6. Once it validates, Hirsh offers to **run the pipeline on your own data** — run
   the bundled **test profile** first (a quick smoke test), or point it at your
   input: a samplesheet CSV, or just a **sequence file/folder** (a `.fasta`/`.fastq`,
   with `@` paths) that Hirsh turns into a samplesheet for you. It executes and
   gives a plain-language take on the outputs. Only then does it suggest packaging/
   publishing — as a recommendation you can take whenever you're happy, not a
   required step.

The wiring connects each module input to the right upstream output by data kind
(reads, bam, vcf, fasta, indexes, reports…), rebuilds multi-file tuples, carries
the `meta` map, routes reference inputs (fasta/gtf/index/…) to pipeline params,
and collects reports into MultiQC — so the generated pipeline **runs without
hand-editing**. Reference parameters it couldn't source from upstream are
reported as `--<name>` for you to supply on a real run.

> **Scope.** The matcher targets linear flows and makes best-effort choices for
> unusual channel shapes; complex branching DAGs are still worth a glance. See
> [RECOMMENDATIONS.md](RECOMMENDATIONS.md), Phase 4, for what's next
> (`nf-core lint` in the loop, realistic bundled test data).

Set `GITHUB_TOKEN` in your environment to raise GitHub's API rate limit if you
compose often.

### Packaging & publishing

After composing, Hirsh can (opt-in) **package the project to nf-core standards**:
it adds a `LICENSE` (MIT by default), `CHANGELOG.md`, `CODE_OF_CONDUCT.md`,
`.gitignore`, a CI workflow and `docs/`, fills in the `nextflow.config` manifest
(author/homePage), turns the project into a git repository, and re-runs
`nf-core lint` to show the improved score.

It can then **publish to GitHub** via the `gh` CLI — but only with explicit
confirmation, **defaulting to a private repository**, warning clearly that a
public repo is visible and may be indexed/cached even if later deleted. Hirsh
never publishes without your consent and doesn't handle credentials itself
(`gh auth login` does).

If you added a **custom tool** as a local module, Hirsh can also write it out in
the **nf-core/modules layout** (`main.nf`, `meta.yml`, `environment.yml` and an
`nf-test`) under `contributions/<name>/` and walk you through opening a PR (fork,
add real test data, run `nf-core modules test`/`lint`, then create the PR).
Opening the PR stays your call — nf-core acceptance is a community decision.

Finally, Hirsh can write an `NFCORE_INCLUSION.md` guide walking you through getting
a whole pipeline **adopted into nf-core** (name check, scope proposal, template/lint
requirements, review steps) — honest that acceptance is the community's decision.

## Development

```bash
npm run build       # compile to dist/
npm test            # run the Vitest suite (resource logic, pair inference, command building, config)
npm run typecheck   # type-check without emitting
npm run verify:defs # check pinned pipeline definitions against upstream nextflow_schema.json (network)
```

## Not yet (on the roadmap)

A green `nf-core lint` in the composition loop with realistic bundled test data,
automated nf-core/modules PRs, live cloud pricing and real runtime estimates,
Azure/GCP executors, and a graphical interface.
These are the evolutionary
milestones toward the co-scientist vision — see
[RECOMMENDATIONS.md](RECOMMENDATIONS.md) for the full roadmap and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the current design is built to grow
into them.
