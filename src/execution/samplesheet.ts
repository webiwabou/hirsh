/**
 * Samplesheet construction.
 *
 * Helps Phase C: lists FASTQ files in a directory, infers R1/R2 pairs and sample
 * names by convention, and writes the final CSV. The agent confirms with the
 * user before writing anything.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { createGunzip } from "node:zlib";

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

// --- Content-based ingestion (recognize sequences regardless of extension) ---

export type SequenceFormat = "fastq" | "fasta";

/**
 * Recognizes FASTA/FASTQ from a decompressed text head. Pure. Distinguishes
 * FASTQ (4-line records; the 3rd line starts with "+") from a SAM file, which
 * also starts with "@" but has no "+" separator line.
 */
export function classifySequenceText(head: string): SequenceFormat | null {
  const lines = head.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim().length > 0);
  if (idx === -1) return null;
  const first = lines[idx];
  if (first.startsWith(">")) return "fasta";
  if (first.startsWith("@")) {
    const third = lines[idx + 2];
    return third !== undefined && third.startsWith("+") ? "fastq" : null;
  }
  return null;
}

const BINARY_MAGICS: Array<{ magic: number[]; label: string }> = [
  { magic: [0x42, 0x41, 0x4d, 0x01], label: "BAM" }, // "BAM\1"
  { magic: [0x89, 0x48, 0x44, 0x46], label: "HDF5 (fast5)" }, // \x89HDF
];

/** Detects a few well-known binary sequence formats by magic bytes. Pure. */
export function detectBinaryMagic(bytes: Uint8Array): string | null {
  for (const { magic, label } of BINARY_MAGICS) {
    if (magic.every((b, i) => bytes[i] === b)) return label;
  }
  const ascii4 = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (ascii4 === "CRAM") return "CRAM";
  return null;
}

/**
 * The canonical, pipeline-friendly name for a content-detected sequence file,
 * preserving the base name (which carries any R1/R2 index) and choosing the
 * extension from the detected format + whether it is gzipped. Pure.
 */
export function canonicalSequenceName(
  original: string,
  format: SequenceFormat,
  gzipped: boolean,
): string {
  let base = original;
  if (/\.gz$/i.test(base)) base = base.replace(/\.gz$/i, "");
  base = base.replace(/\.[^.]+$/, "");
  if (base === "") base = original;
  const ext = format === "fasta" ? ".fasta" : ".fastq";
  return `${base}${ext}${gzipped ? ".gz" : ""}`;
}

function readHead(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function isGzip(b: Uint8Array): boolean {
  return b[0] === 0x1f && b[1] === 0x8b;
}

/** Decompresses just the prefix of a gzip buffer, tolerating a truncated member. */
async function gunzipHead(comp: Buffer, maxOut = 65536): Promise<string> {
  return new Promise((res) => {
    const gz = createGunzip();
    const chunks: Buffer[] = [];
    let len = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      res(Buffer.concat(chunks).toString("utf8"));
    };
    gz.on("data", (d: Buffer) => {
      chunks.push(d);
      len += d.length;
      if (len >= maxOut) {
        gz.destroy();
        finish();
      }
    });
    gz.on("end", finish);
    gz.on("error", finish); // truncated member → use what we decoded
    gz.end(comp);
  });
}

export interface SniffResult {
  format: SequenceFormat | null;
  gzipped: boolean;
  /** A reason string when the file is a recognized-but-unsupported format. */
  unsupported?: string;
}

/** Recognizes a sequence file by content (not extension); reads only the head. */
export async function sniffSequenceFile(path: string): Promise<SniffResult> {
  let head: Buffer;
  try {
    head = readHead(path, 131072);
  } catch {
    return { format: null, gzipped: false, unsupported: "unreadable" };
  }
  const magic = detectBinaryMagic(head);
  if (magic) return { format: null, gzipped: false, unsupported: magic };
  if (isGzip(head)) {
    const text = await gunzipHead(head);
    return { format: classifySequenceText(text), gzipped: true };
  }
  if (head.includes(0)) return { format: null, gzipped: false, unsupported: "binary" };
  return { format: classifySequenceText(head.toString("utf8")), gzipped: false };
}

export interface SequenceScanEntry {
  file: string;
  format: SequenceFormat;
  gzipped: boolean;
}

export interface SequenceScan {
  dir: string;
  sequences: SequenceScanEntry[];
  /** Files that looked like an unsupported (e.g. binary/aligned) format. */
  unsupported: Array<{ file: string; reason: string }>;
}

/** Scans a directory recognizing FASTQ/FASTA by content, ignoring extensions. */
export async function scanSequenceDir(dir: string): Promise<SequenceScan> {
  const abs = resolve(dir);
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return { dir: abs, sequences: [], unsupported: [] };
  }
  const sequences: SequenceScanEntry[] = [];
  const unsupported: Array<{ file: string; reason: string }> = [];
  for (const name of names.sort()) {
    const full = join(abs, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    const s = await sniffSequenceFile(full);
    if (s.format) sequences.push({ file: full, format: s.format, gzipped: s.gzipped });
    else if (s.unsupported) unsupported.push({ file: full, reason: s.unsupported });
  }
  return { dir: abs, sequences, unsupported };
}

export interface LinkResult {
  dir: string;
  linked: Array<{ from: string; to: string }>;
  failed: string[];
}

/**
 * Creates canonical `.fastq(.gz)` / `.fasta(.gz)` symlinks in `linkDir` for
 * content-detected files, so the pipeline (and its own name checks) accept them.
 * It links, never rewriting the sequence data. Best-effort per file.
 */
export function linkCanonicalSequences(entries: SequenceScanEntry[], linkDir: string): LinkResult {
  const abs = resolve(linkDir);
  mkdirSync(abs, { recursive: true });
  const linked: Array<{ from: string; to: string }> = [];
  const failed: string[] = [];
  const used = new Set<string>();
  for (const e of entries) {
    const name = canonicalSequenceName(basename(e.file), e.format, e.gzipped);
    let target = join(abs, name);
    let i = 1;
    while (used.has(target) || existsSync(target)) {
      const dot = name.indexOf(".");
      const stem = dot === -1 ? name : name.slice(0, dot);
      const rest = dot === -1 ? "" : name.slice(dot);
      target = join(abs, `${stem}_${i}${rest}`);
      i++;
    }
    used.add(target);
    try {
      symlinkSync(resolve(e.file), target);
      linked.push({ from: e.file, to: target });
    } catch {
      failed.push(e.file);
    }
  }
  return { dir: abs, linked, failed };
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

export interface ColumnSpec {
  name: string;
  required: boolean;
}

export interface ValidationReport {
  ok: boolean;
  rowCount: number;
  header: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Validates a user-supplied samplesheet against a pipeline's column spec.
 * Pure (text in, report out) so it can be unit-tested without disk.
 */
export function validateSamplesheetContent(text: string, columns: ColumnSpec[]): ValidationReport {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (lines.length === 0) {
    return { ok: false, rowCount: 0, header: [], errors: ["The samplesheet is empty."], warnings };
  }

  const header = lines[0].split(",").map((h) => h.trim());
  const rowCount = lines.length - 1;

  const known = new Set(columns.map((c) => c.name));
  for (const col of columns) {
    if (col.required && !header.includes(col.name)) {
      errors.push(`Missing required column "${col.name}".`);
    }
  }
  for (const h of header) {
    if (h && !known.has(h)) warnings.push(`Unexpected column "${h}" (will be ignored by the pipeline).`);
  }
  if (rowCount === 0) errors.push("The samplesheet has a header but no data rows.");

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length !== header.length) {
      warnings.push(`Row ${i} has ${cells.length} columns but the header has ${header.length}.`);
    }
  }

  return { ok: errors.length === 0, rowCount, header, errors, warnings };
}

/**
 * Sanity-checks a somatic (tumor/normal) design: each patient should have at
 * least one normal (status 0). Returns human-readable warnings.
 */
export function checkSomaticDesign(rows: Array<Record<string, string>>): string[] {
  const byPatient = new Map<string, Set<string>>();
  for (const row of rows) {
    const patient = row.patient ?? "";
    const set = byPatient.get(patient) ?? new Set<string>();
    set.add(row.status ?? "");
    byPatient.set(patient, set);
  }
  const warnings: string[] = [];
  for (const [patient, statuses] of byPatient) {
    if (!statuses.has("0")) {
      warnings.push(
        `Patient "${patient}" has no normal sample (status 0); somatic callers need a matched normal or will run tumor-only.`,
      );
    }
    if (!statuses.has("1")) {
      warnings.push(`Patient "${patient}" has no tumor sample (status 1).`);
    }
  }
  return warnings;
}
