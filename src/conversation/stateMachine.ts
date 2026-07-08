/**
 * Conversation state machine (Phases A–E).
 *
 * Drives the full flow using the AgentIO interface to talk to the user and an
 * LLMProvider for reasoning. State lives in `session`, whose `phase` is updated
 * at each step (queried by /status).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { ContainerEngine, ExecutorName, HirshConfig } from "../config/types.js";
import { persistExecutionChoice, type ExecutionUpdates } from "../config/writeConfig.js";
import type { LLMProvider } from "../llm/index.js";
import type { PipelineCitation, PipelineDefinition, ResultOutput } from "../pipelines/types.js";
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
  lastPeakMemoryFor,
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
import { parseInvalidParams } from "../execution/nextflowErrors.js";
import {
  buildFetchngsCommand,
  detectAccessions,
  fetchngsPipelineTag,
  fetchngsSamplesheetPath,
  renderIdsFile,
  type Accession,
} from "../execution/fetchngs.js";
import {
  fastqPairsFromSamplesheet,
  inferPairs,
  previewCsv,
  scanFastqs,
  scanSequenceDir,
  validateSamplesheetContent,
  writeCsv,
  type FastqPair,
} from "../execution/samplesheet.js";
import {
  buildFollowUpCommand,
  isRunnableFollowUp,
  upstreamInputPaths,
} from "../execution/followUp.js";
import {
  assessResources,
  detectMachine,
  formatMemoryGB,
  parseMemoryToGB,
  type MachineResources,
} from "../execution/resources.js";
import { buildManifest, readRunContainers, writeProvenance } from "../execution/provenance.js";
import type { EnvReport } from "../execution/envCheck.js";
import {
  findHtmlReports,
  gatherResults,
  listRelativeFiles,
  summarizeResults,
  type InterpretablePipeline,
  type ResultsReport,
} from "../results/interpreter.js";
import { renderBarChart } from "../results/charts.js";
import { parseTraceResources } from "../results/parsers.js";
import { renderResultsReportHtml, type ReportArtifact } from "../results/report.js";
import { buildMethods, readSoftwareVersions } from "../results/methods.js";
import { ModuleRegistry, RegistryFetchError } from "../modules/registry.js";
import { planComposition } from "../composition/planner.js";
import { generatePipeline, type GenerationResult } from "../composition/generator.js";
import { lintPipeline, stubRun, validateGenerated } from "../composition/validate.js";
import { planLintFixes, shouldContinueFixing, stripNfCoreTodos } from "../composition/lintFix.js";
import {
  buildComposedRunCommand,
  composedRowsFromFiles,
  type ComposedRunParam,
  type ComposedSheetRow,
} from "../composition/run.js";
import { collectLocalTool, toNfCoreModule, type LocalToolSpec } from "../composition/localModule.js";
import { proposeLocalTools } from "../composition/localToolProposal.js";
import { writeContribution } from "../composition/contribution.js";
import { renderNoveltyManifest, summarizeNovelty } from "../composition/novelty.js";
import { buildInclusionGuide, validateNfCoreName } from "../composition/inclusion.js";
import { packagePipeline, type PackageSpec } from "../composition/packaging.js";
import type { ResolvedComposition } from "../composition/types.js";
import { initAndCommit, isGitAvailable } from "../execution/git.js";
import { checkGhCli, createGitHubRepo } from "../execution/publish.js";
import { extractIntent, hasEnoughContext, isDuplicateQuestion } from "./intentExtraction.js";
import { fillParameters, finalizeCommand, type MemorySuggestions } from "./parameterFilling.js";
import {
  designReviewApplies,
  reviewDesign,
  worstSeverity,
  type DesignObservation,
} from "./designReview.js";
import { reviewSamplesheetContent } from "./samplesheetReview.js";
import { contrastsCsv, proposeContrastsFromSheet } from "./contrasts.js";
import { classifyPathAnswer, wantsTestProfile } from "./pathInput.js";
import { chooseWith } from "./choice.js";
import { selectPipeline } from "./pipelineSelection.js";
import {
  buildNfCoreTestRunCommand,
  fetchNfCoreCatalog,
  rankNfCorePipelines,
  type NfCorePipeline,
} from "../pipelines/nfcoreCatalog.js";
import {
  fetchSynthesizedSpec,
  isSimpleFastqSheet,
  toColumnSpecs,
  type InputColumn,
  type SynthParam,
} from "../pipelines/nfcoreSchema.js";
import {
  buildSynthesizedDefinition,
  definitionFileName,
  detectResultOutputs,
  renderDefinitionYaml,
} from "../pipelines/synthDefinition.js";
import { invalidateRegistryCache, loadRegistry, userDefinitionsDir } from "../pipelines/registry.js";
import type { AgentIO, ChoiceOption } from "./io.js";
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
  private consentChecked = false;
  private envPersistDone = false;

  constructor(
    private readonly provider: LLMProvider,
    private readonly config: HirshConfig,
    private readonly registry: PipelineDefinition[],
    private readonly io: AgentIO,
    /** Path of the loaded config file, for persisting the env choice back. */
    private readonly configPath?: string,
    /** Autonomous mode: derive what we can (references from organism) instead of asking. */
    private readonly autonomous = false,
  ) {}

  async run(session: Session): Promise<void> {
    await this.ensureMemoryConsent();
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
      { autonomous: this.autonomous },
    );

    // Scientific dialogue, now grounded in the actual samplesheet (per-group
    // replicate counts, balance) — complements the pre-run design review.
    this.reviewBuiltSamplesheet(session);

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

    const asked: string[] = [];
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

      // Anti-redundancy guards (a weak model tends to keep probing): once the core
      // fields are known, move on; and never re-ask an effectively duplicate
      // question. The user can still correct things at pipeline selection.
      if (hasEnoughContext(session.query)) {
        this.io.info("Got it — I have enough to get started (you can correct me at the next step).");
        return;
      }

      const question =
        intent.nextQuestion ??
        "Could you give me more details about the organism, data type and your objective?";
      if (isDuplicateQuestion(question, asked)) {
        this.io.info("Let's continue with what I have — you can refine it as we go.");
        return;
      }
      asked.push(question);
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

    // Skip the design review for descriptive/observational or single-sample tasks:
    // there's no experimental design (replication/controls/batch) to critique, and
    // forcing it produces absurd advice.
    if (!designReviewApplies(q)) {
      this.io.info(
        "This looks like a descriptive/single-sample analysis, so there's no experimental " +
          "design to review — moving on to the pipeline.",
      );
      return true;
    }

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
    this.presentObservations(review.observations);

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

  /** Renders design observations (most serious first), warnings for caution/risk. */
  private presentObservations(observations: DesignObservation[]): void {
    const order: Record<DesignObservation["severity"], number> = { risk: 0, caution: 1, info: 2 };
    for (const o of [...observations].sort((a, b) => order[a.severity] - order[b.severity])) {
      const tag = o.severity === "risk" ? "⚠ risk" : o.severity === "caution" ? "caution" : "note";
      const line = `  ${tag} [${o.topic}]: ${o.message}`;
      if (o.severity === "info") this.io.info(line);
      else this.io.warn(line);
      if (o.suggestion) this.io.info(`       suggestion: ${o.suggestion}`);
    }
  }

  /**
   * Scientific dialogue, grounded in the built samplesheet: counts biological
   * replicates per group and raises concrete concerns (no replication, the bare
   * minimum of two, unbalanced groups) that the description-based review can't
   * see. Advisory — the run confirmation that follows is the decision point. Merges
   * its observations into `session.designReview` so they carry into interpretation.
   */
  private reviewBuiltSamplesheet(session: Session): void {
    if (!session.samplesheetPath) return;
    let text: string;
    try {
      text = readFileSync(session.samplesheetPath, "utf8");
    } catch {
      return;
    }
    const design = reviewSamplesheetContent(text);
    if (design.observations.length === 0) return;

    const worst = worstSeverity({ observations: design.observations, summary: "" });
    if (worst === "info") {
      // Nothing concerning — just confirm the design we see (positive feedback).
      for (const o of design.observations) this.io.info(o.message);
    } else {
      this.io.heading("Samplesheet design check");
      this.presentObservations(design.observations);
      this.io.info("This is advice, not a blocker — you decide at the run confirmation below.");
    }

    // Carry into interpretation (Phase E revisits these against the results).
    const existing = session.designReview ?? { observations: [], summary: "" };
    session.designReview = {
      summary: existing.summary,
      observations: [...existing.observations, ...design.observations],
    };
  }

  /** Phase B — select the pipeline and allow user correction. */
  private async phaseSelect(session: Session): Promise<SelectOutcome> {
    session.phase = "select";
    this.io.heading("Phase B · Pipeline selection");

    // The user can accept, decline, or answer in natural language ("actually
    // it's paired-end WGS") — in which case we fold that back into the intent and
    // reconsider, rather than forcing a bare yes/no.
    let rejected: string | null = null;
    for (let round = 0; round < 4; round++) {
      const sel = await this.io.withSpinner("Choosing the right pipeline", () =>
        selectPipeline(this.provider, this.registry, session.query),
      );

      const chosen = sel.pipelineName
        ? this.registry.find((p) => p.name === sel.pipelineName) ?? null
        : null;

      // If reconsidering just lands back on the pipeline the user explicitly
      // pushed back on, don't re-suggest it — that means none really fits.
      if (!chosen || (rejected && chosen.name === rejected)) {
        this.io.warn(
          chosen
            ? `None of the curated pipelines really fit — ${chosen.name} is only a loose match for what you described.`
            : "I couldn't find a curated pipeline that fits your case well: " + sel.rationale,
        );
        // Before composing from scratch, check whether an established nf-core
        // pipeline already covers this — a real bioinformatician would reach for
        // nf-core/atacseq before assembling one from modules.
        if (await this.suggestEstablishedPipeline(session)) return { kind: "none" };
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

      // Free-text answer → the user is pushing back on this suggestion. Remember
      // it so we don't just re-suggest the same pipeline, and re-decide.
      rejected = chosen.name;
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
   * When no curated pipeline fits, searches the live nf-core catalog (~100
   * production pipelines) for an established one that matches the intent and, if
   * found, recommends it — offering to run its bundled `test` profile as a real,
   * self-contained smoke run so the scientist can see it work. This is the
   * co-scientist reflex: recommend the real existing pipeline before assembling
   * one from modules. Returns true if it handled selection (the user ran a test
   * profile, so the guided flow ends here), false to fall through to composition.
   * Best-effort: any network/error degrades silently to composition.
   */
  private async suggestEstablishedPipeline(session: Session): Promise<boolean> {
    const terms = [
      session.query.objective,
      session.query.dataType,
      session.query.organism,
      ...session.transcript.filter((t) => t.role === "user").map((t) => t.text),
    ].filter((t): t is string => Boolean(t));
    if (terms.length === 0) return false;

    let ranked: ReturnType<typeof rankNfCorePipelines> = [];
    try {
      const catalog = await this.io.withSpinner("Searching the nf-core pipeline catalog", () =>
        fetchNfCoreCatalog(),
      );
      ranked = rankNfCorePipelines(catalog, terms, 3).filter((r) => r.pipeline.latestRelease);
    } catch {
      return false; // offline or catalog unreachable → fall through to compose
    }
    if (ranked.length === 0) return false;

    const top = ranked[0].pipeline;
    this.io.say(
      `There's an established nf-core pipeline that likely fits: ${top.fullName} — ${top.description}`,
    );
    if (ranked.length > 1) {
      this.io.info("Other close matches:");
      for (const r of ranked.slice(1)) this.io.info(`  • ${r.pipeline.fullName} — ${r.pipeline.description}`);
    }
    this.io.info(
      `${top.fullName} isn't in my curated set yet, but I can still run it: on your own data (I'll read ` +
        "its input spec and ask only for the samplesheet and references it needs), or its bundled test " +
        "profile as a quick smoke run on nf-core's example data.",
    );

    const choice = await chooseWith(
      this.io,
      `How would you like to proceed with ${top.fullName}?`,
      [
        {
          label: "Run it on my own data",
          value: "data",
          description: "I fetch its input spec and ask for the samplesheet + references it needs",
          recommended: true,
        },
        {
          label: "Run its test profile",
          value: "test",
          description: `Smoke run on nf-core's example data (${top.latestRelease})`,
        },
        {
          label: "Compose one from modules instead",
          value: "compose",
          description: "Build a custom pipeline from nf-core/modules",
        },
      ],
      { allowCustom: false },
    );

    if (choice === "compose") return false; // caller offers composition
    if (choice === "data" && (await this.runEstablishedOnData(session, top))) {
      return true;
    }
    // Explicit "test", or the on-data path couldn't fetch the schema — smoke run.
    await this.runEstablishedTestProfile(session, top);
    return true;
  }

  /**
   * Offers to auto-curate a catalog pipeline into a persistent definition, so it
   * becomes a first-class, guided pipeline next session. Best-effort: reads the
   * schema, writes an honest auto-generated YAML to ~/.bioagent/pipelines, and
   * confirms it loads (removing it if it doesn't). Never blocks the run.
   */
  private async offerCuration(pipeline: NfCorePipeline, outdir?: string): Promise<void> {
    if (this.registry.some((p) => p.name === pipeline.fullName)) return; // already curated
    if (!pipeline.latestRelease) return;
    const yes = await this.io.confirm(
      `Curate ${pipeline.fullName} into Hirsh, so it's a guided, first-class pipeline next time?`,
      true,
    );
    if (!yes) return;

    const spec = await this.io.withSpinner("Reading its schema to curate it", () =>
      fetchSynthesizedSpec(pipeline.fullName, pipeline.latestRelease!),
    );
    if (!spec) {
      this.io.warn("Couldn't read the pipeline's schema; not curating.");
      return;
    }
    // Learn the real result outputs (MultiQC, VCF dirs) from the completed run so
    // the curated definition interprets concrete files, not a generic directory.
    let learned: ResultOutput[] | undefined;
    if (outdir && existsSync(outdir)) {
      const files = listRelativeFiles(outdir);
      if (files.length > 0) learned = detectResultOutputs(files);
    }
    const def = buildSynthesizedDefinition(
      {
        fullName: pipeline.fullName,
        description: pipeline.description,
        topics: pipeline.topics,
        revision: pipeline.latestRelease,
        url: pipeline.url,
      },
      spec,
      learned,
    );
    const yaml = renderDefinitionYaml(def, new Date().toISOString().slice(0, 10));
    const dir = userDefinitionsDir();
    const file = join(dir, definitionFileName(pipeline.fullName));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, yaml, "utf8");
      invalidateRegistryCache();
      const reloaded = loadRegistry();
      if (!reloaded.some((p) => p.name === pipeline.fullName)) {
        rmSync(file, { force: true });
        invalidateRegistryCache();
        this.io.warn("The generated definition didn't validate; not curating.");
        return;
      }
    } catch (err) {
      this.io.warn("Couldn't write the definition: " + (err instanceof Error ? err.message : String(err)));
      return;
    }
    const learnedNote =
      learned && learned.some((o) => o.kind !== "directory")
        ? ` (learned its ${learned
            .filter((o) => o.kind !== "directory")
            .map((o) => (o.kind === "multiqc_html" ? "MultiQC report" : o.path))
            .join(", ")} from the run)`
        : "";
    this.io.say(`Curated ${pipeline.fullName} → ${file}${learnedNote}`);
    this.io.info(
      "Next session it'll be a guided pipeline. It's honest boilerplate — edit that file to refine its " +
        "result outputs, resources and citation DOI; delete it to revert to the schema-driven flow.",
    );
  }

  /**
   * Runs an established (not-yet-curated) nf-core pipeline on the scientist's own
   * data by synthesizing a short parameter interview from the pipeline's own
   * schemas: it builds/validates the samplesheet against the real column spec and
   * asks only for the references the pipeline needs, then runs it through the
   * normal environment gate, runner and interpreter. Returns true once it has
   * taken over (even if the user skips the input); false only when the schema is
   * unreachable, so the caller can fall back to the test profile.
   */
  private async runEstablishedOnData(session: Session, top: NfCorePipeline): Promise<boolean> {
    const pipeline = top.fullName;
    const revision = top.latestRelease!;
    const description = top.description;
    const spec = await this.io.withSpinner("Fetching the pipeline's input spec", () =>
      fetchSynthesizedSpec(pipeline, revision),
    );
    if (!spec) {
      this.io.warn(`Couldn't read ${pipeline}'s schema (network?). I'll offer its test profile instead.`);
      return false;
    }

    await this.phaseEnvironment(session);
    const engine = session.engine ?? this.config.execution.containerEngine;

    const short = pipeline.split("/").pop() ?? pipeline;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const runDir = resolve(this.config.execution.workdir, `${short}-${ts}`);
    const outdir = join(runDir, "results");
    try {
      mkdirSync(runDir, { recursive: true });
    } catch (err) {
      this.io.warn("Couldn't create a run directory: " + (err instanceof Error ? err.message : String(err)));
      return true;
    }

    const sheet = await this.prepareSchemaSamplesheet(runDir, spec.columns);
    if (!sheet) {
      this.io.info(
        `Without a samplesheet I can't run ${pipeline} on your data. Its input format is documented at ` +
          `https://nf-co.re/${short}/${revision}/docs/usage — prepare one and re-run, or ask me for its test profile.`,
      );
      return true;
    }

    const params: Record<string, string | number | boolean> = { input: sheet, outdir };
    // Ask required params first, then the iGenomes `genome` key (which, if given,
    // covers the FASTA/GTF/index references), then any remaining references.
    const required = spec.params.filter((p) => p.required && p.name !== "input" && p.name !== "outdir");
    const genomeParam = spec.params.find((p) => p.name === "genome" && !p.required);
    const others = spec.params.filter((p) => !p.required && p.name !== "genome");
    const ordered = [...required, ...(genomeParam ? [genomeParam] : []), ...others];
    let genomeGiven = false;
    for (const p of ordered) {
      if (p.name in params) continue;
      if (genomeGiven && p.reference && p.name !== "genome") continue; // covered by the iGenomes key
      const value = await this.askSchemaParam(p);
      if (value === undefined || value === "") {
        if (p.required) {
          this.io.warn(`${p.name} is required by ${pipeline}; not running. Inputs are prepared in ${runDir}.`);
          return true;
        }
        continue;
      }
      params[p.name] = value;
      if (p.name === "genome") genomeGiven = true;
    }

    const paramsPath = join(runDir, "params.yaml");
    try {
      writeFileSync(paramsPath, stringifyYaml(params), "utf8");
    } catch (err) {
      this.io.warn("Couldn't write params.yaml: " + (err instanceof Error ? err.message : String(err)));
      return true;
    }
    this.io.info(
      "Note: I'm running this from its schema, not a curated recipe — I ask for required inputs and " +
        "references and leave optional settings at nf-core's defaults. Review params.yaml if you want to tune it.",
    );

    if (!(await this.ensureNextflow(engine))) {
      this.io.warn(`Can't run ${pipeline} — Nextflow or the backend isn't available. Inputs are in ${runDir}.`);
      return true;
    }
    const extraConfigs = session.executorConfigPath ? [session.executorConfigPath] : [];
    const command = buildFollowUpCommand({ pipeline, revision, engine, paramsFile: paramsPath, extraConfigs });
    this.io.say("Command to run:");
    this.io.say("  nextflow " + command.join(" "));
    this.io.info(`Working directory: ${runDir}`);
    const go = await this.io.confirm(`Run ${pipeline} now?`, false, { consequential: true });
    if (!go) {
      this.io.info(`Not running. The command and params.yaml are ready in ${runDir}.`);
      return true;
    }

    this.io.heading(`Running ${pipeline} (live log)`);
    const result = await runNextflow(command, runDir, this.io, session.runEnv);
    if (result.exitCode !== 0) {
      this.io.warn(`${pipeline} exited with an error (code ${result.exitCode}).`);
      if (result.errorSummary) this.io.say(result.errorSummary);
      this.io.info(`Inputs are preserved in ${runDir}; see https://nf-co.re/${short} for its parameters.`);
      return true;
    }
    this.io.say(`${pipeline} completed successfully.`);
    await this.interpretDirectoryRun(session, pipeline, `${description} (on your data)`, outdir);
    this.io.info(`Results: ${outdir}.`);
    await this.offerCuration(top, outdir);
    return true;
  }

  /** Asks for one synthesized parameter: an enum via the menu, else a path/value. */
  private async askSchemaParam(param: SynthParam): Promise<string | number | undefined> {
    if (param.kind === "enum" && param.choices && param.choices.length > 0) {
      const options: ChoiceOption[] = param.choices.map((c) => ({
        label: c,
        value: c,
        recommended: String(param.default) === c,
      }));
      const label = `${param.name}${param.description ? ` — ${param.description}` : ""}`;
      const v = await chooseWith(this.io, label, options, { allowCustom: false });
      return v || undefined;
    }
    const tag = param.required ? "" : param.reference ? " (reference — Enter to skip)" : " (optional — Enter to skip)";
    const prompt =
      `${param.name}${tag}` + (param.description ? `\n  ${param.description}` : "") + `\n  ${param.name}:`;
    const v = await this.askComposedPath(prompt);
    if (!v) return undefined;
    if (param.kind === "number") {
      const n = Number(v);
      return Number.isNaN(n) ? v : n;
    }
    return v;
  }

  /**
   * Prepares a samplesheet for a schema-synthesized run. When the required
   * columns are only sample + FASTQ, Hirsh builds one from a folder (its pair
   * inference) or accepts a CSV; otherwise it asks for a ready CSV and validates
   * it against the real column spec (so it never guesses per-sample biology).
   */
  private async prepareSchemaSamplesheet(
    runDir: string,
    columns: InputColumn[],
  ): Promise<string | null> {
    if (columns.length > 0) {
      const shown = columns.map((c) => `${c.name}${c.required ? "*" : ""}`).join(", ");
      this.io.info(`Samplesheet columns (* required): ${shown}.`);
    }
    if (columns.length === 0 || isSimpleFastqSheet(columns)) {
      const path = await this.resolveComposedInput(runDir);
      return path || null;
    }
    this.io.info(
      "This pipeline needs extra per-sample columns, so I won't guess them — point me at a ready " +
        "samplesheet CSV with those columns.",
    );
    const p = await this.askComposedPath("Path to your samplesheet CSV (@path, or Enter to skip):");
    if (!p) return null;
    if (!existsSync(p)) {
      this.io.warn(`I couldn't find ${p}.`);
      return null;
    }
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch (err) {
      this.io.warn("Couldn't read that file: " + (err instanceof Error ? err.message : String(err)));
      return null;
    }
    const report = validateSamplesheetContent(text, toColumnSpecs(columns));
    for (const w of report.warnings) this.io.warn(w);
    if (!report.ok) {
      this.io.warn("That samplesheet doesn't match the pipeline's columns:");
      for (const e of report.errors) this.io.warn(`  • ${e}`);
      return null;
    }
    this.io.info(`Samplesheet accepted (${report.rowCount} row(s)).`);
    return p;
  }

  /** Interprets an ad-hoc run's output directory (shared by test-profile/on-data runs). */
  private async interpretDirectoryRun(
    session: Session,
    name: string,
    title: string,
    outdir: string,
  ): Promise<void> {
    const interpretable: InterpretablePipeline = {
      name,
      title,
      results: { outputs: [{ path: ".", description: "the pipeline's outputs", kind: "directory" }] },
    };
    const report = gatherResults(interpretable, outdir);
    for (const html of findHtmlReports(outdir)) {
      if (!report.htmlReports.includes(html)) report.htmlReports.push(html);
    }
    if (!report.outputs.some((o) => o.found)) {
      this.io.info(`Results are in ${outdir}.`);
      return;
    }
    this.showCharts(report);
    this.io.say("\nResults summary:\n");
    const summaryText = await summarizeResults(
      this.provider,
      interpretable,
      session.query,
      report,
      (c) => this.io.raw(c),
      [],
    );
    this.io.endStream();
    for (const html of report.htmlReports) this.io.info(`  • ${html}`);
    this.writeResultsReport(name, title, session.query, report, summaryText, dirname(outdir));
  }

  /**
   * Runs an established (not-yet-curated) nf-core pipeline's bundled `test`
   * profile: an honest, self-contained smoke run that proves the pipeline (and
   * the local environment) work and shows its outputs. Reuses the normal
   * backend selection, environment gate and results interpretation.
   */
  private async runEstablishedTestProfile(session: Session, top: NfCorePipeline): Promise<void> {
    const pipeline = top.fullName;
    const revision = top.latestRelease!;
    const description = top.description;
    await this.phaseEnvironment(session);
    const engine = session.engine ?? this.config.execution.containerEngine;

    const short = pipeline.split("/").pop() ?? pipeline;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const runDir = resolve(this.config.execution.workdir, `${short}-test-${ts}`);
    const outdir = join(runDir, "results");
    try {
      mkdirSync(runDir, { recursive: true });
    } catch (err) {
      this.io.warn("Couldn't create a run directory: " + (err instanceof Error ? err.message : String(err)));
      return;
    }

    this.io.info(
      "Heads-up: the test profile uses nf-core's small example data — a check that the pipeline runs " +
        "end-to-end and a preview of its outputs, not results on your data.",
    );
    if (!(await this.ensureNextflow(engine))) {
      this.io.warn(`Can't run ${pipeline} — Nextflow or the backend isn't available.`);
      return;
    }
    const extraConfigs = session.executorConfigPath ? [session.executorConfigPath] : [];
    const command = buildNfCoreTestRunCommand({ pipeline, revision, engine, outdir, extraConfigs });
    this.io.say("Command to run:");
    this.io.say("  nextflow " + command.join(" "));
    this.io.info(`Working directory: ${runDir}`);
    const go = await this.io.confirm(`Run ${pipeline}'s test profile now?`, true, { auto: true });
    if (!go) {
      this.io.info(`Not running. The command is ready above (run dir: ${runDir}).`);
      return;
    }

    this.io.heading(`Running ${pipeline} test profile (live log)`);
    const result = await runNextflow(command, runDir, this.io, session.runEnv);
    if (result.exitCode !== 0) {
      this.io.warn(`${pipeline} exited with an error (code ${result.exitCode}).`);
      if (result.errorSummary) this.io.say(result.errorSummary);
      this.io.info(
        `That's the pipeline's own test profile failing — likely a local environment issue (memory, ` +
          "backend, network). The command above is reusable once resolved.",
      );
      return;
    }
    this.io.say(`${pipeline} test profile completed successfully.`);
    await this.interpretDirectoryRun(session, pipeline, `${description} (test profile)`, outdir);
    this.io.info(`Results: ${outdir}. To run it on your own data, its docs are at https://nf-co.re/${short}.`);
    await this.offerCuration(top, outdir);
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

    if (tag) {
      // fetchngs emitted a samplesheet already shaped for this pipeline.
      if (!this.applyFetchedSamplesheet(session, pipeline, outdir, accessions)) return;
    } else {
      // fetchngs can't format for this pipeline (e.g. sarek's tumor/normal shape).
      // Re-shape: pull the FASTQ pairs from the generic samplesheet and let Phase C
      // build the proper one, asking the pipeline-specific columns.
      const samplesheet = fetchngsSamplesheetPath(outdir);
      let pairs: FastqPair[];
      try {
        pairs = fastqPairsFromSamplesheet(readFileSync(samplesheet, "utf8"));
      } catch {
        pairs = [];
      }
      if (pairs.length === 0) {
        this.io.warn(
          `Downloaded the data but couldn't read the FASTQ list from ${samplesheet}; ` +
            "I'll ask for files during parameterization instead.",
        );
        return;
      }
      session.fetchedPairs = pairs;
      this.io.say(
        `Downloaded ${accessions.length} accession(s) → ${pairs.length} sample(s). I'll build the ` +
          `${pipeline.name} samplesheet from them, asking any extra details it needs.`,
      );
    }
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
    this.io.heading("Phase B · Composing a pipeline from nf-core modules");
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

    // Provenance for novelty: an honest reused-vs-new manifest for the project.
    try {
      const novelty = summarizeNovelty(resolved);
      writeFileSync(join(result.dir, "NOVELTY.md"), renderNoveltyManifest(novelty), "utf8");
      this.io.info(
        `Novelty: ${novelty.reused.length} reused nf-core module(s), ${novelty.custom.length} ` +
          `new custom tool(s) — see ${join(result.dir, "NOVELTY.md")}`,
      );
    } catch {
      /* best-effort */
    }
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

    // Phase 5 — try-before-you-publish: once it's validated to run, offer to run it
    // on the scientist's own data and interpret the results, before any packaging.
    if (stub.ok) {
      await this.offerComposedRun(session, result, resolved);
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

    // Phase 5: packaging/publishing framed as a recommendation, not a gate — when
    // the scientist is happy with the pipeline, Hirsh can help share it.
    this.io.say(
      "\nWhenever you're happy with this pipeline, I can help you polish and share it — " +
        "no rush. Tell me if there's anything you'd change first.",
    );
    await this.phasePackaging(result.dir, resolved, validation.nfCoreCli.available);

    // Phase 5: offer to prepare any custom local tools as nf-core/modules
    // contributions (files + nf-test; the PR stays a human-in-the-loop step).
    await this.offerContribution(resolved, this.config.execution.workdir);

    this.io.say("\nThe pipeline lives at " + result.dir + ".");
    this.io.info(
      "  • Run it again anytime: cd " +
        result.dir +
        " && nextflow run . -profile docker --input samplesheet.csv --outdir results",
    );
    if (result.referenceParams.length > 0) {
      this.io.info("  • Provide the reference parameters above for real data.");
    }
    this.io.info(
      "  • When it's ready, publishing to GitHub / contributing to nf-core is always available — " +
        "just ask, and share any feedback you have on the result.",
    );
  }

  /**
   * Phase 5 — try-before-you-publish. Offers to run a freshly composed pipeline on
   * the scientist's own data (samplesheet + reference params) and interpret the
   * results, reusing the chosen backend/executor. Best-effort: a composed pipeline
   * is a draft, so a failed run is reported and the flow continues to packaging.
   */
  private async offerComposedRun(
    session: Session,
    result: GenerationResult,
    resolved: ResolvedComposition,
  ): Promise<void> {
    // A composed project always carries a `test` profile — offer it as a smoke
    // test, since a scientist will usually want to try it before wiring real data.
    const hasTest = existsSync(join(result.dir, "conf", "test.config"));
    const choices: ChoiceOption[] = [
      { value: "data", label: "Run it on my own data", recommended: true },
    ];
    if (hasTest) {
      choices.push({
        value: "test",
        label: "Run the test profile first",
        description: "placeholder data — a quick smoke test that it executes, not real results",
      });
    }
    choices.push({ value: "no", label: "Not now" });

    const pick = await chooseWith(this.io, "Try this pipeline now?", choices, { allowCustom: false });
    if (pick === "no") {
      this.io.info("Okay — you can run it later; I'll show the exact command at the end.");
      return;
    }

    // Backend selection applies to any run; the executor only to a real data run.
    await this.phaseEnvironment(session);
    const engine = session.engine ?? this.config.execution.containerEngine;
    if (pick === "test" || (pick !== "data" && wantsTestProfile(pick))) {
      await this.runComposedTestProfile(session, result, resolved, engine);
      return;
    }

    await this.phaseExecutor(session, result.dir);
    const input = await this.resolveComposedInput(result.dir);

    // Without an input, a composed pipeline that reads a samplesheet will fail —
    // don't launch a doomed run; offer the test profile instead.
    if (!input) {
      this.io.warn("This pipeline expects an input samplesheet — without one the run will fail.");
      const alt = await chooseWith(
        this.io,
        "What would you like to do?",
        [
          ...(hasTest
            ? [{ value: "test", label: "Run the test profile instead", recommended: true, description: "placeholder data — a smoke test" }]
            : []),
          { value: "anyway", label: "Try the real run anyway" },
          { value: "no", label: "Cancel" },
        ],
        { allowCustom: false },
      );
      if (alt === "no") {
        this.io.info("Okay — not running. The command is shown at the end.");
        return;
      }
      if (alt === "test") {
        await this.runComposedTestProfile(session, result, resolved, engine);
        return;
      }
      // "anyway" → fall through to the real run.
    }

    const refParams: ComposedRunParam[] = [];
    if (result.referenceParams.length > 0) {
      this.io.info(
        "These are inputs the pipeline needs (references/indexes). Give a value for the ones you " +
          "have; press Enter to skip any you don't.",
      );
      for (const name of result.referenceParams) {
        const value = await this.askComposedPath(`  --${name} (path/value, @ to reference, Enter to skip):`);
        if (value) refParams.push({ name, value });
      }
    }

    const command = buildComposedRunCommand({
      dir: result.dir,
      engine,
      input: input || undefined,
      outdir: join(result.dir, "results"),
      refParams,
      extraConfigs: session.executorConfigPath ? [session.executorConfigPath] : [],
    });
    await this.executeComposed(session, resolved, {
      command,
      engine,
      dir: result.dir,
      outdir: join(result.dir, "results"),
    });
  }

  /** Runs the composed pipeline's `test` profile (placeholder data — a smoke test). */
  private async runComposedTestProfile(
    session: Session,
    result: GenerationResult,
    resolved: ResolvedComposition,
    engine: ContainerEngine,
  ): Promise<void> {
    this.io.info(
      "Heads-up: a composed pipeline's test profile uses placeholder data — a quick check that it " +
        "executes end-to-end, not real biological results (real test data is a later step).",
    );
    const outdir = join(result.dir, "results_test");
    const command = buildComposedRunCommand({ dir: result.dir, engine, outdir, refParams: [], test: true });
    await this.executeComposed(session, resolved, { command, engine, dir: result.dir, outdir });
  }

  /** Shared: env-check, show command, confirm, run, and interpret a composed run. */
  private async executeComposed(
    session: Session,
    resolved: ResolvedComposition,
    opts: { command: string[]; engine: ContainerEngine; dir: string; outdir: string },
  ): Promise<void> {
    if (!(await this.ensureNextflow(opts.engine))) {
      this.io.warn("Can't run — Nextflow or the backend isn't available. The command is shown at the end.");
      return;
    }
    this.io.say("Command to run:");
    this.io.say("  nextflow " + opts.command.join(" "));
    const run = await this.io.confirm("Run it now?", true, { auto: true });
    if (!run) {
      this.io.info("Not running. The command is ready above.");
      return;
    }
    this.io.heading(`Running ${resolved.plan.pipelineName} (live log)`);
    const res = await runNextflow(opts.command, opts.dir, this.io, session.runEnv);
    if (res.exitCode !== 0) {
      this.io.warn(
        `The run exited with an error (code ${res.exitCode}). Composed pipelines are drafts — this may ` +
          "need a wiring or parameter fix.",
      );
      if (res.errorSummary) this.io.say(res.errorSummary);
      return;
    }
    this.io.say("Run completed successfully.");
    await this.interpretComposedRun(session, resolved, opts.outdir);
  }

  /**
   * Resolves the composed pipeline's `--input`: accepts a ready samplesheet CSV,
   * or a sequence **file/folder** the scientist points at — in which case Hirsh
   * builds the samplesheet (columns sample,fastq_1,fastq_2) for them, so they
   * don't hand-write a CSV. Returns "" to skip. `@` paths supported.
   */
  private async resolveComposedInput(runDir: string): Promise<string> {
    const raw = (
      await this.io.ask(
        "Your input — a samplesheet CSV, or a sequence file/folder I'll build one from " +
          "(reference with @, or Enter to skip):",
      )
    ).trim();
    const ans = classifyPathAnswer(raw);
    if (ans.kind !== "path") return ""; // empty or non-path → skip
    const p = resolve(ans.path);
    if (!existsSync(p)) {
      this.io.warn(`I couldn't find ${p}; skipping the input.`);
      return "";
    }
    if (/\.csv$/i.test(p)) return p; // already a samplesheet

    const rows = await this.composedRowsFromPath(p);
    if (rows.length === 0) {
      this.io.warn("I couldn't find sequence files there; skipping the input.");
      return "";
    }
    const header = ["sample", "fastq_1", "fastq_2"];
    const path = join(runDir, "samplesheet.csv");
    try {
      writeCsv(path, header, rows as unknown as Array<Record<string, string>>);
    } catch (err) {
      this.io.warn("Couldn't write the samplesheet: " + (err instanceof Error ? err.message : String(err)));
      return "";
    }
    this.io.say("Built a samplesheet from your files:");
    this.io.say(previewCsv(header, rows as unknown as Array<Record<string, string>>));
    this.io.info(
      "Note: a composed pipeline reads inputs generically — your file(s) are wired into its input " +
        "channel; review the results with that in mind.",
    );
    this.io.info(`Samplesheet written to ${path}`);
    return path;
  }

  /** Builds samplesheet rows from a sequence file or a folder of them. */
  private async composedRowsFromPath(p: string): Promise<ComposedSheetRow[]> {
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      return [];
    }
    if (!isDir) return composedRowsFromFiles([p]);

    // A folder: prefer FASTQ pair inference; else recognize sequences by content.
    const scan = scanFastqs(p);
    if (scan.files.length > 0) {
      return inferPairs(scan).map((pair) => ({
        sample: pair.sample,
        fastq_1: pair.fastq_1,
        fastq_2: pair.fastq_2 ?? "",
      }));
    }
    const sniffed = await scanSequenceDir(p);
    return composedRowsFromFiles(sniffed.sequences.map((s) => s.file));
  }

  /** Asks for a path/value with `@` reference support; empty means skip. */
  private async askComposedPath(prompt: string): Promise<string> {
    const raw = (await this.io.ask(prompt)).trim();
    const ans = classifyPathAnswer(raw);
    if (ans.kind === "path") return resolve(ans.path);
    if (ans.kind === "text") return ans.text; // a non-path value (e.g. an iGenomes key)
    return "";
  }

  /** Ensures Nextflow + backend are usable (offers bootstrap); returns false if not. */
  private async ensureNextflow(engine: ContainerEngine): Promise<boolean> {
    let env = await checkEnvironment(engine);
    if (!env.nextflow.available) {
      const boot = await bootstrapNextflow(this.io);
      this.io.info(boot.message);
      if (boot.installed) env = await checkEnvironment(engine);
    }
    return env.canExecute;
  }

  /** Light biological interpretation of a composed pipeline's real-run outputs. */
  private async interpretComposedRun(
    session: Session,
    resolved: ResolvedComposition,
    outdir: string,
  ): Promise<void> {
    const interpretable: InterpretablePipeline = {
      name: resolved.plan.pipelineName,
      title: resolved.plan.description,
      results: { outputs: [{ path: ".", description: "the pipeline's outputs", kind: "directory" }] },
    };
    const report = gatherResults(interpretable, outdir);
    for (const html of findHtmlReports(outdir)) {
      if (!report.htmlReports.includes(html)) report.htmlReports.push(html);
    }
    if (!report.outputs.some((o) => o.found)) {
      this.io.info(`Results are in ${outdir}.`);
      return;
    }
    this.showCharts(report);
    this.io.say("\nResults summary:\n");
    const summaryText = await summarizeResults(
      this.provider,
      interpretable,
      session.query,
      report,
      (c) => this.io.raw(c),
      [],
    );
    this.io.endStream();
    if (report.htmlReports.length > 0) {
      this.io.info("HTML reports (open them in your browser):");
      for (const html of report.htmlReports) this.io.info(`  • ${html}`);
    }
    this.writeResultsReport(
      resolved.plan.pipelineName,
      resolved.plan.description,
      session.query,
      report,
      summaryText,
      dirname(outdir),
    );
  }

  /**
   * Writes a self-contained REPORT.html (interpretation + SVG figures + links)
   * into the run directory and points the user at it. Best-effort — a report must
   * never block or fail a run. Links methods/provenance/params when they exist.
   */
  private writeResultsReport(
    name: string,
    title: string,
    query: QueryContext,
    report: ResultsReport,
    summaryText: string,
    runDir: string,
  ): void {
    if (!summaryText.trim()) return;
    try {
      const artifacts: ReportArtifact[] = [];
      for (const [label, rel] of [
        ["Methods", "METHODS.md"],
        ["Provenance", "PROVENANCE.md"],
        ["Parameters", "params.yaml"],
      ] as const) {
        const p = join(runDir, rel);
        if (existsSync(p)) artifacts.push({ label, path: p });
      }
      const html = renderResultsReportHtml({
        pipelineName: name,
        pipelineTitle: title,
        query,
        outdir: report.outdir,
        outputs: report.outputs.map((o) => ({
          path: o.output.path,
          description: o.output.description,
          found: o.found,
          detail: o.detail,
        })),
        charts: [...(report.charts ?? []), ...(report.metricCharts ?? [])],
        volcanoFigures: report.volcanoFigures,
        summaryText,
        htmlReports: report.htmlReports,
        artifacts,
        tools: readSoftwareVersions(report.outdir, name),
        generatedOn: new Date().toISOString().slice(0, 10),
      });
      const file = join(runDir, "REPORT.html");
      writeFileSync(file, html, "utf8");
      this.io.info(`Shareable report: ${file}`);
    } catch {
      /* never block on the report */
    }
  }

  /**
   * Surfaces the real peak memory a completed run used, read from the Nextflow
   * execution trace — so the scientist knows how to size future runs. Best-effort.
   */
  private reportPeakMemory(outdir: string): void {
    const res = this.readPeakMemory(outdir);
    if (res?.maxPeakRssGB && res.processes.length > 0) {
      this.io.info(
        `Peak memory observed: ${res.maxPeakRssGB.toFixed(1)} GB (${res.processes[0].name}) — ` +
          "useful for sizing future runs.",
      );
    }
  }

  /** Reads real per-process peak memory from a run's Nextflow trace. Best-effort. */
  private readPeakMemory(outdir: string): ReturnType<typeof parseTraceResources> | null {
    const dir = join(outdir, "pipeline_info");
    try {
      const files = readdirSync(dir)
        .filter((f) => /execution_trace.*\.txt$/i.test(f))
        .sort();
      if (files.length === 0) return null;
      return parseTraceResources(readFileSync(join(dir, files[files.length - 1]), "utf8"));
    } catch {
      return null;
    }
  }

  /** Renders any small inline bar charts of the run's key numbers to the terminal. */
  private showCharts(report: ResultsReport): void {
    for (const chart of report.charts ?? []) {
      if (chart.items.length === 0) continue;
      this.io.say("\n" + chart.title + ":");
      for (const line of renderBarChart(chart.items)) this.io.info("  " + line);
    }
  }

  /**
   * Phase 4 — optionally add custom (non-nf-core) tools as local modules. Each is
   * synthesized as a standards-compliant modules/local/<name> and appended to the
   * composition so it wires in like any nf-core module.
   */
  private async addLocalTools(resolved: ResolvedComposition): Promise<void> {
    this.io.info(
      "You can also add one of your own tools or scripts as a pipeline step (e.g. a Python " +
        "script). I'll wrap it into the pipeline for you — skip this if the steps above are enough.",
    );
    let add = await this.io.confirm("Add one of your own tools/scripts as a step?", false);
    while (add) {
      const spec = await collectLocalTool(this.io);
      if (spec) this.addLocalToolToPlan(resolved, spec);
      add = await this.io.confirm("Add another of your own tools?", false);
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

    // Iterate lint → auto-fix → lint until green or the failures stop improving.
    if (nfCoreAvailable) await this.iterateLintFixes(dir, spec);

    await this.offerPublish(dir, resolved);
    await this.offerInclusionGuide(dir, resolved.plan.pipelineName);
  }

  /**
   * Phase 5 — the local quality gate iterating toward green. Runs `nf-core lint`,
   * applies the fixes Hirsh can make (re-package missing files/manifest, strip
   * template TODOs), and re-lints — up to a few rounds — stopping when the project
   * is lint-clean or the failure count stops improving. Honest: remaining failures
   * (e.g. `files_unchanged`, schema specifics) need the full template or manual work.
   */
  private async iterateLintFixes(dir: string, spec: PackageSpec): Promise<void> {
    const MAX_ROUNDS = 3;
    let previousFailed = Number.POSITIVE_INFINITY;
    const trajectory: number[] = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const lint = await this.io.withSpinner(
        round === 0 ? "Running nf-core lint" : "Re-running nf-core lint after fixes",
        () => lintPipeline(dir),
      );
      if (!lint.ran || lint.failed == null) {
        this.io.warn("Couldn't run nf-core lint: " + (lint.error ?? "unknown error"));
        return;
      }
      trajectory.push(lint.failed);
      this.io.info(
        `nf-core lint: ${lint.passed ?? 0} passed, ${lint.warned ?? 0} warnings, ${lint.failed} failed.`,
      );
      if (lint.failed === 0) {
        this.io.say("✓ The project is lint-clean.");
        break;
      }

      const plan = planLintFixes(lint.findings);
      if (!shouldContinueFixing(lint, previousFailed, plan)) {
        for (const f of lint.findings.slice(0, 6)) this.io.info("  ✗ " + f);
        this.io.info(
          "I've applied every fix I can. The remaining failures need the full nf-core template " +
            "or manual edits (e.g. files_unchanged, schema specifics) before a green lint.",
        );
        break;
      }
      this.io.info(`Applying automatic fixes${plan.stripTodos ? " (incl. removing template TODOs)" : ""}…`);
      this.applyLintFixes(dir, spec, plan);
      previousFailed = lint.failed;
    }
    if (trajectory.length > 1) this.io.info(`Lint failures across rounds: ${trajectory.join(" → ")}.`);
  }

  /** Applies a lint fix plan: re-package (idempotent) and/or strip template TODOs. */
  private applyLintFixes(dir: string, spec: PackageSpec, plan: ReturnType<typeof planLintFixes>): void {
    if (plan.repackage) packagePipeline(dir, spec);
    if (plan.stripTodos) {
      for (const rel of listRelativeFiles(dir)) {
        // Only Hirsh-owned files — never rewrite pinned nf-core modules.
        if (!/\.(nf|config)$/.test(rel)) continue;
        if (rel.includes("modules/nf-core/") || rel.includes("subworkflows/nf-core/")) continue;
        const full = join(dir, rel);
        try {
          const { text, removed } = stripNfCoreTodos(readFileSync(full, "utf8"));
          if (removed > 0) writeFileSync(full, text, "utf8");
        } catch {
          /* skip unreadable files */
        }
      }
    }
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
    // Per-project by default: <workspace>/.hirsh/memory.json (the CLI chdirs into
    // the workspace), so each project keeps its own history. An explicit
    // config.memory.path still wins (e.g. a shared/global store).
    return this.config.memory.path ?? defaultMemoryPath(process.cwd());
  }

  private mem(): MemoryData {
    if (this.memory) return this.memory;
    this.memory = this.config.memory.enabled ? loadMemory(this.memoryPath()) : emptyMemory();
    return this.memory;
  }

  /** Memory is usable only if enabled in config AND the user hasn't declined it. */
  private memoryEnabled(): boolean {
    return this.config.memory.enabled && this.mem().consent !== false;
  }

  /**
   * First-run consent for project memory: asks once, then remembers the answer so
   * it's never asked again. Declining stores consent=false so nothing is recorded.
   * Honest about privacy — the store is local and never uploaded.
   */
  private async ensureMemoryConsent(): Promise<void> {
    if (this.consentChecked) return;
    this.consentChecked = true;
    if (!this.config.memory.enabled) return;
    const data = this.mem();
    if (data.consent !== undefined) return; // already decided in a past session

    const ok = await this.io.confirm(
      `Can I remember your analyses across sessions? They're kept in a local, private file ` +
        `(${this.memoryPath()}) — never uploaded — so I can pick up where you left off.`,
      true,
    );
    this.memory = { ...data, consent: ok };
    try {
      saveMemory(this.memoryPath(), this.memory);
    } catch {
      /* best-effort */
    }
    if (!ok) {
      this.io.info("Okay — I won't keep a project memory. Enable it later with memory.enabled in config.");
    }
  }

  /** Shows relevant past analyses from project memory (opt-out via config/consent). */
  private surfacePastRuns(query: QueryContext): void {
    if (!this.memoryEnabled()) return;
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
    if (!this.memoryEnabled()) return { references: {}, samplesheets: [] };
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
    if (!this.memoryEnabled()) return {};
    const pref = preferredEnvironment(this.mem());
    return {
      engine: pref.engine && pref.engine in BACKENDS ? pref.engine : undefined,
      executor: pref.executor && pref.executor in EXECUTORS ? pref.executor : undefined,
      queue: pref.queue,
    };
  }

  /** Records a run into project memory (best-effort; never blocks). */
  private recordRun(session: Session, executed: boolean, exitCode?: number): void {
    if (!this.memoryEnabled()) return;
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
        peakMemoryGB:
          executed && session.outdir
            ? (this.readPeakMemory(session.outdir)?.maxPeakRssGB ?? undefined)
            : undefined,
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

    // Reality check from memory: a past run of this pipeline's real peak memory.
    const observedPeak = this.memoryEnabled() ? lastPeakMemoryFor(this.mem(), pipeline.name) : null;
    if (observedPeak) {
      this.io.info(
        `From your project memory: a past ${pipeline.name} run actually peaked at ` +
          `${observedPeak.toFixed(1)} GB — a real-usage check on the estimate below.`,
      );
    }

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
        `From your project memory: the last run in this project used ${BACKENDS[remembered].label}; ` +
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
        `From your project memory: the last run in this project used ${EXECUTORS[remembered].label}` +
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
   * Phase 6 — persist the env choice. When the chosen backend/executor differs
   * from config, offer (once per session) to save it as the default, editing the
   * config file in place with comments preserved. Opt-in (default no).
   */
  private async offerPersistEnv(session: Session): Promise<void> {
    if (this.envPersistDone) return;
    const engine = session.engine;
    const executor = session.executor?.executor ?? "local";
    const queue = session.executor?.queue;
    const cfg = this.config.execution;
    const engineDiff = !!engine && engine !== cfg.containerEngine;
    const execDiff = executor !== (cfg.executor ?? "local") || (queue ?? "") !== (cfg.queue ?? "");
    if (!engineDiff && !execDiff) return;

    const target = this.configPath ?? join(homedir(), ".bioagent", "config.yaml");
    const save = await this.io.confirm(
      `Save this as your default (${engine ?? cfg.containerEngine} · ${describeExecutor(session.executor ?? { executor: "local" })}) in ${target}?`,
      false,
    );
    this.envPersistDone = true; // ask at most once per session
    if (!save) return;

    const updates: ExecutionUpdates = {};
    if (engine) updates.containerEngine = engine;
    updates.executor = executor;
    if (queue) updates.queue = queue;
    try {
      persistExecutionChoice(target, updates);
      // Reflect in the in-memory config so it isn't re-offered next conversation.
      if (engine) cfg.containerEngine = engine;
      cfg.executor = executor;
      if (queue) cfg.queue = queue;
      this.io.info(`Saved as your default in ${target}.`);
    } catch (err) {
      this.io.warn("Couldn't write the config: " + (err instanceof Error ? err.message : String(err)));
    }
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
    await this.offerPersistEnv(session);

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
    allowFix = true,
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
      // Self-correction: if it's an invalid-parameter validation error, offer to
      // fix the offending value(s) and run again (once) instead of failing blindly.
      if (allowFix) {
        const fixed = await this.tryFixInvalidParams(session, runDir, env, result.errorSummary ?? "");
        if (fixed !== null) return fixed;
      }
      return false;
    }
    this.io.say("Run completed successfully.");
    return true;
  }

  /**
   * Reads an nf-core parameter-validation failure and offers to correct the
   * invalid value(s) to an allowed one, then re-runs once. Returns the re-run's
   * outcome, or null when there's nothing recognizable to fix / the user declines.
   */
  private async tryFixInvalidParams(
    session: Session,
    runDir: string,
    env: EnvReport,
    errorText: string,
  ): Promise<boolean | null> {
    const pipeline = session.selectedPipeline;
    if (!pipeline) return null;
    const invalid = parseInvalidParams(errorText);
    if (invalid.length === 0) return null;

    this.io.warn("It failed because some parameters had invalid values:");
    for (const p of invalid) {
      this.io.info(`  • --${p.param} = "${p.value}" isn't allowed — valid: ${p.allowed.join(", ")}`);
    }
    const fix = await this.io.confirm("Let me fix these to a valid value and run again?", true);
    if (!fix) return null;

    for (const p of invalid) {
      const chosen = await chooseWith(
        this.io,
        `Value for --${p.param}:`,
        p.allowed.map((v) => ({ value: v, label: v, recommended: v === p.allowed[0] })),
        { allowCustom: false },
      );
      session.paramValues[p.param] = chosen;
      if (p.param === pipeline.results.outdirParam) session.outdir = String(chosen);
      this.io.info(`Set --${p.param} = ${chosen}.`);
    }
    finalizeCommand(session, pipeline, this.config);
    // Re-run once (no further auto-fix, so a persistent error can't loop).
    return this.executeAndReport(session, runDir, env, false, false);
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
        // Container images Nextflow resolved (from its execution trace), for
        // byte-exact reproducibility. Empty for prepared/conda runs.
        containers: executed && session.outdir ? readRunContainers(session.outdir) : undefined,
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

    this.showCharts(report);
    this.io.say("Results summary:\n");
    const summaryText = await summarizeResults(
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

    this.reportPeakMemory(outdir);

    this.writeResultsReport(
      pipeline.name,
      pipeline.title,
      session.query,
      report,
      summaryText,
      session.runDir ?? dirname(report.outdir),
    );

    if (pipeline.followUp) {
      this.io.say(
        `\nNext analysis step: when ${pipeline.followUp.when}, run ${pipeline.followUp.pipeline}. ` +
          pipeline.followUp.note,
      );
      await this.phaseFollowUp(session, pipeline);
    }

    await this.offerMethods(session, pipeline);
  }

  /**
   * Phase 2 — follow-up chaining. When the pipeline declares a *runnable*
   * follow-up (e.g. rnaseq → differentialabundance), offers to launch it directly
   * on the results just produced: it wires the upstream outputs into the
   * follow-up's inputs, carries over shared params (e.g. gtf), asks for the few
   * extra inputs the follow-up needs (a condition table, contrasts), and runs it
   * through the usual confirmed-execution path. Reuses the chosen backend/executor.
   * Always confirmed; never a silent auto-chain.
   */
  /**
   * Collects the follow-up's scientist-provided inputs. Reviews a condition
   * samplesheet (per-group replicates, missing control) as it's given, and — for
   * the contrasts input — offers to build them from that samplesheet rather than
   * asking for a hand-written CSV. Returns false to abort (a required input was
   * left blank).
   */
  private async collectFollowUpInputs(
    fu: NonNullable<PipelineDefinition["followUp"]>,
    params: Record<string, string | number | boolean>,
    runDir: string,
  ): Promise<boolean> {
    let conditionSheet: string | undefined;
    for (const req of fu.requiredInputs ?? []) {
      if (params[req.name] !== undefined) continue;

      // Build the contrasts from the condition samplesheet if we have one.
      if (req.name === "contrasts" && conditionSheet) {
        const generated = await this.offerGeneratedContrasts(conditionSheet, runDir);
        if (generated) {
          params.contrasts = generated;
          continue;
        }
      }

      const ans = (
        await this.io.ask(`${req.description}${req.optional ? " (optional — blank to skip)" : ""}\n  ${req.name}:`)
      ).trim();
      if (ans) {
        const p = resolve(ans);
        params[req.name] = p;
        if ((req.name === "input" || /sample|condition/i.test(req.name)) && /\.csv$/i.test(p) && existsSync(p)) {
          conditionSheet = p;
          this.reviewConditionSheet(p);
        }
      } else if (!req.optional) {
        this.io.warn(`${req.name} is required for ${fu.pipeline}; not running the follow-up.`);
        return false;
      }
    }
    return true;
  }

  /** Reviews a follow-up condition samplesheet (per-group replicates, controls). */
  private reviewConditionSheet(path: string): void {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    const design = reviewSamplesheetContent(text);
    if (design.observations.length === 0) return;
    if (worstSeverity({ observations: design.observations, summary: "" }) === "info") {
      for (const o of design.observations) this.io.info(o.message);
    } else {
      this.io.heading("Condition samplesheet design check");
      this.presentObservations(design.observations);
    }
  }

  /**
   * Offers to build the differential-expression contrasts from the condition
   * samplesheet's grouping column. Returns the written contrasts.csv path, or null
   * if it couldn't propose any or the scientist declined (they can supply their own).
   */
  private async offerGeneratedContrasts(conditionSheet: string, runDir: string): Promise<string | null> {
    let text: string;
    try {
      text = readFileSync(conditionSheet, "utf8");
    } catch {
      return null;
    }
    const proposed = proposeContrastsFromSheet(text);
    if (!proposed) return null;

    this.io.say(`I can build the contrasts from your "${proposed.variable}" column:`);
    for (const c of proposed.contrasts) this.io.info(`  • ${c.target} vs ${c.reference}`);
    if (proposed.blocking) {
      this.io.info(`  (blocking on "${proposed.blocking}" — a batch that crosses your conditions, so it's modelled out.)`);
    }
    if (proposed.assumedReference) {
      this.io.warn(
        `No control group was recognizable, so I used "${proposed.contrasts[0].reference}" as the reference — ` +
          "provide your own contrasts if that's not the intended comparison.",
      );
    }
    const ok = await this.io.confirm("Use these contrasts?", true, { auto: true });
    if (!ok) return null;

    const path = join(runDir, "contrasts.csv");
    try {
      writeFileSync(path, contrastsCsv(proposed.contrasts), "utf8");
    } catch (err) {
      this.io.warn("Couldn't write contrasts.csv: " + (err instanceof Error ? err.message : String(err)));
      return null;
    }
    this.io.info(`Wrote ${proposed.contrasts.length} contrast(s) to ${path}`);
    return path;
  }

  private async phaseFollowUp(session: Session, pipeline: PipelineDefinition): Promise<void> {
    const fu = pipeline.followUp;
    if (!isRunnableFollowUp(fu)) return; // suggestion-only follow-up: nothing to run
    if (!session.outdir) return;

    const offer = await this.io.confirm(
      `Run the follow-up ${fu.pipeline} now, using these results as its input?`,
      false,
      { auto: true },
    );
    if (!offer) {
      this.io.info(`Okay — you can run ${fu.pipeline} later on ${session.outdir}.`);
      return;
    }

    const shortFu = fu.pipeline.split("/").pop() ?? fu.pipeline;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const runDir = resolve(this.config.execution.workdir, `${shortFu}-${ts}`);
    const outdir = join(runDir, "results");
    try {
      mkdirSync(runDir, { recursive: true });
    } catch (err) {
      this.io.warn("Couldn't create a run directory: " + (err instanceof Error ? err.message : String(err)));
      return;
    }

    const params: Record<string, string | number | boolean> = { outdir };

    // Inputs sourced from the upstream run's outputs (e.g. the count matrix).
    const upstream = upstreamInputPaths(fu, session.outdir);
    for (const [param, path] of Object.entries(upstream)) {
      if (existsSync(path)) {
        params[param] = path;
        this.io.info(`Using ${param} from the upstream run: ${path}`);
      } else {
        this.io.warn(`Expected upstream output not found: ${path}`);
        const manual = (await this.io.ask(`Path for ${param} (or blank to skip):`)).trim();
        if (manual) params[param] = resolve(manual);
      }
    }

    // Params carried over from this run when they were set (e.g. gtf annotation).
    for (const p of fu.carryParams ?? []) {
      const v = session.paramValues[p];
      if (v !== undefined && v !== "") {
        params[p] = v;
        this.io.info(`Carried ${p} from the upstream run.`);
      }
    }

    // Extra inputs only the scientist can provide (condition table, contrasts).
    // Reviews a provided condition samplesheet and offers to build the contrasts
    // from it, instead of demanding a hand-written contrasts CSV.
    if (!(await this.collectFollowUpInputs(fu, params, runDir))) return;

    // Light resource pre-flight (differentialabundance is modest — a whole-run
    // memory check, not the heavy per-process model). Skipped on a cluster/cloud
    // executor, where the scheduler sizes each job.
    if (!(await this.followUpResourceCheck(session, fu))) {
      this.io.info(`Not running. The inputs are prepared in ${runDir}.`);
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
      this.io.warn(`Can't run ${fu.pipeline} — required software is missing. Inputs are prepared in ${runDir}.`);
      return;
    }

    const paramsPath = join(runDir, "params.yaml");
    try {
      writeFileSync(paramsPath, stringifyYaml(params), "utf8");
    } catch (err) {
      this.io.warn("Couldn't write params.yaml: " + (err instanceof Error ? err.message : String(err)));
      return;
    }
    const extraConfigs = session.executorConfigPath ? [session.executorConfigPath] : [];
    const command = buildFollowUpCommand({
      pipeline: fu.pipeline,
      revision: fu.revision!,
      engine,
      paramsFile: paramsPath,
      extraConfigs,
    });

    this.io.say("Command to run:");
    this.io.say("  nextflow " + command.join(" "));
    this.io.info(`Working directory: ${runDir}`);
    const go = await this.io.confirm(`Run ${fu.pipeline} now?`, false, { auto: true });
    if (!go) {
      this.io.info(`Not running. The command and inputs are ready in ${runDir}.`);
      return;
    }

    this.io.heading(`Running ${fu.pipeline} (live log)`);
    const result = await runNextflow(command, runDir, this.io, session.runEnv);
    if (result.exitCode !== 0) {
      this.io.warn(`${fu.pipeline} exited with an error (code ${result.exitCode}).`);
      if (result.errorSummary) this.io.say(result.errorSummary);
      this.recordFollowUpRun(session, fu, outdir, true, result.exitCode);
      return;
    }
    this.io.say(`${fu.pipeline} completed successfully.`);
    await this.interpretFollowUp(session, fu, outdir);
    this.recordFollowUpRun(session, fu, outdir, true, result.exitCode);

    // Publication-ready methods for the follow-up too (its own versions/citation).
    await this.generateMethods({
      label: fu.pipeline,
      outdir,
      runDir,
      pipelineName: fu.pipeline,
      revision: fu.revision!,
      citation: fu.citation,
      nextflowVersion: env.nextflow.version,
      engine,
      query: session.query,
    });

    this.io.info(`Results: ${outdir}`);
  }

  /**
   * Light resource pre-flight for a follow-up run: on a local executor, checks the
   * follow-up's declared memory guidance against the budget and, if it doesn't
   * fit, warns honestly and asks whether to proceed. Not the full per-process
   * negotiation of the primary run — differentialabundance is modest. Returns true
   * to proceed.
   */
  private async followUpResourceCheck(
    session: Session,
    fu: NonNullable<PipelineDefinition["followUp"]>,
  ): Promise<boolean> {
    if (session.executor && session.executor.executor !== "local") return true;
    if (!fu.resources) return true;
    const assessment = assessResources(fu.resources, this.availableBudget());
    if (assessment.verdict === "ok") {
      this.io.info(assessment.message);
      return true;
    }
    this.io.warn(assessment.message);
    return this.io.confirm(`Run ${fu.pipeline} anyway?`, assessment.verdict === "adapt", {
      consequential: true,
    });
  }

  /** Records a follow-up run into project memory (best-effort; never blocks). */
  private recordFollowUpRun(
    session: Session,
    fu: NonNullable<PipelineDefinition["followUp"]>,
    outdir: string,
    executed: boolean,
    exitCode?: number,
  ): void {
    if (!this.memoryEnabled()) return;
    try {
      const record: RunRecord = {
        date: new Date().toISOString(),
        pipeline: fu.pipeline,
        revision: fu.revision,
        organism: session.query.organism,
        dataType: session.query.dataType,
        objective: session.query.objective,
        experimentalDesign: session.query.experimentalDesign,
        outdir,
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

  /**
   * Interprets a follow-up's results like a primary run: gathers its declared
   * outputs (e.g. per-contrast DE tables → significant-gene counts) and asks the
   * LLM for a biological summary in the context of the objective, revisiting the
   * same pre-run design caveats. Degrades to a plain pointer if it has no declared
   * outputs or none were produced.
   */
  private async interpretFollowUp(
    session: Session,
    fu: NonNullable<PipelineDefinition["followUp"]>,
    outdir: string,
  ): Promise<void> {
    const outputs = fu.outputs ?? [];
    if (outputs.length === 0) return;

    const interpretable = {
      name: fu.pipeline,
      title: fu.title ?? "follow-up analysis",
      results: { outputs },
    };
    const report = gatherResults(interpretable, outdir);
    // Surface the follow-up's own HTML report(s) too.
    for (const html of findHtmlReports(outdir)) {
      if (!report.htmlReports.includes(html)) report.htmlReports.push(html);
    }
    if (!report.outputs.some((o) => o.found)) {
      this.io.info(`Its outputs weren't where I expected under ${outdir}; open the folder to review them.`);
      return;
    }

    const designNotes = (session.designReview?.observations ?? [])
      .filter((o) => o.severity !== "info")
      .map((o) => `[${o.topic}] ${o.message}`);

    this.showCharts(report);
    this.io.say("\nFollow-up results summary:\n");
    const summaryText = await summarizeResults(
      this.provider,
      interpretable,
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
    this.writeResultsReport(
      interpretable.name,
      interpretable.title,
      session.query,
      report,
      summaryText,
      dirname(outdir),
    );
  }

  /**
   * Phase 6 — publication-ready methods for the primary run. Reads the real tool
   * versions and the Nextflow/engine recorded in the manifest, then delegates to
   * the shared generator.
   */
  private async offerMethods(session: Session, pipeline: PipelineDefinition): Promise<void> {
    if (!session.outdir) return;
    let nextflowVersion: string | undefined;
    let engine: string = session.engine ?? this.config.execution.containerEngine;
    try {
      const manifest = JSON.parse(readFileSync(join(session.runDir ?? "", "run_manifest.json"), "utf8"));
      nextflowVersion = manifest?.environment?.nextflow;
      if (manifest?.environment?.containerEngine) engine = manifest.environment.containerEngine;
    } catch {
      /* manifest optional */
    }
    await this.generateMethods({
      label: pipeline.name,
      outdir: session.outdir,
      runDir: session.runDir ?? session.outdir,
      pipelineName: pipeline.name,
      revision: pipeline.version,
      citation: pipeline.citation,
      nextflowVersion,
      engine,
      query: session.query,
    });
  }

  /**
   * Shared methods generator (Phase 6): builds a paste-ready methods paragraph +
   * references from the pinned versions, the container engine and the real tool
   * versions nf-core recorded, and writes METHODS.md. Used for both the primary
   * run and a chained follow-up.
   */
  private async generateMethods(opts: {
    label: string;
    outdir: string;
    runDir: string;
    pipelineName: string;
    revision: string;
    citation?: PipelineCitation;
    nextflowVersion?: string;
    engine: string;
    query: QueryContext;
  }): Promise<void> {
    const make = await this.io.confirm(
      `Generate a publication-ready methods paragraph (METHODS.md) for ${opts.label}?`,
      true,
    );
    if (!make) return;

    const tools = readSoftwareVersions(opts.outdir, opts.pipelineName);
    const { paragraph, markdown } = buildMethods({
      pipelineName: opts.pipelineName,
      revision: opts.revision,
      nextflowVersion: opts.nextflowVersion,
      containerEngine: opts.engine,
      organism: opts.query.organism,
      dataType: opts.query.dataType,
      tools,
      pipelineCitation: opts.citation,
    });

    const path = join(opts.runDir, "METHODS.md");
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
