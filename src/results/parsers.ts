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

export interface GeneralStats {
  sampleCount: number;
  metrics: string[];
  perSample: Array<{ sample: string; values: Record<string, string> }>;
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
  const padj =
    findColumn(header, (h) => PADJ_NAMES.has(h)) ??
    findColumn(header, (h) => h.includes("padj") || h.includes("adj.p") || h.includes("fdr") || h.includes("qvalue"));
  const lfc =
    findColumn(header, (h) => h === "log2foldchange" || h === "log2fc" || h === "logfc") ??
    findColumn(header, (h) => h.includes("log2fold") || h.includes("log2fc") || h.includes("logfc"));

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

/** Counts variant records in VCF text (lines that are not headers/empty). */
export function countVcfRecords(text: string): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0 && !line.startsWith("#")) n++;
  }
  return n;
}
