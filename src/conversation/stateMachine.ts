/**
 * Conversation state machine (Phases A–E).
 *
 * Drives the full flow using the AgentIO interface to talk to the user and an
 * LLMProvider for reasoning. State lives in `session`, whose `phase` is updated
 * at each step (queried by /status).
 */
import { readFileSync } from "node:fs";
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
import { stubRun, validateGenerated } from "../composition/validate.js";
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
    const ok = await this.io.confirm(`Continue with ${chosen.name}?`, true);
    if (!ok) {
      return this.pickManually(session);
    }
    return { kind: "pipeline", pipeline: chosen };
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
      this.io.info("nf-core CLI detected — you can also run `nf-core pipelines lint` on the project.");
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

    const available = this.availableBudget();
    const assessment = assessResources(pipeline.resources, available);

    if (assessment.verdict === "ok") {
      this.io.info(assessment.message);
      return true;
    }

    if (assessment.verdict === "adapt") {
      this.io.warn(assessment.message);
      const caps = assessment.caps!;
      const adapt = await this.io.confirm(
        `Cap Nextflow to ${caps.maxMemory} / ${caps.maxCpus} CPUs and continue?`,
        true,
      );
      if (!adapt) {
        this.io.info("Understood — not adapting. You can run this on a larger machine instead.");
        return false;
      }
      session.paramValues.max_memory = caps.maxMemory;
      session.paramValues.max_cpus = caps.maxCpus;
      finalizeCommand(session, pipeline, this.config);
      this.io.info(`Capped the run to ${caps.maxMemory} and ${caps.maxCpus} CPUs.`);
      return true;
    }

    // refuse
    this.io.warn(assessment.message);
    const override = await this.io.confirm(
      "Run anyway against my recommendation (it will very likely fail)?",
      false,
    );
    if (!override) return false;
    session.paramValues.max_memory = formatMemoryGB(available.memoryGB);
    session.paramValues.max_cpus = available.cpus;
    finalizeCommand(session, pipeline, this.config);
    return true;
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

  /** Phase D — show the command, check the environment and run after confirmation. */
  private async phaseConfirmAndRun(session: Session, runDir: string): Promise<boolean> {
    session.phase = "confirm";
    this.io.heading("Phase D · Confirmation and execution");

    const pipeline = session.selectedPipeline!;

    // Phase 3: decide the execution backend (Docker/Singularity/Conda/Mamba)
    // interactively, based on what's actually available, before building the
    // command so the -profile reflects the choice.
    await this.phaseEnvironment(session);

    const proceed = await this.phaseResourceCheck(session, pipeline);
    if (!proceed) return false;

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
    const result = await runNextflow(session.command ?? [], runDir, this.io);
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
