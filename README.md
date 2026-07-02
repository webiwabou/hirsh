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
> it can **compose a new one from the live [nf-core/modules](https://github.com/nf-core/modules)
> catalog** and generate a pinned, nf-core-structured project (a reviewable
> draft). See
> [ARCHITECTURE.md](ARCHITECTURE.md) for the design and how to extend it, and
> [RECOMMENDATIONS.md](RECOMMENDATIONS.md) for the roadmap toward a full
> bioinformatics **co-scientist** (composing pipelines from nf-core modules,
> managing HPC/cloud infrastructure, contributing modules back to nf-core, and
> requiring zero technical knowledge from the scientist).

```
    ●───────●───────●      Hirsh · bioinformatics pipeline agent
```

## Requirements

- **Node.js ≥ 20** (tested on Node 26).
- **Nextflow** on `PATH` — required to run pipelines. If it's missing, Hirsh can
  install it for you (official installer) with your confirmation, or you can
  install it yourself: `curl -s https://get.nextflow.io | bash`.
- An **execution backend** — **Docker**, **Singularity/Apptainer**, **Conda** or
  **Mamba**. Before a run Hirsh detects which of these are available and lets you
  pick one interactively (recommending the most reproducible option present).
- An **LLM backend**:
  - **Ollama** running locally (`ollama serve`) with a tool-calling capable model
    pulled (`ollama pull <model>`), **or**
  - an **Anthropic API key** in an environment variable.

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
```

> **Tool calling required.** Intent extraction and pipeline selection use tool
> calls, so pick an Ollama model that supports them (e.g. `llama3.1`, `qwen2.5`,
> `mistral`). Small/old models without tool support will not work well.

### Example — Anthropic (Claude)

```yaml
provider: anthropic
anthropic:
  apiKeyEnv: ANTHROPIC_API_KEY   # NAME of the env var, not the key itself
  model: claude-3-5-haiku-20241022
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

### Example session

```
    ●───────●───────●      Hirsh · bioinformatics pipeline agent

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
- **B · Selection** — picks the right curated nf-core pipeline (or honestly says
  none applies), lets you correct it, and — if none fits — offers to **compose**
  one from nf-core modules (see below).
- **C · Parameterization** — fills parameters and builds the samplesheet:
  infers R1/R2 pairs from a FASTQ directory, asks per-sample tumor/normal +
  patient for sarek somatic runs (and per-sample strandedness for rnaseq), or
  validates an existing samplesheet you point it at.
- **D · Confirmation and execution** — checks whether the machine can meet the
  pipeline's resource needs (adapting the caps or advising against the run),
  shows the full command and `params.yaml`, and only runs after your explicit
  confirmation. Ctrl+C is forwarded to Nextflow for a clean shutdown. Afterwards
  it offers to **re-run** — reusing cached results with `-resume`, or after
  changing one parameter — without redoing the whole setup.
- **E · Interpretation** — locates the outputs, extracts concrete numbers
  (per-sample library sizes from count matrices, MultiQC per-sample metrics,
  variant counts from VCFs) and summarizes the findings in plain language.

Every run also writes a **reproducibility bundle** into its run directory —
`run_manifest.json` and a plain-language `PROVENANCE.md` recording the pipeline
and pinned revision, the exact command, resolved parameters, samplesheet,
environment and execution status — so an analysis can be archived, shared and
reproduced.

## Project memory

Hirsh remembers your past analyses across sessions in a **local, private** store
(`~/.bioagent/memory.json`): each run's pipeline, intent (organism/data/objective),
references used, output directory and status. When a new request resembles a past
one, it surfaces the relevant history ("From your project memory — similar past
analyses: …") so you can pick up where you left off. It's on by default and stays
on your machine; disable it with `memory.enabled: false`.

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

## Composing a pipeline from nf-core modules

If no curated pipeline fits your request (or you type `compose` at the selection
step), Hirsh builds one from real [nf-core/modules](https://github.com/nf-core/modules):

1. It resolves the current `nf-core/modules` commit and searches the live catalog
   (~1,900 modules) for candidates matching your intent.
2. The LLM proposes an ordered chain of real modules, each with a rationale, for
   you to review.
2b. You can also add **your own (non-nf-core) tools** as `modules/local/` — Hirsh
   generates a standards-compliant module for each (the `meta` map, a
   container/conda directive, `versions.yml`, a `when:` guard and a `stub:` block)
   and wires it in exactly like an nf-core module, mixing `modules/nf-core/` and
   `modules/local/` as real nf-core pipelines do.
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

## Development

```bash
npm run build       # compile to dist/
npm test            # run the Vitest suite (resource logic, pair inference, command building, config)
npm run typecheck   # type-check without emitting
npm run verify:defs # check pinned pipeline definitions against upstream nextflow_schema.json (network)
```

## Not yet (on the roadmap)

Remote/HPC and cloud execution, automatic public-data download, `nf-core lint`
in the composition loop and realistic bundled test data, contributing modules
back to nf-core, persistent memory across sessions, and a graphical interface.
These are the evolutionary
milestones toward the co-scientist vision — see
[RECOMMENDATIONS.md](RECOMMENDATIONS.md) for the full roadmap and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the current design is built to grow
into them.
