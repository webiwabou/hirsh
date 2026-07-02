/**
 * Conversation state machine (Phases A–E).
 *
 * Drives the full flow using the AgentIO interface to talk to the user and an
 * LLMProvider for reasoning. State lives in `session`, whose `phase` is updated
 * at each step (queried by /status).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HirshConfig } from "../config/types.js";
import type { LLMProvider } from "../llm/index.js";
import type { PipelineDefinition } from "../pipelines/types.js";
import { checkEnvironment } from "../execution/envCheck.js";
import {
  BACKENDS,
  bootstrapNextflow,
  chooseBackend,
  detectBackends,
} from "../execution/environment.js";
import {
  buildExecutorConfig,
  chooseExecutor,
  describeExecutor,
} from "../execution/executor.js";
import { negotiateInfrastructure } from "../execution/negotiation.js";
import {
  assessDiskPressure,
  cacheEnvFor,
  defaultCacheDir,
  defaultImageFootprintGB,
  estimateStagingNeeds,
  extractPathCells,
  getFreeDiskGB,
  sumFileSizes,
} from "../execution/staging.js";
import { runNextflow } from "../execution/runner.js";
import {
  assessResources,
  detectMachine,
  formatMemoryGB,
  parseMemoryToGB,
  type MachineResources,
} from "../execution/resources.js";
import { buildManifest, writeProvenance } from "../execution/provenance.js";
import type { EnvReport } from "../execution/envCheck.js";
import { gatherResults, summarizeResults } from "../results/interpreter.js";
import { ModuleRegistry, RegistryFetchError } from "../modules/registry.js";
import { planComposition } from "../composition/planner.js";
import { generatePipeline } from "../composition/generator.js";
import { lintPipeline, stubRun, validateGenerated } from "../composition/validate.js";
import { collectLocalTool, toNfCoreModule } from "../composition/localModule.js";
import type { ResolvedComposition } from "../composition/types.js";
import { extractIntent } from "./intentExtraction.js";
import { fillParameters, finalizeCommand } from "./parameterFilling.js";
import { selectPipeline } from "./pipelineSelection.js";
import type { AgentIO } from "./io.js";
import type { Session } from "./session.js";

type SelectOutcome =
  | { kind: "pipeline"; pipeline: PipelineDefinition }
  | { kind: "compose" }
  | { kind: "none" };

const MAX_INTENT_ROUNDS = 8;

export class Agent {
  constructor(
    private readonly provider: LLMProvider,
    private readonly config: HirshConfig,
    private readonly registry: PipelineDefinition[],
    private readonly io: AgentIO,
  ) {}

  async run(session: Session): Promise<void> {
    await this.phaseIntent(session);
    const outcome = await this.phaseSelect(session);

    if (outcome.kind === "compose") {
      await this.phaseCompose(session);
      session.phase = "done";
      return;
    }
    if (outcome.kind === "none") {
      session.phase = "done";
      return;
    }
    const pipeline = outcome.pipeline;
    session.selectedPipeline = pipeline;

    session.phase = "params";
    this.io.heading("Phase C · Parameterization");
    const { runDir } = await fillParameters(this.io, session, pipeline, this.config);

    const executed = await this.phaseConfirmAndRun(session, runDir);
    if (executed) {
      await this.phaseResults(session, pipeline);
    }
    session.phase = "done";
  }

  /** Phase A — gather intent, asking one question at a time. */
  private async phaseIntent(session: Session): Promise<void> {
    session.phase = "intent";
    if (session.transcript.length === 0) {
      const first = await this.io.ask("What bioinformatics analysis would you like to run?");
      session.transcript.push({ role: "user", text: first });
    }

    for (let round = 0; round < MAX_INTENT_ROUNDS; round++) {
      const intent = await this.io.withSpinner("Analyzing your request", () =>
        extractIntent(this.provider, this.registry, session.transcript),
      );
      session.query = {
        organism: intent.organism ?? session.query.organism,
        dataType: intent.dataType ?? session.query.dataType,
        objective: intent.objective ?? session.query.objective,
        experimentalDesign: intent.experimentalDesign ?? session.query.experimentalDesign,
      };

      if (intent.enough) return;

      const question =
        intent.nextQuestion ??
        "Could you give me more details about the organism, data type and your objective?";
      this.io.say(question);
      session.transcript.push({ role: "agent", text: question });
      const answer = await this.io.ask("");
      session.transcript.push({ role: "user", text: answer });
    }
    this.io.info("Continuing with the information gathered so far.");
  }

  /** Phase B — select the pipeline and allow user correction. */
  private async phaseSelect(session: Session): Promise<SelectOutcome> {
    session.phase = "select";
    this.io.heading("Phase B · Pipeline selection");

    // The user can accept, decline, or answer in natural language ("actually
    // it's paired-end WGS") — in which case we fold that back into the intent and
    // reconsider, rather than forcing a bare yes/no.
    for (let round = 0; round < 4; round++) {
      const sel = await this.io.withSpinner("Choosing the right pipeline", () =>
        selectPipeline(this.provider, this.registry, session.query),
      );

      const chosen = sel.pipelineName
        ? this.registry.find((p) => p.name === sel.pipelineName) ?? null
        : null;

      if (!chosen) {
        this.io.warn("I couldn't find a curated pipeline that fits your case well: " + sel.rationale);
        const compose = await this.io.confirm(
          "Would you like me to compose one from nf-core modules instead?",
          true,
        );
        if (compose) return { kind: "compose" };
        return this.pickManually(session);
      }

      this.io.say(`I suggest ${chosen.name} — ${chosen.title}.`);
      this.io.info(sel.rationale);
      if (chosen.followUp) {
        this.io.info(`Heads-up: ${chosen.followUp.note}`);
      }

      const resp = await this.io.confirmOrText(
        `Continue with ${chosen.name}? (yes, no, or tell me what to change)`,
        true,
      );
      if ("decision" in resp) {
        if (resp.decision) return { kind: "pipeline", pipeline: chosen };
        return this.pickManually(session);
      }

      // Free-text answer → treat as a clarification and re-decide.
      session.transcript.push({ role: "user", text: resp.text });
      const refined = await this.io.withSpinner("Reconsidering based on that", () =>
        extractIntent(this.provider, this.registry, session.transcript),
      );
      session.query = {
        organism: refined.organism ?? session.query.organism,
        dataType: refined.dataType ?? session.query.dataType,
        objective: refined.objective ?? session.query.objective,
        experimentalDesign: refined.experimentalDesign ?? session.query.experimentalDesign,
      };
    }

    // Exhausted the reconsideration rounds — fall back to a manual pick.
    return this.pickManually(session);
  }

  /** Lets the user pick manually from the catalog, compose, or give up. */
  private async pickManually(session: Session): Promise<SelectOutcome> {
    this.io.say("These are the supported pipelines:");
    this.registry.forEach((p, i) => this.io.say(`  ${i + 1}. ${p.name} — ${p.title}`));
    this.io.info("  Or type 'compose' to build a new pipeline from nf-core modules.");
    const answer = (
      await this.io.ask("Type the pipeline number or name, 'compose', or Enter to cancel:")
    ).trim();
    if (!answer) {
      this.io.info("Okay, not continuing with any pipeline. Use /reset to start over.");
      return { kind: "none" };
    }
    if (answer.toLowerCase() === "compose") return { kind: "compose" };
    const byIndex = Number(answer);
    if (!Number.isNaN(byIndex) && byIndex >= 1 && byIndex <= this.registry.length) {
      return { kind: "pipeline", pipeline: this.registry[byIndex - 1] };
    }
    const byName = this.registry.find((p) => p.name === answer || p.name.endsWith(`/${answer}`));
    if (byName) return { kind: "pipeline", pipeline: byName };
    this.io.warn("I didn't recognize that pipeline.");
    return this.pickManually(session);
  }

  /** Phase F4 — compose a new pipeline from live nf-core modules. */
  private async phaseCompose(session: Session): Promise<void> {
    session.phase = "compose";
    this.io.heading("Phase F4 · Composing a pipeline from nf-core modules");
    this.io.info(
      "I'll search the live nf-core/modules catalog, propose a chain of real modules, " +
        "and generate a pinned, nf-core-structured pipeline project for you to review.",
    );

    const registry = new ModuleRegistry();
    let resolved;
    try {
      resolved = await this.io.withSpinner("Searching nf-core/modules and planning", () =>
        planComposition(this.provider, registry, session.query),
      );
    } catch (err) {
      if (err instanceof RegistryFetchError) {
        this.io.warn("Could not reach the nf-core module registry: " + err.message);
        return;
      }
      throw err;
    }

    if (!resolved) {
      this.io.warn("I couldn't assemble a coherent pipeline from the available modules for this case.");
      return;
    }

    this.io.say(`Proposed pipeline: ${resolved.plan.pipelineName} — ${resolved.plan.description}`);
    this.io.say("Steps (linear draft):");
    resolved.plan.steps.forEach((s, i) => this.io.say(`  ${i + 1}. ${s.module} — ${s.rationale}`));
    this.io.info(`Modules pinned to nf-core/modules @ ${resolved.sha.slice(0, 10)}`);

    // Phase 4: let the scientist add custom (non-nf-core) tools as local modules,
    // wired in like any nf-core module.
    await this.addLocalTools(resolved);

    const go = await this.io.confirm("Generate this pipeline project?", true);
    if (!go) {
      this.io.info("Not generating anything. You can refine the request and try again.");
      return;
    }

    let result;
    try {
      result = await this.io.withSpinner("Generating project and installing modules", () =>
        generatePipeline(registry, resolved!, this.config.execution.workdir),
      );
    } catch (err) {
      this.io.warn("Generation failed: " + (err instanceof Error ? err.message : String(err)));
      return;
    }

    this.io.say(`Generated ${result.files.length} files at ${result.dir}`);
    for (const w of result.warnings) this.io.warn("  • " + w);
    if (result.referenceParams.length > 0) {
      this.io.info(
        `Reference parameters to set for a real run: ${result.referenceParams
          .map((p) => `--${p}`)
          .join(", ")}`,
      );
    }
    for (const n of result.notes) this.io.info("  note: " + n);

    const validation = await this.io.withSpinner("Checking the project configuration", () =>
      validateGenerated(result!.dir),
    );
    if (validation.configOk) {
      this.io.info("Config parses correctly.");
    } else {
      this.io.warn("Config check failed:");
      if (validation.configError) this.io.warn(validation.configError);
    }

    // The real gate: run the whole DAG via -stub-run (no data/containers).
    const stub = await this.io.withSpinner("Running the pipeline end-to-end (-stub-run)", () =>
      stubRun(result!.dir),
    );
    if (stub.ok) {
      this.io.say("Stub run succeeded — the pipeline runs end-to-end with no edits.");
    } else {
      this.io.warn("Stub run failed (the wiring needs a fix):");
      if (stub.error) this.io.warn(stub.error);
    }

    if (validation.nfCoreCli.available) {
      const doLint = await this.io.confirm("Run `nf-core lint` on the generated project now?", true);
      if (doLint) {
        const lint = await this.io.withSpinner("Running nf-core lint", () => lintPipeline(result!.dir));
        if (lint.ran && lint.failed != null) {
          const line = `nf-core lint: ${lint.passed ?? 0} passed, ${lint.warned ?? 0} warnings, ${lint.failed} failed.`;
          if (lint.failed === 0) {
            this.io.say("✓ " + line + " The project is lint-clean.");
          } else {
            this.io.warn(line);
            for (const f of lint.findings.slice(0, 6)) this.io.info("  ✗ " + f);
            this.io.info(
              "Some failures are expected for a freshly composed project — iterate toward a full " +
                "nf-core template before publishing (Phase 5).",
            );
          }
        } else {
          this.io.warn("Couldn't run nf-core lint: " + (lint.error ?? "unknown error"));
        }
      }
    } else if (validation.nfCoreCli.note) {
      this.io.info(validation.nfCoreCli.note);
    }

    this.io.say("\nNext steps:");
    this.io.info(`  • Real run: cd ${result.dir} && nextflow run . -profile docker --input samplesheet.csv --outdir results`);
    if (result.referenceParams.length > 0) {
      this.io.info("  • Provide the reference parameters above for real data.");
    }
    this.io.info("  • The test profile uses placeholder data for the stub run; swap in real test data for a functional test.");
  }

  /**
   * Phase 4 — optionally add custom (non-nf-core) tools as local modules. Each is
   * synthesized as a standards-compliant modules/local/<name> and appended to the
   * composition so it wires in like any nf-core module.
   */
  private async addLocalTools(resolved: ResolvedComposition): Promise<void> {
    let add = await this.io.confirm(
      "Add a custom (non-nf-core) tool of your own as a local module?",
      false,
    );
    while (add) {
      const spec = await collectLocalTool(this.io);
      if (spec) {
        if (resolved.modules.some((m) => m.name === spec.name)) {
          this.io.warn(`A module named "${spec.name}" is already in the plan; skipping.`);
        } else {
          resolved.modules.push(toNfCoreModule(spec));
          resolved.localTools = [...(resolved.localTools ?? []), spec];
          resolved.plan.steps.push({
            module: spec.name,
            rationale: `Custom local tool: ${spec.description}`,
          });
          this.io.info(
            `Added local module "${spec.name}" (${spec.container ?? spec.conda ?? "no environment set"}).`,
          );
        }
      }
      add = await this.io.confirm("Add another custom tool?", false);
    }
  }

  /** Computes the usable resource budget: detected machine, capped by config. */
  private availableBudget(): MachineResources {
    const machine = detectMachine();
    let memoryGB = machine.memoryGB;
    const cfgMem = parseMemoryToGB(this.config.execution.maxMemory);
    if (cfgMem != null) memoryGB = Math.min(memoryGB, cfgMem);
    let cpus = machine.cpus;
    if (this.config.execution.maxCpus) cpus = Math.min(cpus, this.config.execution.maxCpus);
    return { cpus, memoryGB };
  }

  /**
   * Resource-awareness pre-flight for real runs. Returns false if the run should
   * be abandoned (refused and not overridden, or the user declined to adapt).
   */
  private async phaseResourceCheck(session: Session, pipeline: PipelineDefinition): Promise<boolean> {
    if (session.useTestProfile || !pipeline.resources) return true;

    // On a cluster/cloud executor the local machine's RAM isn't the constraint —
    // each job runs on a scheduler node. Skip the local budget gate and let the
    // pipeline's per-process resource labels govern node sizing.
    if (session.executor && session.executor.executor !== "local") {
      this.io.info(
        `Jobs will run on ${describeExecutor(session.executor)}, so I'm not gating on this ` +
          "machine's memory; the scheduler allocates each step's resources.",
      );
      return true;
    }

    const available = this.availableBudget();
    // Params the user actually provided (non-empty) — a prebuilt index/reference
    // lets the model skip the corresponding indexing step's memory floor.
    const providedParams = new Set(
      Object.entries(session.paramValues)
        .filter(([, v]) => v !== "" && v != null)
        .map(([k]) => k),
    );
    const assessment = assessResources(pipeline.resources, available, providedParams);

    // When per-process guidance exists, show which steps fit under the budget so
    // the verdict is transparent, not a single opaque number.
    const processes = pipeline.resources.processes;
    if (processes && processes.length > 0) {
      const skipped = new Set(assessment.skippedSteps ?? []);
      this.io.info(`Heavy steps vs. your ${Math.floor(available.memoryGB)} GB budget:`);
      for (const p of [...processes].sort((a, b) => b.memoryGB - a.memoryGB)) {
        let mark: string;
        if (skipped.has(p.name)) {
          mark = "skipped (reference/index provided)";
        } else if (p.memoryGB <= available.memoryGB) {
          mark = "fits";
        } else {
          mark = p.cappable === false ? "WON'T FIT (hard floor)" : "over budget (cappable)";
        }
        this.io.info(`  • ${p.name}: ~${p.memoryGB} GB — ${mark}`);
      }
    }

    if (assessment.verdict === "ok") {
      this.io.info(assessment.message);
      return true;
    }

    // adapt / refuse → negotiate infrastructure: present concrete alternatives
    // (cap locally, HPC cluster, cloud) with rough feasibility/time/cost.
    this.io.warn(assessment.message);
    return this.negotiate(session, pipeline, assessment, available);
  }

  /**
   * Presents infrastructure alternatives with rough feasibility/time/cost and a
   * recommendation, then carries out the user's choice (cap locally, move to a
   * cluster/cloud executor, or stop). Returns true if the run should proceed.
   */
  private async negotiate(
    session: Session,
    pipeline: PipelineDefinition,
    assessment: ReturnType<typeof assessResources>,
    available: MachineResources,
  ): Promise<boolean> {
    const requiredMemoryGB = this.requiredMemory(pipeline, assessment);
    const result = negotiateInfrastructure({
      verdict: assessment.verdict === "adapt" ? "adapt" : "refuse",
      availableMemoryGB: available.memoryGB,
      requiredMemoryGB,
      limitingStep: assessment.limitingStep,
    });

    this.io.say(result.summary);
    result.options.forEach((opt, i) => {
      const rec = i === result.recommendedIndex ? " (recommended)" : "";
      const marks = [
        `feasibility: ${opt.feasibility}`,
        opt.time ? `time: ${opt.time}` : "",
        opt.cost ? `cost: ${opt.cost}` : "",
      ].filter(Boolean);
      this.io.say(`  ${i + 1}) ${opt.label}${rec}`);
      this.io.info(`       ${opt.detail}`);
      this.io.info(`       ${marks.join(" · ")}`);
    });

    const def = result.recommendedIndex + 1;
    const answer = (await this.io.ask(`Which path? [${def}]`)).trim();
    let idx = result.recommendedIndex;
    if (answer !== "") {
      const n = Number.parseInt(answer, 10);
      if (Number.isInteger(n) && n >= 1 && n <= result.options.length) idx = n - 1;
    }
    const choice = result.options[idx];

    switch (choice.kind) {
      case "cap-local": {
        if (choice.feasibility === "infeasible") {
          this.io.warn(
            "Capping locally can't satisfy a hard memory floor, so it will very likely fail.",
          );
          const override = await this.io.confirm("Run anyway against my recommendation?", false);
          if (!override) return false;
        }
        const caps = assessment.caps ?? {
          maxMemory: formatMemoryGB(available.memoryGB),
          maxCpus: available.cpus,
        };
        session.paramValues.max_memory = caps.maxMemory;
        session.paramValues.max_cpus = caps.maxCpus;
        finalizeCommand(session, pipeline, this.config);
        this.io.info(`Capped the run to ${caps.maxMemory} and ${caps.maxCpus} CPUs.`);
        return true;
      }
      case "cluster":
      case "cloud": {
        // Re-run executor selection so the user picks the scheduler/cloud target
        // and its queue; the command is rebuilt and the local gate no longer
        // applies.
        this.io.info(
          choice.kind === "cluster"
            ? "Let's point this at your cluster."
            : "Let's set up the cloud target.",
        );
        await this.phaseExecutor(session, session.runDir ?? resolve(this.config.execution.workdir));
        finalizeCommand(session, pipeline, this.config);
        if (!session.executor || session.executor.executor === "local") {
          this.io.warn("Still set to local — the memory limit above still applies.");
          return this.negotiate(session, pipeline, assessment, available);
        }
        return true;
      }
      default:
        this.io.info("Okay — not running. The command and inputs stay prepared.");
        return false;
    }
  }

  /** Memory the run really wants: peak active step, or the whole-pipeline hint. */
  private requiredMemory(
    pipeline: PipelineDefinition,
    assessment: ReturnType<typeof assessResources>,
  ): number {
    const processes = pipeline.resources?.processes;
    if (processes && processes.length > 0) {
      const skipped = new Set(assessment.skippedSteps ?? []);
      const active = processes.filter((p) => !skipped.has(p.name));
      if (active.length > 0) return Math.max(...active.map((p) => p.memoryGB));
    }
    return pipeline.resources?.recommendedMemoryGB ?? assessment.available.memoryGB;
  }

  /**
   * Phase 3 — interactive execution-backend selection. Detects which backends
   * are available and lets the user confirm/switch; records the choice on the
   * session so the command profile and provenance reflect it.
   */
  private async phaseEnvironment(session: Session): Promise<void> {
    const statuses = await this.io.withSpinner("Checking execution backends", () =>
      detectBackends(),
    );
    const chosen = await chooseBackend(this.io, statuses, this.config.execution.containerEngine);
    if (chosen) {
      session.engine = chosen;
      this.io.info(
        `Execution backend: ${BACKENDS[chosen].label} (nf-core profile "${BACKENDS[chosen].profile}").`,
      );
    } else {
      // Nothing available: keep the configured value so the command/provenance
      // stay coherent; the environment gate below will explain what's missing.
      session.engine = this.config.execution.containerEngine;
    }
  }

  /**
   * Phase 3 — choose where jobs run (local / HPC scheduler / cloud). Writes a
   * Nextflow `-c` config selecting the executor and records it on the session.
   */
  private async phaseExecutor(session: Session, runDir: string): Promise<void> {
    const configured = this.config.execution.executor ?? "local";
    const settings = await chooseExecutor(this.io, configured, this.config.execution.queue);
    session.executor = settings;

    const configText = buildExecutorConfig(settings);
    if (configText) {
      const path = join(runDir, "executor.config");
      try {
        writeFileSync(path, configText, "utf8");
        session.executorConfigPath = path;
      } catch {
        this.io.warn("Could not write the executor config; falling back to local execution.");
        session.executor = { executor: "local" };
        session.executorConfigPath = undefined;
      }
    } else {
      session.executorConfigPath = undefined;
    }
    this.io.info(`Execution target: ${describeExecutor(session.executor)}.`);
  }

  /**
   * Phase 3 — container & data staging. Points image/env downloads at a stable
   * cache (so they're reused), estimates the run's disk footprint (images +
   * inputs + intermediate work) and warns about disk pressure before running.
   * Returns false only if disk is insufficient and the user declines to proceed.
   */
  private async phaseStaging(session: Session, pipeline: PipelineDefinition, runDir: string): Promise<boolean> {
    const engine = session.engine ?? this.config.execution.containerEngine;

    // A stable cache means images/conda envs are downloaded once and reused.
    const cacheDir = defaultCacheDir();
    const cacheEnv = cacheEnvFor(engine, cacheDir);
    if (Object.keys(cacheEnv).length > 0) {
      try {
        for (const dir of Object.values(cacheEnv)) mkdirSync(dir, { recursive: true });
        session.runEnv = { ...(session.runEnv ?? {}), ...cacheEnv };
        this.io.info(`Image cache: ${Object.values(cacheEnv).join(", ")} (reused across runs).`);
      } catch {
        /* cache is an optimization; never block on it */
      }
    }

    // On a non-local executor the work directory and images live on the cluster
    // or in the cloud, so the local disk check doesn't apply.
    if (session.executor && session.executor.executor !== "local") {
      this.io.info(
        "Data and images stage on the execution target, so I'm not checking this machine's disk.",
      );
      return true;
    }

    // Estimate inputs from the samplesheet (skipped for the test profile).
    let inputBytes = 0;
    if (!session.useTestProfile && session.samplesheetPath) {
      try {
        const cells = extractPathCells(readFileSync(session.samplesheetPath, "utf8"));
        inputBytes = await sumFileSizes(cells);
      } catch {
        /* best-effort */
      }
    }

    const estimate = estimateStagingNeeds({
      imagesGB: pipeline.resources?.imageFootprintGB ?? defaultImageFootprintGB(engine),
      inputBytes,
    });
    const freeGB = await getFreeDiskGB(runDir);
    if (freeGB == null) return true; // can't read disk; don't block

    const disk = assessDiskPressure(freeGB, estimate);
    if (disk.level === "ok") {
      this.io.info(disk.message);
      return true;
    }
    if (disk.level === "tight") {
      this.io.warn(disk.message);
      return true;
    }
    // insufficient
    this.io.warn(disk.message);
    const go = await this.io.confirm("Try to run anyway despite low disk?", false);
    if (!go) {
      this.io.info("Okay — not running. Free some space or use a larger work directory, then retry.");
      return false;
    }
    return true;
  }

  /** Phase D — show the command, check the environment and run after confirmation. */
  private async phaseConfirmAndRun(session: Session, runDir: string): Promise<boolean> {
    session.phase = "confirm";
    this.io.heading("Phase D · Confirmation and execution");

    const pipeline = session.selectedPipeline!;

    // Phase 3: decide the execution backend (Docker/Singularity/Conda/Mamba) and
    // the executor (where jobs run) interactively, then rebuild the command so
    // its -profile and -c reflect both choices.
    await this.phaseEnvironment(session);
    await this.phaseExecutor(session, runDir);
    finalizeCommand(session, pipeline, this.config);

    const proceed = await this.phaseResourceCheck(session, pipeline);
    if (!proceed) return false;

    const staged = await this.phaseStaging(session, pipeline, runDir);
    if (!staged) return false;

    const cmd = `nextflow ${(session.command ?? []).join(" ")}`;
    this.io.say("Command to run:");
    this.io.say("  " + cmd);
    if (session.paramsFile) {
      this.io.info("Parameters (params.yaml):");
      try {
        for (const line of readFileSync(session.paramsFile, "utf8").trimEnd().split("\n")) {
          this.io.info("  " + line);
        }
      } catch {
        /* best-effort display */
      }
    }
    if (session.samplesheetPath) {
      this.io.info(`Samplesheet: ${session.samplesheetPath}`);
    }
    this.io.info(`Working directory: ${runDir}`);

    const engine = session.engine ?? this.config.execution.containerEngine;
    let env = await checkEnvironment(engine);
    // Phase 3: if Nextflow itself is missing, offer to bootstrap it (with
    // confirmation) rather than only printing install instructions.
    if (!env.nextflow.available) {
      const boot = await bootstrapNextflow(this.io);
      this.io.info(boot.message);
      if (boot.installed) env = await checkEnvironment(engine);
    }
    if (!env.canExecute) {
      this.io.warn("I can't run yet because required software is missing:");
      if (!env.nextflow.available) this.io.warn(`  • ${env.nextflow.hint}`);
      if (!env.container.available) this.io.warn(`  • ${env.container.hint}`);
      this.io.info(
        "Once installed, you can run the command above manually from " + runDir + ".",
      );
      this.writeRunProvenance(session, runDir, env, false);
      return false;
    }

    const go = await this.io.confirm("Run this command now?", false);
    if (!go) {
      this.io.info("Not running anything. The command and samplesheet are ready if you want to launch it yourself.");
      this.writeRunProvenance(session, runDir, env, false);
      return false;
    }

    session.phase = "execute";
    this.io.heading("Running Nextflow (live log)");
    const result = await runNextflow(session.command ?? [], runDir, this.io, session.runEnv);
    this.writeRunProvenance(session, runDir, env, true, result.exitCode);
    if (result.exitCode !== 0) {
      this.io.warn(`Nextflow exited with an error (code ${result.exitCode}).`);
      if (result.errorSummary) {
        this.io.say("Relevant error detail:");
        this.io.say(result.errorSummary);
      }
      return false;
    }
    this.io.say("Run completed successfully.");
    return true;
  }

  /**
   * Writes a reproducibility bundle (run_manifest.json + PROVENANCE.md) into the
   * run directory. Best-effort: provenance must never block or fail a run.
   */
  private writeRunProvenance(
    session: Session,
    runDir: string,
    env: EnvReport,
    executed: boolean,
    exitCode?: number,
  ): void {
    const pipeline = session.selectedPipeline;
    if (!pipeline) return;
    try {
      const manifest = buildManifest({
        pipelineName: pipeline.name,
        revision: pipeline.version,
        query: session.query,
        command: session.command ?? [],
        paramsFile: session.paramsFile,
        params: session.paramValues,
        samplesheet: session.samplesheetPath,
        outdir: session.outdir,
        nextflowVersion: env.nextflow.version,
        containerEngine: session.engine ?? this.config.execution.containerEngine,
        executor: session.executor ? describeExecutor(session.executor) : "local machine",
        machine: detectMachine(),
        llmLabel: this.provider.label,
        executed,
        exitCode,
      });
      const paths = writeProvenance(runDir, manifest);
      this.io.info(`Provenance written: ${paths.markdown}`);
    } catch {
      /* never block on provenance */
    }
  }

  /** Phase E — locate and interpret the results. */
  private async phaseResults(session: Session, pipeline: PipelineDefinition): Promise<void> {
    session.phase = "results";
    this.io.heading("Phase E · Results interpretation");

    const outdir = session.outdir ?? "results";
    const report = gatherResults(pipeline, outdir);

    const anyFound = report.outputs.some((o) => o.found);
    if (!anyFound) {
      this.io.warn(
        `I couldn't find the expected outputs in ${report.outdir}. ` +
          "Check the Nextflow log and the results folder.",
      );
      return;
    }

    this.io.say("Results summary:\n");
    await summarizeResults(this.provider, pipeline, session.query, report, (chunk) =>
      this.io.raw(chunk),
    );
    this.io.endStream();

    if (report.htmlReports.length > 0) {
      this.io.info("HTML reports (open them in your browser):");
      for (const html of report.htmlReports) this.io.info(`  • ${html}`);
    }

    if (pipeline.followUp) {
      this.io.say(
        `\nNext analysis step: when ${pipeline.followUp.when}, run ${pipeline.followUp.pipeline}. ` +
          pipeline.followUp.note,
      );
    }
  }
}
