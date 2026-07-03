/**
 * Phase C — iterative parameterization.
 *
 * Walks the parameters of the chosen pipeline:
 *  - Offers the "test profile" first (auto-provides input and references) as a
 *    fast way to validate without real data.
 *  - Asks for required params; for optional ones proposes the default and asks
 *    for confirmation.
 *  - Builds the samplesheet, helping infer samples/pairs from a directory of
 *    FASTQ files (or protein FASTA), and confirms it with the user.
 *
 * On completion it leaves on the session: useTestProfile, outdir, paramValues,
 * samplesheetPath and command.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { ContainerEngine, HirshConfig } from "../config/types.js";
import type { PipelineDefinition, PipelineParam } from "../pipelines/types.js";
import type { AgentIO } from "./io.js";
import type { Session } from "./session.js";
import {
  checkSomaticDesign,
  inferPairs,
  linkCanonicalSequences,
  previewCsv,
  scanFastqs,
  scanSequenceDir,
  validateSamplesheetContent,
  writeCsv,
  type FastqPair,
  type ScanResult,
} from "../execution/samplesheet.js";

/**
 * Reference/samplesheet values remembered from relevant past runs, offered for
 * reuse during parameterization (Phase 6 memory feeding Phase C).
 */
export interface MemorySuggestions {
  /** Param name → remembered candidate values (e.g. genome → ["GRCm39"]). */
  references: Record<string, string[]>;
  /** Samplesheet paths from past runs. */
  samplesheets: string[];
}

function shortName(pipeline: PipelineDefinition): string {
  return pipeline.name.split("/").pop() ?? pipeline.name;
}

/** Asks a question with an optional remembered default (Enter reuses it). */
async function askDefault(io: AgentIO, question: string, def?: string): Promise<string> {
  const raw = (await io.ask(`${question}${def ? ` [${def}]` : ""}:`)).trim();
  return raw === "" ? def ?? "" : raw;
}

/** Creates the run directory and returns its paths. */
function prepareRunDir(config: HirshConfig, pipeline: PipelineDefinition): {
  runDir: string;
  outdir: string;
} {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = resolve(config.execution.workdir, `${shortName(pipeline)}-${ts}`);
  const outdir = join(runDir, "results");
  mkdirSync(runDir, { recursive: true });
  return { runDir, outdir };
}

export async function fillParameters(
  io: AgentIO,
  session: Session,
  pipeline: PipelineDefinition,
  config: HirshConfig,
  suggestions?: MemorySuggestions,
): Promise<{ runDir: string }> {
  const { runDir, outdir } = prepareRunDir(config, pipeline);
  session.outdir = outdir;
  session.runDir = runDir;
  session.paramValues[pipeline.results.outdirParam] = outdir;

  // Data may already be in hand — e.g. downloaded from public accessions via
  // fetchngs before Phase C. In that case there's a real samplesheet, so the
  // test profile doesn't apply and we don't rebuild the samplesheet.
  const dataReady =
    session.samplesheetPath !== undefined && session.paramValues.input !== undefined;

  // --- Test profile ---
  if (pipeline.profiles.hasTestProfile && !dataReady) {
    io.info(
      "The test profile runs the pipeline with bundled test data and references: " +
        "ideal to validate the installation without real data or long runtimes.",
    );
    session.useTestProfile = await io.confirm("Run a TEST run (test profile)?", true);
  }

  if (!session.useTestProfile) {
    if (!dataReady) await buildSamplesheet(io, session, pipeline, runDir, suggestions);
    await fillReferenceParams(io, session, pipeline, suggestions);
  }

  await fillOptionalParams(io, session, pipeline);

  finalizeCommand(session, pipeline, config);
  return { runDir };
}

/** Required reference params (genome / fasta+gtf) for real data. Exported for tests. */
export async function fillReferenceParams(
  io: AgentIO,
  session: Session,
  pipeline: PipelineDefinition,
  suggestions?: MemorySuggestions,
): Promise<void> {
  const hasGenome = pipeline.params.some((p) => p.name === "genome");
  if (!hasGenome) return;

  const genomeParam = pipeline.params.find((p) => p.name === "genome")!;
  const choices = genomeParam.choices ? ` (common options: ${genomeParam.choices.join(", ")})` : "";
  const remGenome = suggestions?.references.genome?.[0];
  const remFasta = suggestions?.references.fasta?.[0];
  const remGtf = suggestions?.references.gtf?.[0];

  const genomePrompt = remGenome
    ? `iGenomes reference genome key${choices}. Remembered from a past run: ${remGenome}. ` +
      "Press Enter to reuse it, type another key, or 'none' to provide FASTA+GTF:"
    : `iGenomes reference genome key${choices}. Leave empty if you prefer to provide your own FASTA+GTF:`;
  const genome = (await io.ask(genomePrompt)).trim();

  if (remGenome && genome === "") {
    session.paramValues.genome = remGenome;
    io.info(`Reusing remembered genome ${remGenome}.`);
    return;
  }
  if (genome && genome.toLowerCase() !== "none") {
    session.paramValues.genome = genome;
    return;
  }

  const fasta = await askDefault(io, "Path to the reference genome FASTA", remFasta);
  if (fasta) session.paramValues.fasta = resolve(fasta);
  if (pipeline.params.some((p) => p.name === "gtf")) {
    const gtf = await askDefault(io, "Path to the GTF annotation", remGtf);
    if (gtf) session.paramValues.gtf = resolve(gtf);
  }
}

/** Optional params: propose the default and ask for confirmation / an alternative value. */
async function fillOptionalParams(
  io: AgentIO,
  session: Session,
  pipeline: PipelineDefinition,
): Promise<void> {
  for (const p of pipeline.params) {
    if (p.required || p.providedBySamplesheet) continue;
    if (p.name === "genome" || p.name === "fasta" || p.name === "gtf") continue; // already handled
    if (session.paramValues[p.name] !== undefined) continue;
    if (p.default === undefined) continue; // no sensible default: do not bother in Phase 1

    const useDefault = await io.confirm(
      `${p.name}: ${p.description}\n  Use the default value "${p.default}"?`,
      true,
    );
    if (useDefault) {
      session.paramValues[p.name] = p.default;
    } else {
      const value = await askTyped(io, p);
      if (value !== undefined) session.paramValues[p.name] = value;
    }
  }
}

async function askTyped(io: AgentIO, p: PipelineParam): Promise<string | number | boolean | undefined> {
  const hint = p.choices ? ` (options: ${p.choices.join(", ")})` : "";
  const raw = (await io.ask(`Value for ${p.name}${hint}:`)).trim();
  if (!raw) return undefined;
  if (p.type === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? undefined : n;
  }
  if (p.type === "boolean") return /^(y(es)?|true|1)$/i.test(raw);
  return raw;
}

/** Builds the samplesheet from the user's files. */
async function buildSamplesheet(
  io: AgentIO,
  session: Session,
  pipeline: PipelineDefinition,
  runDir: string,
  suggestions?: MemorySuggestions,
): Promise<void> {
  io.heading("Samplesheet construction");
  io.info(pipeline.samplesheet.description);

  // Option 0 — reuse a samplesheet remembered from a past run.
  if (await useRememberedSamplesheet(io, session, pipeline, suggestions)) return;

  // Option 1 — reuse and validate an existing samplesheet.
  if (await useExistingSamplesheet(io, session, pipeline)) return;

  // Option 2 — build one from the user's files.
  const isProtein = pipeline.name.includes("proteinfamilies");
  const isSarek = pipeline.name.includes("sarek");
  const header = pipeline.samplesheet.columns.map((c) => c.name);
  const rows: Array<Record<string, string>> = [];

  if (isProtein) {
    const dir = await io.ask(
      "Directory with the protein FASTA files (.fasta/.fa, or any folder of sequence files):",
    );
    const entries = await resolveFastaFiles(io, dir, runDir);
    if (entries.length === 0) {
      io.warn("No FASTA files to use; the samplesheet will be empty.");
    }
    for (const f of entries) rows.push({ sample: baseName(f), fasta: f });
  } else {
    const dir = await io.ask(
      "Directory with the FASTQ files (.fastq.gz / .fq.gz, or any folder of sequence files):",
    );
    const scan = await resolveFastqScan(io, dir, runDir);
    const pairs = inferPairs(scan);
    if (isSarek) {
      rows.push(...(await buildSarekRows(io, pairs)));
      for (const w of checkSomaticDesign(rows)) io.warn(w);
    } else {
      rows.push(...(await buildRnaseqRows(io, pairs)));
    }
  }

  io.say("Proposed samplesheet:");
  io.say(previewCsv(header, rows));
  const ok = await io.confirm("Write this samplesheet?", true);
  if (!ok) {
    io.info("Alright, I won't write it. Restart with /reset to try another directory.");
    return;
  }
  const path = join(runDir, pipeline.samplesheet.filename);
  writeCsv(path, header, rows);
  session.samplesheetPath = path;
  session.paramValues.input = path;
  io.info(`Samplesheet written to ${path}`);
}

/**
 * Resolves a directory to a FASTQ scan. Prefers the fast extension-based scan;
 * when it finds nothing, falls back to **content-based** recognition (sniffing
 * FASTQ by its bytes, not its name) so sequences in a `.txt` or oddly-named file
 * are still usable — offering to symlink them to canonical names. Recognized-but-
 * unsupported formats (BAM/CRAM/fast5…) are reported, not silently ignored.
 */
async function resolveFastqScan(io: AgentIO, dir: string, runDir: string): Promise<ScanResult> {
  const scan = scanFastqs(dir);
  if (scan.files.length > 0) return scan;

  const sniffed = await scanSequenceDir(dir);
  const fastqs = sniffed.sequences.filter((s) => s.format === "fastq");
  if (fastqs.length === 0) {
    io.warn("I found no FASTQ files in that directory (by extension or by content).");
    for (const u of sniffed.unsupported) io.warn(`  • ${basename(u.file)}: looks like ${u.reason}.`);
    if (sniffed.unsupported.length > 0) {
      io.info(
        "I can read plain or gzipped FASTQ/FASTA. Convert aligned/binary formats (BAM/CRAM/SRA/" +
          "fast5) to FASTQ first — e.g. `samtools fastq input.bam`.",
      );
    }
    return scan; // empty
  }

  io.info(
    `No .fastq/.fq extension there, but I recognized ${fastqs.length} FASTQ file(s) by their content.`,
  );
  for (const u of sniffed.unsupported) io.warn(`  • skipping ${basename(u.file)} (looks like ${u.reason}).`);
  const link = await io.confirm(
    "Create canonical .fastq(.gz) names (symlinks) so the pipeline reads them?",
    true,
  );
  if (!link) {
    io.info("Okay — leaving them as-is; point me at a folder of properly named FASTQ files to continue.");
    return { dir: resolve(dir), files: [] };
  }

  const linkDir = join(runDir, "inputs");
  const res = linkCanonicalSequences(fastqs, linkDir);
  for (const f of res.failed) io.warn(`  couldn't link ${basename(f)} (symlink failed).`);
  io.info(`Linked ${res.linked.length} file(s) into ${linkDir} with canonical names.`);
  return scanFastqs(linkDir);
}

/**
 * Resolves a directory to protein FASTA files. Prefers the extension-based list;
 * when it finds nothing, falls back to content-based recognition (sniffing FASTA
 * by its bytes) and offers to symlink to canonical `.fasta` names. Unsupported
 * formats are reported, not silently ignored.
 */
async function resolveFastaFiles(io: AgentIO, dir: string, runDir: string): Promise<string[]> {
  const entries = listByExt(dir, [".fasta", ".fa", ".faa"]);
  if (entries.length > 0) return entries;

  const sniffed = await scanSequenceDir(dir);
  const fastas = sniffed.sequences.filter((s) => s.format === "fasta");
  if (fastas.length === 0) {
    io.warn("I found no FASTA files in that directory (by extension or by content).");
    for (const u of sniffed.unsupported) io.warn(`  • ${basename(u.file)}: looks like ${u.reason}.`);
    if (sniffed.unsupported.length > 0) {
      io.info("I can read plain or gzipped FASTA. Convert other formats to FASTA first.");
    }
    return [];
  }

  io.info(
    `No .fasta/.fa extension there, but I recognized ${fastas.length} FASTA file(s) by their content.`,
  );
  for (const u of sniffed.unsupported) io.warn(`  • skipping ${basename(u.file)} (looks like ${u.reason}).`);
  const link = await io.confirm(
    "Create canonical .fasta names (symlinks) so the pipeline reads them?",
    true,
  );
  if (!link) {
    io.info("Okay — leaving them as-is; point me at a folder of properly named FASTA files to continue.");
    return [];
  }

  const linkDir = join(runDir, "inputs");
  const res = linkCanonicalSequences(fastas, linkDir);
  for (const f of res.failed) io.warn(`  couldn't link ${basename(f)} (symlink failed).`);
  io.info(`Linked ${res.linked.length} file(s) into ${linkDir} with canonical names.`);
  return res.linked.map((l) => l.to);
}

/** Lets the user point at an existing CSV; validates it against the column spec. */
async function useExistingSamplesheet(
  io: AgentIO,
  session: Session,
  pipeline: PipelineDefinition,
): Promise<boolean> {
  const useExisting = await io.confirm("Do you already have a samplesheet CSV?", false);
  if (!useExisting) return false;

  const raw = (await io.ask("Path to your samplesheet CSV:")).trim();
  if (!raw) return false;
  const abs = resolve(raw);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    io.warn(`Couldn't read ${abs}. I'll help you build one instead.`);
    return false;
  }

  return applyExistingSamplesheet(io, session, pipeline, abs, text);
}

/** Offers to reuse a samplesheet from a past run (Phase 6 memory → Phase C). Exported for tests. */
export async function useRememberedSamplesheet(
  io: AgentIO,
  session: Session,
  pipeline: PipelineDefinition,
  suggestions?: MemorySuggestions,
): Promise<boolean> {
  const remembered = (suggestions?.samplesheets ?? []).filter((p) => existsSync(p));
  if (remembered.length === 0) return false;

  const path = remembered[0];
  const reuse = await io.confirm(`Reuse the samplesheet from a past run (${path})?`, false);
  if (!reuse) return false;

  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    io.warn(`Couldn't read ${abs}; let's build one instead.`);
    return false;
  }
  return applyExistingSamplesheet(io, session, pipeline, abs, text);
}

/** Validates a samplesheet's content and, if acceptable, records it on the session. */
async function applyExistingSamplesheet(
  io: AgentIO,
  session: Session,
  pipeline: PipelineDefinition,
  abs: string,
  text: string,
): Promise<boolean> {
  const report = validateSamplesheetContent(text, pipeline.samplesheet.columns);
  io.info(`Read ${report.rowCount} data row(s); columns: ${report.header.join(", ")}.`);
  for (const e of report.errors) io.warn("  ✗ " + e);
  for (const w of report.warnings) io.info("  ! " + w);
  if (!report.ok) {
    const anyway = await io.confirm("The samplesheet has problems. Use it anyway?", false);
    if (!anyway) {
      io.info("Okay — let's build one instead.");
      return false;
    }
  }
  session.samplesheetPath = abs;
  session.paramValues.input = abs;
  io.info(`Using samplesheet ${abs}`);
  return true;
}

/** rnaseq rows with a shared default strandedness and optional per-sample override. */
async function buildRnaseqRows(io: AgentIO, pairs: FastqPair[]): Promise<Array<Record<string, string>>> {
  const def = (await io.ask("Default library strandedness (forward/reverse/unstranded/auto) [auto]:")).trim() || "auto";
  const perSample = new Map<string, string>();
  if (pairs.length > 1) {
    const same = await io.confirm(`Use "${def}" strandedness for all ${pairs.length} samples?`, true);
    if (!same) {
      for (const p of pairs) {
        const s = (await io.ask(`Strandedness for ${p.sample} [${def}]:`)).trim() || def;
        perSample.set(p.sample, s);
      }
    }
  }
  return pairs.map((p) => ({
    sample: p.sample,
    fastq_1: p.fastq_1,
    fastq_2: p.fastq_2 ?? "",
    strandedness: perSample.get(p.sample) ?? def,
  }));
}

/** sarek rows: germline (status 0) or per-sample tumor/normal grouped by patient. */
async function buildSarekRows(io: AgentIO, pairs: FastqPair[]): Promise<Array<Record<string, string>>> {
  const somatic = await io.confirm("Is this a somatic (tumor/normal) analysis?", false);
  if (!somatic) {
    return pairs.map((p) => sarekRow(p.sample, p.sample, "0", p));
  }
  io.info("For each sample, tell me its patient/individual and whether it is tumor or normal.");
  const rows: Array<Record<string, string>> = [];
  for (const p of pairs) {
    const patient = (await io.ask(`Patient/individual ID for sample "${p.sample}" [${p.sample}]:`)).trim() || p.sample;
    const isTumor = await io.confirm(`Is "${p.sample}" a TUMOR sample? (No = normal)`, false);
    rows.push(sarekRow(patient, p.sample, isTumor ? "1" : "0", p));
  }
  return rows;
}

function sarekRow(patient: string, sample: string, status: string, p: FastqPair): Record<string, string> {
  return {
    patient,
    sample,
    status,
    lane: "L001",
    fastq_1: p.fastq_1,
    fastq_2: p.fastq_2 ?? "",
  };
}

function listByExt(dir: string, exts: string[]): string[] {
  try {
    const abs = resolve(dir);
    return readdirSync(abs)
      .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
      .filter((f) => {
        try {
          return statSync(join(abs, f)).isFile();
        } catch {
          return false;
        }
      })
      .map((f) => join(abs, f))
      .sort();
  } catch {
    return [];
  }
}

function baseName(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.(fasta|fa|faa)$/i, "");
}

/** With the test profile, these are provided by the profile itself. */
const TEST_PROVIDED = ["input", "genome", "fasta", "gtf"];

/**
 * Builds the parameter object written to the -params-file. Applies config-level
 * resource caps (max_memory/max_cpus) as defaults unless already set (e.g. by
 * the Phase D resource adaptation).
 */
export function buildParamsObject(
  session: Session,
  config: HirshConfig,
): Record<string, string | number | boolean> {
  const obj: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(session.paramValues)) {
    if (session.useTestProfile && TEST_PROVIDED.includes(name)) continue;
    obj[name] = value;
  }
  if (obj.max_memory === undefined && config.execution.maxMemory) {
    obj.max_memory = config.execution.maxMemory;
  }
  if (obj.max_cpus === undefined && config.execution.maxCpus) {
    obj.max_cpus = config.execution.maxCpus;
  }
  return obj;
}

/** Builds the `nextflow run` argument list using a -params-file. */
export function buildRunArgs(
  pipeline: PipelineDefinition,
  config: HirshConfig,
  useTestProfile: boolean,
  paramsFilePath: string,
  engine?: ContainerEngine,
  extraConfigs: string[] = [],
): string[] {
  const profiles: string[] = [];
  if (useTestProfile && pipeline.profiles.testProfile) {
    profiles.push(pipeline.profiles.testProfile);
  }
  profiles.push(engine ?? config.execution.containerEngine);
  const args = [
    "run",
    pipeline.name,
    "-r",
    pipeline.version,
    "-profile",
    profiles.join(","),
    "-params-file",
    paramsFilePath,
  ];
  for (const cfg of extraConfigs) {
    args.push("-c", cfg);
  }
  return args;
}

/**
 * Writes params.yaml into the run directory and sets session.command /
 * session.paramsFile. Safe to call again after resource adaptation to rewrite
 * the file and refresh the command.
 */
export function finalizeCommand(
  session: Session,
  pipeline: PipelineDefinition,
  config: HirshConfig,
): void {
  const runDir = session.runDir ?? resolve(config.execution.workdir);
  const paramsPath = join(runDir, "params.yaml");
  const obj = buildParamsObject(session, config);
  writeFileSync(paramsPath, stringifyYaml(obj), "utf8");
  session.paramsFile = paramsPath;
  const extraConfigs = session.executorConfigPath ? [session.executorConfigPath] : [];
  session.command = buildRunArgs(
    pipeline,
    config,
    session.useTestProfile,
    paramsPath,
    session.engine,
    extraConfigs,
  );
}
