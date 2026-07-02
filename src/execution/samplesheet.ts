/**
 * Samplesheet construction.
 *
 * Helps Phase C: lists FASTQ files in a directory, infers R1/R2 pairs and sample
 * names by convention, and writes the final CSV. The agent confirms with the
 * user before writing anything.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface FastqPair {
  sample: string;
  fastq_1: string;
  fastq_2?: string;
}

const FASTQ_RE = /\.(fastq|fq)(\.gz)?$/i;
// Captures the read index (1/2) in common conventions:
//   S1_R1_001.fastq.gz, S1_R1.fastq.gz, S1_1.fq.gz
const READ_IDX_RE = /(.*?)[._]R?([12])(?:_\d+)?\.(?:fastq|fq)(?:\.gz)?$/i;

export interface ScanResult {
  dir: string;
  files: string[];
}

/** Lists FASTQ files in the directory (non-recursive). */
export function scanFastqs(dir: string): ScanResult {
  const abs = resolve(dir);
  const entries = readdirSync(abs).filter((f) => {
    try {
      return statSync(join(abs, f)).isFile() && FASTQ_RE.test(f);
    } catch {
      return false;
    }
  });
  return { dir: abs, files: entries.sort() };
}

/**
 * Infers pairs/samples from file names. Files whose name does not match the
 * convention are treated as single-end (fastq_1 only).
 */
export function inferPairs(scan: ScanResult): FastqPair[] {
  const bySample = new Map<string, { r1?: string; r2?: string; single?: string }>();

  for (const file of scan.files) {
    const full = join(scan.dir, file);
    const m = READ_IDX_RE.exec(file);
    if (m) {
      const sample = m[1];
      const read = m[2];
      const entry = bySample.get(sample) ?? {};
      if (read === "1") entry.r1 = full;
      else entry.r2 = full;
      bySample.set(sample, entry);
    } else {
      const sample = basename(file).replace(FASTQ_RE, "");
      const entry = bySample.get(sample) ?? {};
      entry.single = full;
      bySample.set(sample, entry);
    }
  }

  const pairs: FastqPair[] = [];
  for (const [sample, e] of bySample) {
    if (e.r1) {
      pairs.push({ sample, fastq_1: e.r1, fastq_2: e.r2 });
    } else if (e.single) {
      pairs.push({ sample, fastq_1: e.single });
    }
  }
  return pairs.sort((a, b) => a.sample.localeCompare(b.sample));
}

/** Writes a CSV with the given header and rows. */
export function writeCsv(
  path: string,
  header: string[],
  rows: Array<Record<string, string>>,
): void {
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((h) => escapeCsv(row[h] ?? "")).join(","));
  }
  writeFileSync(resolve(path), lines.join("\n") + "\n", "utf8");
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Human-readable preview of a samplesheet to confirm with the user. */
export function previewCsv(header: string[], rows: Array<Record<string, string>>): string {
  const out = [header.join(" | ")];
  out.push(header.map(() => "---").join(" | "));
  for (const row of rows) {
    out.push(header.map((h) => row[h] ?? "").join(" | "));
  }
  return out.join("\n");
}
