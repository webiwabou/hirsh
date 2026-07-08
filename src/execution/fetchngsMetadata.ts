/**
 * Previewing sample metadata before a fetchngs download (co-scientist milestone).
 *
 * A scientist should see *what* they're about to download — how many runs, which
 * organism, sequencing strategy and rough size — before committing to a possibly
 * multi-gigabyte transfer. The ENA Portal API resolves SRA/ENA/DDBJ accessions
 * (run/experiment/sample/study) to their runs with metadata; it does not cover
 * GEO/ArrayExpress ids (fetchngs resolves those through a different path), so the
 * preview is best-effort and honest about what it can't resolve.
 *
 * URL building and TSV parsing are pure and unit-tested; the HTTP call lives in
 * the state machine.
 */
import type { AccessionKind } from "./fetchngs.js";

/** Fields requested from the ENA filereport API, in order. */
export const ENA_FIELDS = [
  "run_accession",
  "sample_title",
  "scientific_name",
  "library_strategy",
  "library_layout",
  "read_count",
  "fastq_bytes",
] as const;

export interface RunMetadata {
  run: string;
  title?: string;
  organism?: string;
  strategy?: string;
  /** "SINGLE" | "PAIRED" (library_layout). */
  layout?: string;
  reads?: number;
  /** Total FASTQ bytes for the run (summed across paired files). */
  bytes?: number;
}

/** Accession kinds the ENA read_run API can resolve (not GEO/ArrayExpress). */
export function isEnaResolvable(kind: AccessionKind): boolean {
  return (
    kind === "run" ||
    kind === "experiment" ||
    kind === "sample" ||
    kind === "study" ||
    kind === "bioproject" ||
    kind === "biosample"
  );
}

/** Builds the ENA Portal filereport URL for an accession (result=read_run, TSV). Pure. */
export function buildEnaFileReportUrl(accession: string): string {
  const params = new URLSearchParams({
    accession,
    result: "read_run",
    fields: ENA_FIELDS.join(","),
    format: "tsv",
  });
  return `https://www.ebi.ac.uk/ena/portal/api/filereport?${params.toString()}`;
}

function toNumber(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Sums a semicolon-separated `fastq_bytes` value (paired files) into one total. */
function sumBytes(field: string | undefined): number | undefined {
  if (!field) return undefined;
  const parts = field
    .split(";")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 0) return undefined;
  return parts.reduce((a, b) => a + b, 0);
}

/**
 * Parses an ENA filereport TSV into run metadata rows. Tolerant of column
 * reordering (it maps by header name) and missing fields. Pure.
 */
export function parseEnaFileReport(tsv: string): RunMetadata[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split("\t").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iRun = col("run_accession");
  if (iRun === -1) return [];
  const iTitle = col("sample_title");
  const iOrg = col("scientific_name");
  const iStrat = col("library_strategy");
  const iLayout = col("library_layout");
  const iReads = col("read_count");
  const iBytes = col("fastq_bytes");
  const rows: RunMetadata[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const run = (c[iRun] ?? "").trim();
    if (run === "") continue;
    const pick = (i: number) => (i >= 0 ? (c[i] ?? "").trim() || undefined : undefined);
    rows.push({
      run,
      title: pick(iTitle),
      organism: pick(iOrg),
      strategy: pick(iStrat),
      layout: pick(iLayout),
      reads: toNumber(pick(iReads)),
      bytes: sumBytes(pick(iBytes)),
    });
  }
  return rows;
}

export interface MetadataSummary {
  runs: number;
  totalReads: number;
  /** Total FASTQ bytes across all runs (0 when unknown). */
  totalBytes: number;
  /** True when at least one run reported a byte size. */
  hasBytes: boolean;
  organisms: string[];
  strategies: string[];
  layouts: string[];
}

/** Aggregates run metadata into a preview summary (distinct organisms/strategies). Pure. */
export function summarizeRunMetadata(rows: RunMetadata[]): MetadataSummary {
  const organisms = new Set<string>();
  const strategies = new Set<string>();
  const layouts = new Set<string>();
  let totalReads = 0;
  let totalBytes = 0;
  let hasBytes = false;
  for (const r of rows) {
    if (r.organism) organisms.add(r.organism);
    if (r.strategy) strategies.add(r.strategy);
    if (r.layout) layouts.add(r.layout);
    if (r.reads) totalReads += r.reads;
    if (r.bytes) {
      totalBytes += r.bytes;
      hasBytes = true;
    }
  }
  return {
    runs: rows.length,
    totalReads,
    totalBytes,
    hasBytes,
    organisms: [...organisms].sort(),
    strategies: [...strategies].sort(),
    layouts: [...layouts].sort(),
  };
}

/** Human-readable byte size (base-1024, e.g. "1.5 GB"). Pure. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
