/**
 * Real-run command for a freshly composed pipeline (try-before-you-publish).
 *
 * A composed project isn't in the curated registry, so it doesn't go through the
 * normal parameter machinery. This builds the `nextflow run <dir> …` command from
 * the scientist's samplesheet and any reference parameters. Pure and unit-tested.
 */

export interface ComposedRunParam {
  name: string;
  value: string;
}

export interface ComposedRunOptions {
  /** The generated project directory (Nextflow runs it as `nextflow run <dir>`). */
  dir: string;
  /** Container/conda profile, e.g. "docker". */
  engine: string;
  /** Samplesheet path for `--input`, if provided. */
  input?: string;
  outdir: string;
  /** Reference parameters the scientist supplied (`--<name> <value>`). */
  refParams: ComposedRunParam[];
  /** Extra `-c` config files (e.g. the executor config). */
  extraConfigs?: string[];
  /** Use the composed pipeline's `test` profile (placeholder data; no input needed). */
  test?: boolean;
}

/** A composed pipeline's samplesheet row (columns: sample,fastq_1,fastq_2). */
export interface ComposedSheetRow {
  sample: string;
  fastq_1: string;
  fastq_2: string;
}

/** A clean sample name from a file path (drops the extension and .gz). Pure. */
export function sampleNameFromPath(path: string): string {
  const base = (path.split("/").pop() ?? path).replace(/\.gz$/i, "").replace(/\.[^.]+$/, "");
  return base.replace(/[^A-Za-z0-9_.-]/g, "_") || "sample";
}

/**
 * Builds samplesheet rows (one per file) for a composed pipeline, pointing each
 * file at `fastq_1` — the generic input column the composed reader expects, so a
 * scientist can hand over a FASTA/FASTQ instead of writing a CSV by hand. Pure.
 */
export function composedRowsFromFiles(files: string[]): ComposedSheetRow[] {
  return files.map((f) => ({ sample: sampleNameFromPath(f), fastq_1: f, fastq_2: "" }));
}

/** Builds the `nextflow run …` argument list for a composed pipeline. Pure. */
export function buildComposedRunCommand(opts: ComposedRunOptions): string[] {
  const profile = opts.test ? `test,${opts.engine}` : opts.engine;
  const args = ["run", opts.dir, "-profile", profile];
  // The test profile provides its own input; a real run passes the samplesheet.
  if (!opts.test && opts.input) args.push("--input", opts.input);
  args.push("--outdir", opts.outdir);
  if (!opts.test) for (const p of opts.refParams) args.push(`--${p.name}`, p.value);
  for (const c of opts.extraConfigs ?? []) args.push("-c", c);
  return args;
}
