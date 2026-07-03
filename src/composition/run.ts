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
}

/** Builds the `nextflow run …` argument list for a composed pipeline. Pure. */
export function buildComposedRunCommand(opts: ComposedRunOptions): string[] {
  const args = ["run", opts.dir, "-profile", opts.engine];
  if (opts.input) args.push("--input", opts.input);
  args.push("--outdir", opts.outdir);
  for (const p of opts.refParams) args.push(`--${p.name}`, p.value);
  for (const c of opts.extraConfigs ?? []) args.push("-c", c);
  return args;
}
