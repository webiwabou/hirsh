/**
 * Pure parsers for results interpretation (Phase E / recommendation I3).
 *
 * These turn raw result files into concrete numbers a biologist cares about, so
 * the LLM summarizes real findings instead of listing files. Kept pure (string
 * in, data out) so they are unit-tested without touching disk.
 */

export interface TableSummary {
  rows: number;
  cols: number;
  columns: string[];
  /** Columns whose values are numeric across the sampled rows (e.g. samples). */
  numericColumns: string[];
  /** Column sum per numeric column (e.g. per-sample library size for counts). */
  columnSums: Record<string, number>;
}

function splitDelimited(text: string): { delim: string; lines: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const delim = lines.length > 0 && lines[0].includes("\t") ? "\t" : ",";
  return { delim, lines };
}

/** Summarizes a counts/TPM-style matrix: dimensions and per-column sums. */
export function summarizeTable(text: string): TableSummary {
  const { delim, lines } = splitDelimited(text);
  if (lines.length === 0) {
    return { rows: 0, cols: 0, columns: [], numericColumns: [], columnSums: {} };
  }
  const columns = lines[0].split(delim);
  const dataLines = lines.slice(1);

  // Decide which columns are numeric by sampling up to 50 rows.
  const sample = dataLines.slice(0, 50).map((l) => l.split(delim));
  const numericIdx: number[] = [];
  for (let c = 0; c < columns.length; c++) {
    let seen = 0;
    let numeric = 0;
    for (const row of sample) {
      const v = row[c];
      if (v !== undefined && v !== "") {
        seen++;
        if (!Number.isNaN(Number(v))) numeric++;
      }
    }
    if (seen > 0 && numeric === seen) numericIdx.push(c);
  }

  const columnSums: Record<string, number> = {};
  for (const i of numericIdx) columnSums[columns[i]] = 0;
  for (const l of dataLines) {
    const row = l.split(delim);
    for (const i of numericIdx) {
      const v = Number(row[i]);
      if (!Number.isNaN(v)) columnSums[columns[i]] += v;
    }
  }

  return {
    rows: dataLines.length,
    cols: columns.length,
    columns,
    numericColumns: numericIdx.map((i) => columns[i]),
    columnSums,
  };
}

import type { ChartData, ChartItem } from "./charts.js";

export interface GeneralStats {
  sampleCount: number;
  metrics: string[];
  perSample: Array<{ sample: string; values: Record<string, string> }>;
}

/** Shortens a MultiQC general-stats column to a readable metric label. */
export function prettyMetric(name: string): string {
  let n = name;
  const marker = "generalstats-";
  const idx = n.toLowerCase().indexOf(marker);
  if (idx >= 0) n = n.slice(idx + marker.length);
  n = n.replace(/[_-]+/g, " ").trim();
  return n || name;
}

/**
 * Builds one per-sample bar series per **numeric** MultiQC metric, for the HTML
 * report. Skips non-numeric and constant metrics (no signal), and caps metrics
 * and samples so the report stays light. Pure.
 */
export function metricSeries(
  g: GeneralStats,
  opts: { maxMetrics?: number; maxSamples?: number } = {},
): ChartData[] {
  const maxMetrics = opts.maxMetrics ?? 6;
  const maxSamples = opts.maxSamples ?? 24;
  const out: ChartData[] = [];
  for (const metric of g.metrics) {
    if (out.length >= maxMetrics) break;
    const items: ChartItem[] = [];
    for (const s of g.perSample.slice(0, maxSamples)) {
      const raw = s.values[metric];
      if (raw === undefined || raw.trim() === "") continue;
      const v = Number(raw);
      if (Number.isNaN(v)) continue;
      items.push({ label: s.sample, value: v });
    }
    if (items.length < 2) continue; // need at least two samples to compare
    const values = items.map((i) => i.value);
    if (Math.max(...values) === Math.min(...values)) continue; // constant → no signal
    out.push({ title: prettyMetric(metric), items });
  }
  return out;
}

/** Parses a MultiQC `multiqc_general_stats.txt` (TSV: Sample + metric columns). */
export function parseGeneralStats(text: string): GeneralStats {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { sampleCount: 0, metrics: [], perSample: [] };
  const header = lines[0].split("\t");
  const metrics = header.slice(1);
  const perSample = lines.slice(1).map((l) => {
    const cells = l.split("\t");
    const values: Record<string, string> = {};
    metrics.forEach((m, i) => {
      values[m] = cells[i + 1] ?? "";
    });
    return { sample: cells[0] ?? "", values };
  });
  return { sampleCount: perSample.length, metrics, perSample };
}

export interface DifferentialSummary {
  /** Data rows in the table. */
  total: number;
  /** Column used as the adjusted p-value (null if none recognized). */
  padjColumn: string | null;
  /** Column used as the log2 fold-change (null if none recognized). */
  lfcColumn: string | null;
  alpha: number;
  lfcThreshold: number;
  /** Rows with a numeric adjusted p-value (i.e. actually tested). */
  tested: number;
  /** Rows passing the significance (and, if available, fold-change) thresholds. */
  significant: number;
  up: number;
  down: number;
}

const PADJ_NAMES = new Set([
  "padj",
  "adj.p.val",
  "adj.pval",
  "adjpvalue",
  "adj_pvalue",
  "fdr",
  "qvalue",
  "q_value",
  "q.value",
  "svalue",
  "s_value",
  "bh",
]);

function findColumn(header: string[], match: (h: string) => boolean): { name: string; idx: number } | null {
  for (let i = 0; i < header.length; i++) {
    if (match(header[i].trim().toLowerCase())) return { name: header[i].trim(), idx: i };
  }
  return null;
}

type DeColumn = { name: string; idx: number } | null;

/** Detects the adjusted-p-value and log2-fold-change columns from a DE header. */
function detectDeColumns(header: string[]): { padj: DeColumn; lfc: DeColumn } {
  const padj =
    findColumn(header, (h) => PADJ_NAMES.has(h)) ??
    findColumn(header, (h) => h.includes("padj") || h.includes("adj.p") || h.includes("fdr") || h.includes("qvalue"));
  const lfc =
    findColumn(header, (h) => h === "log2foldchange" || h === "log2fc" || h === "logfc") ??
    findColumn(header, (h) => h.includes("log2fold") || h.includes("log2fc") || h.includes("logfc"));
  return { padj, lfc };
}

function isNa(v: string | undefined): boolean {
  if (v === undefined) return true;
  const t = v.trim().toLowerCase();
  return t === "" || t === "na" || t === "nan" || t === "." || t === "null";
}

/**
 * Counts significant genes in a differential-expression results table (DESeq2/
 * limma/edgeR style), by recognizing the adjusted p-value and log2 fold-change
 * columns from their names. Defaults: padj < 0.05 and |log2FC| > 1 (the latter
 * only applied when a fold-change column is present). Pure; header-heuristic, so
 * it degrades to `padjColumn: null` when it can't identify the columns.
 */
export function countDifferential(
  text: string,
  opts: { alpha?: number; lfcThreshold?: number } = {},
): DifferentialSummary {
  const alpha = opts.alpha ?? 0.05;
  const lfcThreshold = opts.lfcThreshold ?? 1;
  const { delim, lines } = splitDelimited(text);
  const empty: DifferentialSummary = {
    total: 0,
    padjColumn: null,
    lfcColumn: null,
    alpha,
    lfcThreshold,
    tested: 0,
    significant: 0,
    up: 0,
    down: 0,
  };
  if (lines.length < 2) return empty;

  const header = lines[0].split(delim);
  const { padj, lfc } = detectDeColumns(header);

  const dataLines = lines.slice(1);
  if (!padj) {
    return { ...empty, total: dataLines.length };
  }

  let tested = 0;
  let significant = 0;
  let up = 0;
  let down = 0;
  for (const line of dataLines) {
    const cells = line.split(delim);
    const pRaw = cells[padj.idx];
    if (isNa(pRaw)) continue;
    const p = Number(pRaw);
    if (Number.isNaN(p)) continue;
    tested++;
    if (p >= alpha) continue;
    let fc: number | null = null;
    if (lfc) {
      const fcRaw = cells[lfc.idx];
      if (!isNa(fcRaw) && !Number.isNaN(Number(fcRaw))) fc = Number(fcRaw);
      if (fc !== null && Math.abs(fc) <= lfcThreshold) continue;
    }
    significant++;
    if (fc !== null) {
      if (fc > 0) up++;
      else if (fc < 0) down++;
    }
  }

  return {
    total: dataLines.length,
    padjColumn: padj.name,
    lfcColumn: lfc?.name ?? null,
    alpha,
    lfcThreshold,
    tested,
    significant,
    up,
    down,
  };
}

export interface VolcanoPoint {
  /** log2 fold-change. */
  x: number;
  /** -log10(adjusted p-value). */
  y: number;
  cls: "up" | "down" | "ns";
}

export interface VolcanoData {
  points: VolcanoPoint[];
  alpha: number;
  lfcThreshold: number;
  /** Data rows with a usable (padj, log2FC) pair. */
  plotted: number;
  up: number;
  down: number;
}

/** -log10 with a floor so p=0 (or underflow) maps to a finite, large y. */
function negLog10(p: number): number {
  return -Math.log10(Math.max(p, 1e-300));
}

/**
 * Extracts volcano-plot points (log2FC vs -log10 padj) from a differential-
 * expression table. Needs BOTH a padj and a log2FC column (returns null
 * otherwise — a volcano is meaningless without fold-change). Significant points
 * (padj<alpha and |log2FC|>threshold) are always kept; non-significant points are
 * down-sampled to stay within `cap` so the inline SVG stays small. Pure.
 */
export function extractVolcano(
  text: string,
  opts: { alpha?: number; lfcThreshold?: number; cap?: number } = {},
): VolcanoData | null {
  const alpha = opts.alpha ?? 0.05;
  const lfcThreshold = opts.lfcThreshold ?? 1;
  const cap = opts.cap ?? 2000;
  const { delim, lines } = splitDelimited(text);
  if (lines.length < 2) return null;
  const { padj, lfc } = detectDeColumns(lines[0].split(delim));
  if (!padj || !lfc) return null;

  const sig: VolcanoPoint[] = [];
  const ns: VolcanoPoint[] = [];
  let up = 0;
  let down = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delim);
    const pRaw = cells[padj.idx];
    const fRaw = cells[lfc.idx];
    if (isNa(pRaw) || isNa(fRaw)) continue;
    const p = Number(pRaw);
    const f = Number(fRaw);
    if (Number.isNaN(p) || Number.isNaN(f)) continue;
    const significant = p < alpha && Math.abs(f) > lfcThreshold;
    const cls: VolcanoPoint["cls"] = significant ? (f > 0 ? "up" : "down") : "ns";
    if (significant) {
      if (f > 0) up++;
      else down++;
      sig.push({ x: f, y: negLog10(p), cls });
    } else {
      ns.push({ x: f, y: negLog10(p), cls });
    }
  }
  if (sig.length === 0 && ns.length === 0) return null;

  // Keep all significant points; down-sample non-significant to fill the budget.
  const budget = Math.max(0, cap - sig.length);
  let keptNs = ns;
  if (ns.length > budget && budget > 0) {
    const stride = ns.length / budget;
    keptNs = [];
    for (let k = 0; k < budget; k++) keptNs.push(ns[Math.floor(k * stride)]);
  } else if (budget === 0) {
    keptNs = [];
  }

  return { points: [...keptNs, ...sig], alpha, lfcThreshold, plotted: sig.length + ns.length, up, down };
}

/**
 * Extracts the distinct container images from an nf-core execution trace
 * (`pipeline_info/execution_trace_*.txt`, a TSV with a `container` column), for
 * byte-exact reproducibility provenance. Digest-pinned where Nextflow resolved
 * one; excludes empty/"-" cells (e.g. conda tasks). Pure; returns sorted distinct.
 */
export function parseTraceContainers(traceText: string): string[] {
  const lines = traceText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split("\t").map((h) => h.trim());
  const idx = header.indexOf("container");
  if (idx === -1) return [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cell = (lines[i].split("\t")[idx] ?? "").trim();
    if (cell && cell !== "-" && cell.toLowerCase() !== "null") seen.add(cell);
  }
  return [...seen].sort();
}

export interface TraceResources {
  /** Processes with a parseable peak RSS, largest first. */
  processes: Array<{ name: string; peakRssGB: number }>;
  /** The largest peak RSS observed across processes (GB), or null if none. */
  maxPeakRssGB: number | null;
}

/**
 * Parses a Nextflow trace size cell ("1.5 GB", "512 MB", "2 GB") to GB. Nextflow
 * reports base-1024 units, so 512 MB → 0.5 GB.
 */
function sizeToGB(raw: string): number | null {
  const m = /^([\d.]+)\s*([kmgt]?)i?b?$/i.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (Number.isNaN(value)) return null;
  const unit = m[2].toLowerCase();
  const K = 1024;
  const factor: Record<string, number> = { "": 1 / K ** 3, k: 1 / K ** 2, m: 1 / K, g: 1, t: K };
  return value * (factor[unit] ?? 1);
}

/**
 * Reads the real peak memory per process from an nf-core execution trace (the
 * `peak_rss` column), so a scientist learns how much memory a run actually used —
 * useful for sizing future runs. Aggregates to the max peak across processes
 * (each process name kept at its largest peak). Pure; tolerant of missing columns.
 */
export function parseTraceResources(traceText: string): TraceResources {
  const lines = traceText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { processes: [], maxPeakRssGB: null };
  const header = lines[0].split("\t").map((h) => h.trim());
  const nameIdx = header.indexOf("name");
  const rssIdx = header.indexOf("peak_rss");
  if (nameIdx === -1 || rssIdx === -1) return { processes: [], maxPeakRssGB: null };

  const byName = new Map<string, number>();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const name = (cells[nameIdx] ?? "").trim().replace(/\s*\(.*\)$/, ""); // drop the tag suffix
    const gb = sizeToGB(cells[rssIdx] ?? "");
    if (!name || gb === null) continue;
    byName.set(name, Math.max(byName.get(name) ?? 0, gb));
  }
  const processes = [...byName.entries()]
    .map(([name, peakRssGB]) => ({ name, peakRssGB }))
    .sort((a, b) => b.peakRssGB - a.peakRssGB);
  return { processes, maxPeakRssGB: processes.length > 0 ? processes[0].peakRssGB : null };
}

/** Counts variant records in VCF text (lines that are not headers/empty). */
export function countVcfRecords(text: string): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0 && !line.startsWith("#")) n++;
  }
  return n;
}

export interface VcfSummary {
  /** Variant records (data lines). */
  records: number;
  /** ALT alleles classified (multi-allelic records contribute several). */
  alleles: number;
  snps: number;
  indels: number;
  mnps: number;
  /** Symbolic/other ALTs (e.g. <DEL>, *) not classified above. */
  other: number;
  transitions: number;
  transversions: number;
  /** Transition/transversion ratio, or null when there are no transversions. */
  tstv: number | null;
}

const TRANSITIONS = new Set(["AG", "GA", "CT", "TC"]);
const BASE = /^[ACGT]$/;

/**
 * Summarizes a VCF's variant types — SNPs vs indels vs MNPs, and the
 * transition/transversion ratio (a standard variant-calling QC metric) — from the
 * REF/ALT columns. Multi-allelic records are split per ALT allele. Pure; ignores
 * header lines. Good enough for interpretation, not a full VCF parser.
 */
export function summarizeVcf(text: string): VcfSummary {
  const s: VcfSummary = {
    records: 0,
    alleles: 0,
    snps: 0,
    indels: 0,
    mnps: 0,
    other: 0,
    transitions: 0,
    transversions: 0,
    tstv: null,
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 5) continue;
    s.records++;
    const ref = (cols[3] ?? "").trim().toUpperCase();
    const altField = (cols[4] ?? "").trim().toUpperCase();
    if (ref === "" || altField === "" || altField === ".") continue;
    for (const alt of altField.split(",")) {
      s.alleles++;
      if (alt === "" || alt === "*" || alt.startsWith("<") || alt.includes("[") || alt.includes("]")) {
        s.other++;
        continue;
      }
      if (ref.length === 1 && alt.length === 1 && BASE.test(ref) && BASE.test(alt)) {
        s.snps++;
        if (TRANSITIONS.has(ref + alt)) s.transitions++;
        else s.transversions++;
      } else if (ref.length !== alt.length) {
        s.indels++;
      } else if (ref.length === alt.length) {
        s.mnps++;
      } else {
        s.other++;
      }
    }
  }
  s.tstv = s.transversions > 0 ? s.transitions / s.transversions : null;
  return s;
}
