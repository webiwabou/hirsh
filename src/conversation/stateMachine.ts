/**
 * Conversation state machine (Phases A–E).
 *
 * Drives the full flow using the AgentIO interface to talk to the user and an
 * LLMProvider for reasoning. State lives in `session`, whose `phase` is updated
 * at each step (queried by /status).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContainerEngine, ExecutorName, HirshConfig } from "../config/types.js";
import type { LLMProvider } from "../llm/index.js";
import type { PipelineDefinition } from "../pipelines/types.js";
import { checkEnvironment } from "../execution/envCheck.js";
import {
  BACKENDS,
  bootstrapConda,
  bootstrapNextflow,
  chooseBackend,
  detectBackends,
} from "../execution/environment.js";
import {
  buildExecutorConfig,
  chooseExecutor,
  describeExecutor,
  EXECUTORS,
} from "../execution/executor.js";
import { negotiateInfrastructure } from "../execution/negotiation.js";
import {
  addRun,
  defaultMemoryPath,
  emptyMemory,
  extractReferences,
  loadMemory,
  preferredEnvironment,
  relevantRuns,
  saveMemory,
  type EnvironmentPreference,
  type MemoryData,
  type RunRecord,
} from "../memory/store.js";
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
  buildFetchngsCommand,
  detectAccessions,
  fetchngsPipelineTag,
  fetchngsSamplesheetPath,
  renderIdsFile,
  type Accession,
} from "../execution/fetchngs.js";
import { validateSamplesheetContent } from "../execution/samplesheet.js";
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
import { buildMethods, readSoftwareVersions } from "../results/methods.js";
import { ModuleRegistry, RegistryFetchError } from "../modules/registry.js";
import { planComposition } from "../composition/planner.js";
import { generatePipeline } from "../composition/generator.js";
import { lintPipeline, stubRun, validateGenerated } from "../composition/validate.js";
import { collectLocalTool, toNfCoreModule, type LocalToolSpec } from "../composition/localModule.js";
import { proposeLocalTools } from "../composition/localToolProposal.js";
import { writeContribution } from "../composition/contribution.js";
import { buildInclusionGuide, validateNfCoreName } from "../composition/inclusion.js";
import { packagePipeline, type PackageSpec } from "../composition/packaging.js";
import type { ResolvedComposition } from "../composition/types.js";
import { initAndCommit, isGitAvailable } from "../execution/git.js";
import { checkGhCli, createGitHubRepo } from "../execution/publish.js";
import { extractIntent } from "./intentExtraction.js";
import { fillParameters, finalizeCommand, type MemorySuggestions } from "./parameterFilling.js";
import { reviewDesign, sortedObservations, worstSeverity } from "./designReview.js";
import { selectPipeline } from "./pipelineSelection.js";
import type { AgentIO } from "./io.js";
import type { Session, QueryContext } from "./session.js";

type SelectOutcome =
  | { kind: "pipeline"; pipeline: PipelineDefinition }
  | { kind: "compose" }
  | { kind: "none" };

const MAX_INTENT_ROUNDS = 8;

/** Normalizes a command's `-resume` flag so repeated re-runs never duplicate it. */
export function applyResume(command: string[], resume: boolean): string[] {
  const base = command.filter((a) => a !== "-resume");
  return resume ? [...base, "-resume"] : base;
}

/** Coerces a new string value to the type of the current value (number/boolean). */
export function coerceLike(
  current: string | number | boolean,
  raw: string,
): string | number | boolean {
  if (typeof current === "number" && raw.trim() !== "" && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }
  if (typeof current === "boolean" && /^(true|false)$/i.test(raw.trim())) {
    return raw.trim().toLowerCase() === "true";
  }
  return raw;
}

export class Agent {
  private memory: MemoryData | null = null;

  constructor(
    private readonly provider: LLMProvider,
    private readonly config: HirshConfig,
    private readonly registry: PipelineDefinition[],
    private readonly io: AgentIO,
  ) {}

  async run(session: Session): Promise<void> {
    await this.phaseIntent(session);
    this.surfacePastRuns(session.query);
    if (!(await this.phaseDesignReview(session))) {
      session.phase = "done";
      return;
    }
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

    // Co-scientist milestone: if the request names public accessions (SRA/GEO/…),
    // offer to download the data with nf-core/fetchngs and build the samplesheet
    // before parameterization consumes it.
    await this.phaseFetchData(session, pipeline);

    session.phase = "params";
    this.io.heading("Phase C · Parameterization");
    const { runDir } = await fillParameters(
      this.io,
      session,
      pipeline,
      this.config,
      this.memorySuggestions(session.query),
    );

    let executed = await this.phaseConfirmAndRun(session, runDir);
    if (executed) {
      await this.phaseResults(session, pipeline);
    }

    // Phase 2 — resume & re-run: offer to run again (with -resume, or after
    // changing a parameter) as long as a command was prepared.
    if (session.command) {
      for (;;) {
        const { done, executed: ran } = await this.phaseRerun(session, pipeline, runDir);
        if (ran) await this.phaseResults(session, pipeline);
        if (done) break;
      }
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

  /**
   * Phase 6 — scientific dialogue. Reviews the experimental design (replication,
   * controls, confounders/batch effects, balance, fit to objective) and shows
   * constructive observations. Advisory: on a serious concern it asks whether to
   * continue, but never forces a choice. Returns false only if the user chooses
   * to stop and rethink.
   */
  private async phaseDesignReview(session: Session): Promise<boolean> {
    const q = session.query;
    if (!q.objective && !q.experimentalDesign) return true;

    const review = await this.io.withSpinner("Reviewing the experimental design", () =>
      reviewDesign(this.provider, q),
    );
    if (!review || review.observations.length === 0) {
      if (review?.summary) this.io.info(review.summary);
      return true;
    }

    session.designReview = review; // carried into results interpretation (Phase E)
    this.io.heading("Experimental design review");
    if (review.summary) this.io.say(review.summary);
    for (const o of sortedObservations(review)) {
      const tag = o.severity === "risk" ? "⚠ risk" : o.severity === "caution" ? "caution" : "note";
      const line = `  ${tag} [${o.topic}]: ${o.message}`;
      if (o.severity === "info") this.io.info(line);
      else this.io.warn(line);
      if (o.suggestion) this.io.info(`       suggestion: ${o.suggestion}`);
    }

    const worst = worstSeverity(review);
    if (worst === "risk" || worst === "caution") {
      this.io.info(
        "This is advice, not a blocker — you know your experiment best. I can continue, or you " +
          "can refine the design (/reset) and describe it again.",
      );
      return this.io.confirm("Continue to pipeline selection?", true);
    }
    return true;
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

  /**
   * Public-data retrieval. If the request names public accessions (SRA/ENA/DDBJ
   * runs, GEO series, BioProjects…), Hirsh offers to download the data with
   * nf-core/fetchngs and build a samplesheet for the chosen pipeline — removing
   * the biggest manual step for a scientist who only has accession numbers.
   * Best-effort and skippable: on any obstacle it degrades to the normal Phase C
   * (asking for local files) rather than blocking.
   */
  private async phaseFetchData(session: Session, pipeline: PipelineDefinition): Promise<void> {
    const text = [
      session.query.objective,
      session.query.experimentalDesign,
      ...session.transcript.filter((t) => t.role === "user").map((t) => t.text),
    ]
      .filter(Boolean)
      .join("\n");
    const accessions = detectAccessions(text);
    if (accessions.length === 0) return;

    this.io.heading("Public-data retrieval");
    this.io.say(
      `I spotted ${accessions.length} public accession(s) in your request:`,
    );
    for (const a of accessions) this.io.info(`  • ${a.id} (${a.kind})`);
    const tag = fetchngsPipelineTag(pipeline.name);
    this.io.info(
      "I can download these with nf-core/fetchngs and build a samplesheet" +
        (tag ? ` formatted for ${pipeline.name}.` : "; it may need a small adjustment for this pipeline."),
    );
    const go = await this.io.confirm("Fetch the data automatically now?", true, { auto: true });
    if (!go) {
      this.io.info("Okay — I'll ask for local files during parameterization instead.");
      return;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fetchDir = resolve(this.config.execution.workdir, `fetchngs-${ts}`);
    const outdir = join(fetchDir, "results");
    try {
      mkdirSync(fetchDir, { recursive: true });
    } catch (err) {
      this.io.warn("Couldn't create a fetch directory: " + (err instanceof Error ? err.message : String(err)));
      return;
    }

    const engine = session.engine ?? this.config.execution.containerEngine;
    let env = await checkEnvironment(engine);
    if (!env.nextflow.available) {
      const boot = await bootstrapNextflow(this.io);
      this.io.info(boot.message);
      if (boot.installed) env = await checkEnvironment(engine);
    }
    if (!env.canExecute) {
      this.io.warn(
        "Can't fetch yet — Nextflow or the execution backend isn't available. " +
          "I'll ask for local files during parameterization instead.",
      );
      return;
    }

    const idsFile = join(fetchDir, "ids.csv");
    try {
      writeFileSync(idsFile, renderIdsFile(accessions), "utf8");
    } catch {
      this.io.warn("Couldn't write the accession list; skipping the fetch.");
      return;
    }

    const command = buildFetchngsCommand({ idsFile, outdir, engine, pipelineTag: tag });
    this.io.say("Command to run:");
    this.io.say("  nextflow " + command.join(" "));
    const run = await this.io.confirm("Run this download now?", true, { auto: true });
    if (!run) {
      this.io.info("Not fetching. I'll ask for local files during parameterization instead.");
      return;
    }

    this.io.heading("Running nf-core/fetchngs (live log)");
    const result = await runNextflow(command, fetchDir, this.io, session.runEnv);
    if (result.exitCode !== 0) {
      this.io.warn(`fetchngs exited with an error (code ${result.exitCode}).`);
      if (result.errorSummary) this.io.say(result.errorSummary);
      this.io.info("I'll ask for local files during parameterization instead.");
      return;
    }

    if (!this.applyFetchedSamplesheet(session, pipeline, outdir, accessions)) return;
  }

  /**
   * Validates the samplesheet fetchngs produced and, if usable, records it on the
   * session so Phase C skips manual samplesheet construction. Returns false when
   * the samplesheet is missing/unreadable so the caller falls back to Phase C.
   */
  private applyFetchedSamplesheet(
    session: Session,
    pipeline: PipelineDefinition,
    outdir: string,
    accessions: Accession[],
  ): boolean {
    const samplesheet = fetchngsSamplesheetPath(outdir);
    let text: string;
    try {
      text = readFileSync(samplesheet, "utf8");
    } catch {
      this.io.warn(
        `fetchngs finished but I couldn't find its samplesheet at ${samplesheet}. ` +
          "I'll ask for local files during parameterization instead.",
      );
      return false;
    }

    const report = validateSamplesheetContent(text, pipeline.samplesheet.columns);
    this.io.say(`Downloaded ${accessions.length} accession(s); samplesheet has ${report.rowCount} sample(s).`);
    for (const w of report.warnings) this.io.info("  ! " + w);
    for (const e of report.errors) this.io.warn("  ✗ " + e);
    if (!report.ok) {
      this.io.info(
        "The fetched samplesheet doesn't match this pipeline's columns exactly — you may need to " +
          "adjust it. Using it anyway; review it before the real run.",
      );
    }
    session.samplesheetPath = samplesheet;
    session.paramValues.input = samplesheet;
    this.io.info(`Using fetched samplesheet: ${samplesheet}`);
    return true;
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

    // Phase 4: have the LLM propose custom tools for gaps the modules don't cover,
    // then let the scientist add their own — both wired in as local modules.
    await this.proposeLocalToolsStep(resolved, session.query);
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

    // Phase 5: optional standards-compliant packaging and assisted publishing.
    await this.phasePackaging(result.dir, resolved, validation.nfCoreCli.available);

    // Phase 5: offer to prepare any custom local tools as nf-core/modules
    // contributions (files + nf-test; the PR stays a human-in-the-loop step).
    await this.offerContribution(resolved, this.config.execution.workdir);

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
      if (spec) this.addLocalToolToPlan(resolved, spec);
      add = await this.io.confirm("Add another custom tool?", false);
    }
  }

  /** Appends a local tool spec to the composition as a local module. */
  private addLocalToolToPlan(resolved: ResolvedComposition, spec: LocalToolSpec): boolean {
    if (resolved.modules.some((m) => m.name === spec.name)) {
      this.io.warn(`A module named "${spec.name}" is already in the plan; skipping.`);
      return false;
    }
    resolved.modules.push(toNfCoreModule(spec));
    resolved.localTools = [...(resolved.localTools ?? []), spec];
    resolved.plan.steps.push({
      module: spec.name,
      rationale: `Custom local tool: ${spec.description}`,
    });
    this.io.info(
      `Added local module "${spec.name}" (${spec.container ?? spec.conda ?? "no environment set"}).`,
    );
    return true;
  }

  /**
   * Phase 4 — LLM-proposed local tools. Asks the model whether any step the
   * objective needs is missing from the selected nf-core modules and, for each
   * proposed gap tool, offers to add it as a local module for the user to review.
   */
  private async proposeLocalToolsStep(
    resolved: ResolvedComposition,
    query: QueryContext,
  ): Promise<void> {
    const moduleNames = resolved.modules.filter((m) => !m.local).map((m) => m.name);
    const proposals = await this.io.withSpinner("Checking for gaps the modules don't cover", () =>
      proposeLocalTools(this.provider, query, moduleNames),
    );
    if (proposals.length === 0) return;

    this.io.say(
      `I think ${proposals.length} step(s) may need a custom tool the nf-core modules don't provide:`,
    );
    for (const spec of proposals) {
      this.io.say(`  • ${spec.name} — ${spec.description}`);
      this.io.info(`      command sketch: ${spec.command}`);
      this.io.info(
        `      in: ${spec.inputs[0]?.name} → out: ${spec.outputs[0]?.name} (${spec.outputs[0]?.pattern}); ` +
          `env: ${spec.container ?? spec.conda ?? "none — set one"}`,
      );
      const add = await this.io.confirm(`Add "${spec.name}" as a local module (review the sketch first)?`, false);
      if (add) {
        this.addLocalToolToPlan(resolved, spec);
        if (!spec.container && !spec.conda) {
          this.io.warn(`  Set a container/conda for "${spec.name}" and refine the command before a real run.`);
        }
      }
    }
  }

  /**
   * Phase 5 — standards-compliant packaging and (opt-in) assisted publishing.
   * Adds the files a full nf-core template carries (LICENSE, CHANGELOG, code of
   * conduct, CI, docs, manifest author/homePage), turns the project into a git
   * repo, re-runs lint to show the improvement, and — only with explicit
   * confirmation — creates and pushes a GitHub repository (defaulting to private).
   */
  private async phasePackaging(
    dir: string,
    resolved: ResolvedComposition,
    nfCoreAvailable: boolean,
  ): Promise<void> {
    const pkg = await this.io.confirm(
      "Package this to nf-core standards (LICENSE, CHANGELOG, CI, docs)?",
      false,
    );
    if (!pkg) return;

    const author = (await this.io.ask("Author/maintainer name (for LICENSE and manifest):")).trim() || "Anonymous";
    const homePage = (await this.io.ask("GitHub 'owner/repo' or homepage URL (blank to skip):")).trim();
    const spec: PackageSpec = {
      pipelineName: resolved.plan.pipelineName,
      author,
      homePage: homePage || undefined,
      description: resolved.plan.description,
    };

    const res = packagePipeline(dir, spec);
    this.io.info(
      `Added ${res.files.length} packaging files (LICENSE=MIT, CHANGELOG, CODE_OF_CONDUCT, CI, docs)` +
        (res.manifestPatched ? " and filled in the manifest author/homePage." : "."),
    );

    // Make it a real repository (also stops nf-core lint failing for "not a repo").
    if (await isGitAvailable()) {
      const git = await this.io.withSpinner("Initializing git repository", () =>
        initAndCommit(dir, "Initial pipeline scaffold composed by Hirsh"),
      );
      if (git.ok) this.io.info("Initialized a git repository with an initial commit.");
      else this.io.warn("Could not initialize git: " + (git.error ?? "unknown error"));
    } else {
      this.io.info("git not found — skipping repository initialization.");
    }

    // Re-run lint to show the packaging improved the score.
    if (nfCoreAvailable) {
      const lint = await this.io.withSpinner("Re-running nf-core lint after packaging", () =>
        lintPipeline(dir),
      );
      if (lint.ran && lint.failed != null) {
        this.io.info(
          `nf-core lint (after packaging): ${lint.passed ?? 0} passed, ${lint.warned ?? 0} warnings, ${lint.failed} failed.`,
        );
      }
    }

    await this.offerPublish(dir, resolved);
    await this.offerInclusionGuide(dir, resolved.plan.pipelineName);
  }

  /**
   * Phase 5 — nf-core inclusion guidance. Offers to write a step-by-step guide
   * (naming check, scope proposal, template/lint requirements, review) for getting
   * the pipeline adopted into nf-core — honest that acceptance is a community call.
   */
  private async offerInclusionGuide(dir: string, pipelineName: string): Promise<void> {
    const want = await this.io.confirm(
      "Show how to get this pipeline included in nf-core (community process)?",
      false,
    );
    if (!want) return;

    const check = validateNfCoreName(pipelineName);
    if (!check.ok) {
      this.io.warn(
        `Heads-up on the name: nf-core names are short, lowercase and alphanumeric — ` +
          `"${pipelineName}" would become "${check.normalized}". ${check.issues.join(" ")}`,
      );
    }
    const guide = buildInclusionGuide(pipelineName);
    const path = join(dir, "NFCORE_INCLUSION.md");
    try {
      writeFileSync(path, guide, "utf8");
      this.io.info(`Inclusion guide written: ${path}`);
    } catch {
      /* best-effort */
    }
    this.io.info(
      "In short: propose it in the nf-core Slack #new-pipelines (scope check), build from the " +
        "official template, get `nf-core pipelines lint` green with full test data and reviews, " +
        "then a maintainer creates it under nf-core. Acceptance is the community's decision.",
    );
  }

  /** Assisted GitHub publishing — strictly opt-in, defaulting to a private repo. */
  private async offerPublish(dir: string, resolved: ResolvedComposition): Promise<void> {
    const wants = await this.io.confirm("Publish this pipeline to a GitHub repository?", false, {
      consequential: true,
    });
    if (!wants) {
      this.io.info("Not publishing. The project is ready locally whenever you want to share it.");
      return;
    }

    const gh = await checkGhCli();
    if (!gh.installed || !gh.authenticated) {
      this.io.warn(gh.note ?? "GitHub CLI is not usable.");
      return;
    }

    const name = (await this.io.ask(`Repository name [${resolved.plan.pipelineName}]:`)).trim() ||
      resolved.plan.pipelineName;
    const makePublic = await this.io.confirm(
      "Make the repository PUBLIC? (No = private, recommended)",
      false,
      { consequential: true },
    );
    const visibility = makePublic ? "public" : "private";

    if (makePublic) {
      this.io.warn(
        "A public repository is visible to everyone and may be indexed/cached even if later deleted.",
      );
    }
    const confirm = await this.io.confirm(
      `Create and push a ${visibility} GitHub repo "${name}" now?`,
      false,
      { consequential: true },
    );
    if (!confirm) {
      this.io.info("Cancelled — nothing was published.");
      return;
    }

    const result = await this.io.withSpinner("Creating and pushing the GitHub repository", () =>
      createGitHubRepo(dir, { name, visibility, description: resolved.plan.description }),
    );
    if (result.ok) {
      this.io.say(`Published: ${result.url ?? "(repository created)"}`);
    } else {
      this.io.warn("Publishing failed: " + (result.error ?? "unknown error"));
    }
  }

  /**
   * Phase 5 — assisted contribution. For each custom local tool, offers to write
   * it out in the nf-core/modules layout (main.nf, meta.yml, environment.yml,
   * nf-test) and guides the PR. Opening the PR stays a deliberate human step —
   * Hirsh prepares and advises; nf-core acceptance is a community decision.
   */
  private async offerContribution(resolved: ResolvedComposition, baseDir: string): Promise<void> {
    const locals = resolved.localTools ?? [];
    if (locals.length === 0) return;

    for (const spec of locals) {
      const yes = await this.io.confirm(
        `Prepare "${spec.name}" as an nf-core/modules contribution (with an nf-test)?`,
        false,
      );
      if (!yes) continue;

      const res = writeContribution(baseDir, spec);
      this.io.say(`Wrote an nf-core/modules-style module at ${res.dir}:`);
      for (const f of res.files) this.io.info("  • " + f);

      this.io.say("To contribute it (you review and run these — acceptance is a community decision):");
      this.io.info(`  1) Fork nf-core/modules and copy this module into modules/nf-core/${spec.name}/.`);
      this.io.info(`  2) Add real test inputs, then \`nf-core modules test ${spec.name}\` to make the snapshot.`);
      this.io.info(`  3) \`nf-core modules lint ${spec.name}\` and iterate until green.`);
      this.io.info("  4) Open a PR to nf-core/modules (e.g. `gh pr create --repo nf-core/modules --draft`).");
      this.io.info(
        "The container/conda, versions and stub are scaffolded — fill in a real version command and test data.",
      );
      if (!spec.conda) {
        this.io.warn(
          "  No conda dependency set — add one in environment.yml; nf-core requires a conda spec.",
        );
      }
    }
  }

  // --- Project memory (Phase 6) ---

  private memoryPath(): string {
    return this.config.memory.path ?? defaultMemoryPath();
  }

  private mem(): MemoryData {
    if (this.memory) return this.memory;
    this.memory = this.config.memory.enabled ? loadMemory(this.memoryPath()) : emptyMemory();
    return this.memory;
  }

  /** Shows relevant past analyses from project memory (opt-out via config). */
  private surfacePastRuns(query: QueryContext): void {
    if (!this.config.memory.enabled) return;
    const past = relevantRuns(this.mem(), query, 3);
    if (past.length === 0) return;
    this.io.info("From your project memory — similar past analyses:");
    for (const r of past) {
      const status = r.executed ? (r.exitCode === 0 ? "completed" : "failed") : "prepared";
      this.io.info(
        `  • ${r.date.slice(0, 10)}: ${r.pipeline} — ${r.objective ?? r.dataType ?? "analysis"} (${status})`,
      );
      if (r.outdir) this.io.info(`      results: ${r.outdir}`);
    }
  }

  /** Collects remembered references/samplesheets from relevant past runs. */
  private memorySuggestions(query: QueryContext): MemorySuggestions {
    if (!this.config.memory.enabled) return { references: {}, samplesheets: [] };
    const references: Record<string, string[]> = {};
    const samplesheets: string[] = [];
    for (const r of relevantRuns(this.mem(), query, 5)) {
      for (const [k, v] of Object.entries(r.references ?? {})) {
        const list = (references[k] ??= []);
        if (!list.includes(v)) list.push(v);
      }
      if (r.samplesheet && !samplesheets.includes(r.samplesheet)) samplesheets.push(r.samplesheet);
    }
    return { references, samplesheets };
  }

  /**
   * The backend/executor remembered from the most recent run on this machine
   * (empty when memory is disabled or nothing is remembered). Only values that
   * are still valid engines/executors are returned, so a stale/corrupt record
   * can't force a bad default.
   */
  private envPreference(): EnvironmentPreference {
    if (!this.config.memory.enabled) return {};
    const pref = preferredEnvironment(this.mem());
    return {
      engine: pref.engine && pref.engine in BACKENDS ? pref.engine : undefined,
      executor: pref.executor && pref.executor in EXECUTORS ? pref.executor : undefined,
      queue: pref.queue,
    };
  }

  /** Records a run into project memory (best-effort; never blocks). */
  private recordRun(session: Session, executed: boolean, exitCode?: number): void {
    if (!this.config.memory.enabled) return;
    const pipeline = session.selectedPipeline;
    if (!pipeline) return;
    try {
      const record: RunRecord = {
        date: new Date().toISOString(),
        pipeline: pipeline.name,
        revision: pipeline.version,
        organism: session.query.organism,
        dataType: session.query.dataType,
        objective: session.query.objective,
        experimentalDesign: session.query.experimentalDesign,
        samplesheet: session.samplesheetPath,
        outdir: session.outdir,
        references: extractReferences(session.paramValues),
        engine: session.engine ?? this.config.execution.containerEngine,
        executor: session.executor ? describeExecutor(session.executor) : "local machine",
        executorName: session.executor?.executor ?? "local",
        queue: session.executor?.queue,
        executed,
        exitCode,
      };
      this.memory = addRun(this.mem(), record);
      saveMemory(this.memoryPath(), this.memory);
    } catch {
      /* never block on memory */
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
          const override = await this.io.confirm("Run anyway against my recommendation?", false, {
            consequential: true,
          });
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
    let statuses = await this.io.withSpinner("Checking execution backends", () =>
      detectBackends(),
    );

    // Phase 6: default to the backend remembered from the last run on this
    // machine (if it's still valid), otherwise the configured default. Only a
    // preview of the default — the user still confirms/switches below.
    const remembered = this.envPreference().engine as ContainerEngine | undefined;
    const preferred = remembered ?? this.config.execution.containerEngine;
    if (remembered && remembered !== this.config.execution.containerEngine) {
      this.io.info(
        `From your project memory: the last run on this machine used ${BACKENDS[remembered].label}; ` +
          "I'll default to it (you can still switch).",
      );
    }
    let chosen = await chooseBackend(this.io, statuses, preferred);

    // Phase 3: nothing available → offer to install Conda/Mamba (Miniforge) so a
    // fresh machine can still run, then re-detect and choose.
    if (!chosen) {
      const boot = await bootstrapConda(this.io);
      this.io.info(boot.message);
      if (boot.installed) {
        statuses = await detectBackends();
        chosen = await chooseBackend(this.io, statuses, "conda");
      }
    }

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
    // Phase 6: default to where the last run on this machine went (executor +
    // queue), falling back to the configured executor. Still confirmed below.
    const pref = this.envPreference();
    const remembered = pref.executor as ExecutorName | undefined;
    const configured = remembered ?? this.config.execution.executor ?? "local";
    const defaultQueue = (remembered ? pref.queue : undefined) ?? this.config.execution.queue;
    if (remembered && remembered !== (this.config.execution.executor ?? "local")) {
      this.io.info(
        `From your project memory: the last run on this machine used ${EXECUTORS[remembered].label}` +
          (pref.queue ? ` (queue "${pref.queue}")` : "") +
          "; I'll default to it (you can still switch).",
      );
    }
    const settings = await chooseExecutor(this.io, configured, defaultQueue);
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
    const go = await this.io.confirm("Try to run anyway despite low disk?", false, {
      consequential: true,
    });
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

    // Running spends compute — but opting into autonomy authorizes it, so auto
    // mode proceeds here (while the resource-refuse/disk gates above still stop).
    const go = await this.io.confirm("Run this command now?", false, { auto: true });
    if (!go) {
      this.io.info("Not running anything. The command and samplesheet are ready if you want to launch it yourself.");
      this.writeRunProvenance(session, runDir, env, false);
      return false;
    }

    return this.executeAndReport(session, runDir, env, false);
  }

  /**
   * Runs Nextflow (optionally with `-resume`), writes provenance and reports the
   * outcome. `-resume` is normalized so repeated re-runs never duplicate it.
   */
  private async executeAndReport(
    session: Session,
    runDir: string,
    env: EnvReport,
    resume: boolean,
  ): Promise<boolean> {
    session.command = applyResume(session.command ?? [], resume);

    session.phase = "execute";
    this.io.heading("Running Nextflow (live log)");
    const result = await runNextflow(session.command, runDir, this.io, session.runEnv);
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
   * Phase 2 — resume & re-run. After a run, offers to re-run reusing cached
   * results (`-resume`) or to change one parameter and run again. Reuses the
   * already-chosen backend/executor/env, so it's a quick loop. Returns whether a
   * run was executed (so the caller can re-interpret results), and whether the
   * user wants to keep going.
   */
  private async phaseRerun(
    session: Session,
    pipeline: PipelineDefinition,
    runDir: string,
  ): Promise<{ done: boolean; executed: boolean }> {
    if (!session.command) return { done: true, executed: false };

    this.io.say("");
    this.io.say("Re-run options:");
    this.io.say("  1) Re-run reusing cached results (-resume)");
    this.io.say("  2) Re-run after changing one parameter");
    this.io.say("  3) No, I'm done");
    const ans = (await this.io.ask("Choose [3]:")).trim().toLowerCase();
    if (ans === "" || ans === "3" || /^(n|no|done)$/.test(ans)) {
      return { done: true, executed: false };
    }

    let resume: boolean;
    if (ans === "1") {
      resume = true;
    } else if (ans === "2") {
      const changed = await this.changeOneParameter(session, pipeline);
      if (!changed) return { done: false, executed: false };
      resume = await this.io.confirm(
        "Reuse cached results for the unchanged steps (-resume)?",
        true,
      );
    } else {
      this.io.warn("I didn't understand that option.");
      return { done: false, executed: false };
    }

    const engine = session.engine ?? this.config.execution.containerEngine;
    const env = await checkEnvironment(engine);
    if (!env.canExecute) {
      this.io.warn("Can't re-run right now — the required software isn't available.");
      return { done: false, executed: false };
    }

    const preview = applyResume(session.command ?? [], resume);
    this.io.say("Command to run:");
    this.io.say("  nextflow " + preview.join(" "));
    const go = await this.io.confirm("Run it now?", true);
    if (!go) return { done: false, executed: false };

    const executed = await this.executeAndReport(session, runDir, env, resume);
    return { done: false, executed };
  }

  /**
   * Lets the user change one resolved parameter and rebuilds the command/params
   * file. Returns true if a value actually changed.
   */
  private async changeOneParameter(session: Session, pipeline: PipelineDefinition): Promise<boolean> {
    const entries = Object.entries(session.paramValues);
    if (entries.length === 0) {
      this.io.info("There are no parameters to change.");
      return false;
    }
    this.io.say("Current parameters:");
    entries.forEach(([k, v], i) => this.io.say(`  ${i + 1}) ${k} = ${v}`));
    const sel = (await this.io.ask("Which parameter to change? (number or name):")).trim();

    let name: string | null = null;
    const n = Number.parseInt(sel, 10);
    if (Number.isInteger(n) && n >= 1 && n <= entries.length) name = entries[n - 1][0];
    else if (session.paramValues[sel] !== undefined) name = sel;
    if (!name) {
      this.io.warn("I didn't recognize that parameter.");
      return false;
    }

    const current = session.paramValues[name];
    const raw = (await this.io.ask(`New value for ${name} (current: ${current}):`)).trim();
    if (raw === "") {
      this.io.info("Left unchanged.");
      return false;
    }
    session.paramValues[name] = coerceLike(current, raw);
    if (name === pipeline.results.outdirParam) session.outdir = String(session.paramValues[name]);
    finalizeCommand(session, pipeline, this.config);
    this.io.info(`Set ${name} = ${session.paramValues[name]}.`);
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
    // Phase 6: remember this analysis for future sessions (opt-out via config).
    this.recordRun(session, executed, exitCode);
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

    // Carry the pre-run design caveats (caution/risk) into the interpretation so
    // Hirsh revisits their impact on the actual results.
    const designNotes = (session.designReview?.observations ?? [])
      .filter((o) => o.severity !== "info")
      .map((o) => `[${o.topic}] ${o.message}`);

    this.io.say("Results summary:\n");
    await summarizeResults(
      this.provider,
      pipeline,
      session.query,
      report,
      (chunk) => this.io.raw(chunk),
      designNotes,
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

    await this.offerMethods(session, pipeline);
  }

  /**
   * Phase 6 — publication-ready methods. Builds a paste-ready methods paragraph
   * and references from the run's pinned versions, container engine and the real
   * tool versions nf-core recorded, and writes METHODS.md into the run directory.
   */
  private async offerMethods(session: Session, pipeline: PipelineDefinition): Promise<void> {
    if (!session.outdir) return;
    const make = await this.io.confirm(
      "Generate a publication-ready methods paragraph (METHODS.md)?",
      true,
    );
    if (!make) return;

    const tools = readSoftwareVersions(session.outdir, pipeline.name);
    let nextflowVersion: string | undefined;
    let containerEngine: string = session.engine ?? this.config.execution.containerEngine;
    try {
      const manifest = JSON.parse(readFileSync(join(session.runDir ?? "", "run_manifest.json"), "utf8"));
      nextflowVersion = manifest?.environment?.nextflow;
      if (manifest?.environment?.containerEngine) containerEngine = manifest.environment.containerEngine;
    } catch {
      /* manifest optional */
    }

    const { paragraph, markdown } = buildMethods({
      pipelineName: pipeline.name,
      revision: pipeline.version,
      nextflowVersion,
      containerEngine,
      organism: session.query.organism,
      dataType: session.query.dataType,
      tools,
      pipelineCitation: pipeline.citation,
    });

    const path = join(session.runDir ?? session.outdir, "METHODS.md");
    try {
      writeFileSync(path, markdown, "utf8");
      this.io.info(`Methods written: ${path}`);
    } catch {
      /* best-effort */
    }
    this.io.say("\nMethods (paste-ready):");
    this.io.say(paragraph);
    if (Object.keys(tools).length === 0) {
      this.io.info(
        "(No software-versions file found under pipeline_info/ — tool versions omitted; the " +
          "paragraph still cites the pipeline, Nextflow and nf-core.)",
      );
    }
  }
}
