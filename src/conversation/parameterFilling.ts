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
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { ContainerEngine, HirshConfig } from "../config/types.js";
import type { PipelineDefinition, PipelineParam } from "../pipelines/types.js";
import type { AgentIO } from "./io.js";
import type { Session } from "./session.js";
import {
  checkSomaticDesign,
  inferPairs,
  previewCsv,
  scanFastqs,
  validateSamplesheetContent,
  writeCsv,
  type FastqPair,
} from "../execution/samplesheet.js";

function shortName(pipeline: PipelineDefinition): string {
  return pipeline.name.split("/").pop() ?? pipeline.name;
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
): Promise<{ runDir: string }> {
  const { runDir, outdir } = prepareRunDir(config, pipeline);
  session.outdir = outdir;
  session.runDir = runDir;
  session.paramValues[pipeline.results.outdirParam] = outdir;

  // --- Test profile ---
  if (pipeline.profiles.hasTestProfile) {
    io.info(
      "The test profile runs the pipeline with bundled test data and references: " +
        "ideal to validate the installation without real data or long runtimes.",
    );
    session.useTestProfile = await io.confirm("Run a TEST run (test profile)?", true);
  }

  if (!session.useTestProfile) {
    await buildSamplesheet(io, session, pipeline, runDir);
    await fillReferenceParams(io, session, pipeline);
  }

  await fillOptionalParams(io, session, pipeline);

  finalizeCommand(session, pipeline, config);
  return { runDir };
}

/** Required reference params (genome / fasta+gtf) for real data. */
async function fillReferenceParams(
  io: AgentIO,
  session: Session,
  pipeline: PipelineDefinition,
): Promise<void> {
  const hasGenome = pipeline.params.some((p) => p.name === "genome");
  if (!hasGenome) return;

  const genomeParam = pipeline.params.find((p) => p.name === "genome")!;
  const choices = genomeParam.choices ? ` (common options: ${genomeParam.choices.join(", ")})` : "";
  const genome = await io.ask(
    `iGenomes reference genome key${choices}. ` +
      "Leave empty if you prefer to provide your own FASTA+GTF:",
  );
  if (genome.trim()) {
    session.paramValues.genome = genome.trim();
  } else {
    const fasta = await io.ask("Path to the reference genome FASTA:");
    if (fasta.trim()) session.paramValues.fasta = resolve(fasta.trim());
    if (pipeline.params.some((p) => p.name === "gtf")) {
      const gtf = await io.ask("Path to the GTF annotation:");
      if (gtf.trim()) session.paramValues.gtf = resolve(gtf.trim());
    }
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
): Promise<void> {
  io.heading("Samplesheet construction");
  io.info(pipeline.samplesheet.description);

  // Option 1 — reuse and validate an existing samplesheet.
  if (await useExistingSamplesheet(io, session, pipeline)) return;

  // Option 2 — build one from the user's files.
  const isProtein = pipeline.name.includes("proteinfamilies");
  const isSarek = pipeline.name.includes("sarek");
  const header = pipeline.samplesheet.columns.map((c) => c.name);
  const rows: Array<Record<string, string>> = [];

  if (isProtein) {
    const dir = await io.ask("Directory with the protein FASTA files (.fasta/.fa):");
    const entries = listByExt(dir, [".fasta", ".fa", ".faa"]);
    if (entries.length === 0) {
      io.warn("I found no FASTA files in that directory; the samplesheet will be empty.");
    }
    for (const f of entries) rows.push({ sample: baseName(f), fasta: f });
  } else {
    const dir = await io.ask("Directory with the FASTQ files (.fastq.gz / .fq.gz):");
    const scan = scanFastqs(dir);
    if (scan.files.length === 0) io.warn("I found no FASTQ files in that directory.");
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
): string[] {
  const profiles: string[] = [];
  if (useTestProfile && pipeline.profiles.testProfile) {
    profiles.push(pipeline.profiles.testProfile);
  }
  profiles.push(engine ?? config.execution.containerEngine);
  return [
    "run",
    pipeline.name,
    "-r",
    pipeline.version,
    "-profile",
    profiles.join(","),
    "-params-file",
    paramsFilePath,
  ];
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
  session.command = buildRunArgs(pipeline, config, session.useTestProfile, paramsPath, session.engine);
}
