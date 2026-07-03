/**
 * Public-data retrieval (co-scientist milestone).
 *
 * A scientist rarely has FASTQ files on hand — they have *accession numbers*
 * from a paper (SRA/ENA/DDBJ runs, GEO series, BioProjects…). This module lets
 * Hirsh recognize those accessions in the request and drive nf-core/fetchngs to
 * download the data and emit a samplesheet, which then feeds the chosen pipeline.
 *
 * Everything here is pure (text/ids in, detections/command out) so it can be
 * unit-tested; the actual Nextflow run is driven by the state machine through the
 * usual confirmed-execution path.
 */

/** nf-core/fetchngs pinned revision (SRA/ENA/GEO → FASTQ + samplesheet). */
export const FETCHNGS_REVISION = "1.12.0";

export type AccessionKind =
  | "run"
  | "experiment"
  | "sample"
  | "study"
  | "bioproject"
  | "biosample"
  | "geo-series"
  | "geo-sample"
  | "arrayexpress";

export interface Accession {
  id: string;
  kind: AccessionKind;
}

/**
 * Accession patterns, most specific first. Anchored with word boundaries so we
 * don't match substrings inside identifiers or prose. All of these are accepted
 * by nf-core/fetchngs as input ids.
 */
const PATTERNS: Array<{ kind: AccessionKind; re: RegExp }> = [
  { kind: "run", re: /\b(?:SRR|ERR|DRR)\d{5,}\b/g },
  { kind: "experiment", re: /\b(?:SRX|ERX|DRX)\d{5,}\b/g },
  { kind: "sample", re: /\b(?:SRS|ERS|DRS)\d{5,}\b/g },
  { kind: "study", re: /\b(?:SRP|ERP|DRP)\d{5,}\b/g },
  { kind: "bioproject", re: /\bPRJ(?:NA|EB|DB|DA|EA|E)\d{3,}\b/g },
  { kind: "biosample", re: /\bSAM(?:EA|EG|N|D|E)\d{3,}\b/g },
  { kind: "geo-series", re: /\bGSE\d{3,}\b/g },
  { kind: "geo-sample", re: /\bGSM\d{3,}\b/g },
  { kind: "arrayexpress", re: /\bE-[A-Z]{4}-\d+\b/g },
];

/**
 * Detects public-data accessions in free text, de-duplicated and in first-seen
 * order. An id is classified by the first pattern it matches.
 */
export function detectAccessions(text: string): Accession[] {
  if (!text) return [];
  const seen = new Map<string, AccessionKind>();
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const id = m[0];
      if (!seen.has(id)) seen.set(id, kind);
    }
  }
  // Preserve the order the ids appear in the text.
  const order = new Map<string, number>();
  let i = 0;
  for (const m of text.matchAll(/\b[A-Z][A-Z-]*\d[A-Z0-9-]*\b/g)) {
    if (seen.has(m[0]) && !order.has(m[0])) order.set(m[0], i++);
  }
  return [...seen.entries()]
    .map(([id, kind]) => ({ id, kind }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** The ids file fetchngs consumes via `--input` — one accession per line. */
export function renderIdsFile(accessions: Accession[]): string {
  return accessions.map((a) => a.id).join("\n") + "\n";
}

/**
 * Maps a target nf-core pipeline to fetchngs' `--nf_core_pipeline` value, so the
 * emitted samplesheet is shaped for that pipeline. Only the pipelines fetchngs
 * knows how to format for are mapped; others get the generic samplesheet.
 */
export function fetchngsPipelineTag(pipelineName: string): string | undefined {
  const n = pipelineName.toLowerCase();
  if (n.includes("rnaseq")) return "rnaseq";
  if (n.includes("atacseq")) return "atacseq";
  if (n.includes("taxprofiler")) return "taxprofiler";
  if (n.includes("viralrecon")) return "viralrecon";
  return undefined;
}

/** Where fetchngs writes the samplesheet it generates. */
export function fetchngsSamplesheetPath(outdir: string): string {
  return `${outdir}/samplesheet/samplesheet.csv`;
}

export interface FetchngsCommandOptions {
  idsFile: string;
  outdir: string;
  engine: string;
  /** `--nf_core_pipeline` value, when the target pipeline is supported. */
  pipelineTag?: string;
  revision?: string;
  extraConfigs?: string[];
}

/** Builds the `nextflow run nf-core/fetchngs …` argument list. Pure. */
export function buildFetchngsCommand(opts: FetchngsCommandOptions): string[] {
  const args = [
    "run",
    "nf-core/fetchngs",
    "-r",
    opts.revision ?? FETCHNGS_REVISION,
    "-profile",
    opts.engine,
    "--input",
    opts.idsFile,
    "--outdir",
    opts.outdir,
  ];
  if (opts.pipelineTag) args.push("--nf_core_pipeline", opts.pipelineTag);
  for (const cfg of opts.extraConfigs ?? []) args.push("-c", cfg);
  return args;
}
