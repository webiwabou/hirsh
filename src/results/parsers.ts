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

/** Counts variant records in VCF text (lines that are not headers/empty). */
export function countVcfRecords(text: string): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0 && !line.startsWith("#")) n++;
  }
  return n;
}
