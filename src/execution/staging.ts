/**
 * Container & data staging (Phase 3).
 *
 * Before a run, Hirsh estimates how much disk it will need — container/conda
 * image footprint, the input data, and the intermediate "work" files Nextflow
 * writes — compares it against the free space on the run filesystem, and warns
 * about disk pressure. It also picks a stable cache location so images/envs are
 * reused across runs (via NXF_SINGULARITY_CACHEDIR / NXF_CONDA_CACHEDIR).
 *
 * Pure estimation/assessment is separated from the filesystem probes for testing.
 */
import { stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContainerEngine } from "../config/types.js";

const GB = 1024 ** 3;

/** Nextflow keeps intermediate files; work data is roughly this × the inputs. */
export const WORK_MULTIPLIER = 3;

/** Rough image/env footprint by backend kind (GB), when the pipeline doesn't say. */
export function defaultImageFootprintGB(engine: ContainerEngine): number {
  if (engine === "conda" || engine === "mamba") return 6;
  return 12; // docker / singularity container images
}

export interface StagingNeedsInput {
  /** Rough container/conda image footprint (GB). */
  imagesGB: number;
  /** Total size of the input files (bytes). */
  inputBytes: number;
  /** Intermediate-data multiplier relative to inputs (default WORK_MULTIPLIER). */
  workMultiplier?: number;
}

export interface StagingEstimate {
  imagesGB: number;
  inputsGB: number;
  workGB: number;
  totalGB: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Estimates total disk needed for a run. Rough by design. */
export function estimateStagingNeeds(input: StagingNeedsInput): StagingEstimate {
  const inputsGB = input.inputBytes / GB;
  const workGB = inputsGB * (input.workMultiplier ?? WORK_MULTIPLIER);
  const imagesGB = input.imagesGB;
  return {
    imagesGB: round1(imagesGB),
    inputsGB: round1(inputsGB),
    workGB: round1(workGB),
    totalGB: round1(imagesGB + inputsGB + workGB),
  };
}

export type DiskLevel = "ok" | "tight" | "insufficient";

export interface DiskAssessment {
  level: DiskLevel;
  message: string;
}

/**
 * Compares free disk against the estimate:
 *   - insufficient: less free than the estimate.
 *   - tight: enough, but under a 1.5× safety margin.
 *   - ok: comfortable headroom.
 */
export function assessDiskPressure(freeGB: number, estimate: StagingEstimate): DiskAssessment {
  const need = estimate.totalGB;
  const free = round1(freeGB);
  if (free < need) {
    return {
      level: "insufficient",
      message:
        `This run needs roughly ${need} GB (images ${estimate.imagesGB} + inputs ` +
        `${estimate.inputsGB} + work ${estimate.workGB}) but only ~${free} GB is free. ` +
        "It will likely fail with a 'no space left' error partway through.",
    };
  }
  if (free < need * 1.5) {
    return {
      level: "tight",
      message:
        `Disk is tight: ~${free} GB free for an estimated ~${need} GB run. ` +
        "It should fit, but there's little margin — free some space or point the work " +
        "directory at a larger disk if you can.",
    };
  }
  return {
    level: "ok",
    message: `Disk looks fine: ~${free} GB free for an estimated ~${need} GB run.`,
  };
}

/** Stable cache root so images/envs are reused across runs. */
export function defaultCacheDir(): string {
  return join(homedir(), ".bioagent", "cache");
}

/**
 * Nextflow cache environment for the backend, so image/env downloads are shared.
 * Docker manages its own image store, so it needs nothing here.
 */
export function cacheEnvFor(engine: ContainerEngine, cacheDir: string): Record<string, string> {
  if (engine === "singularity") {
    return { NXF_SINGULARITY_CACHEDIR: join(cacheDir, "singularity") };
  }
  if (engine === "conda" || engine === "mamba") {
    return { NXF_CONDA_CACHEDIR: join(cacheDir, "conda") };
  }
  return {};
}

/** Free space (GB) on the filesystem holding `path`, or null if it can't be read. */
export async function getFreeDiskGB(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return round1((s.bavail * s.bsize) / GB);
  } catch {
    return null;
  }
}

/**
 * Extracts candidate file-path cells from samplesheet CSV text (skipping the
 * header row). A cell counts as a path if it names a data file or contains a
 * path separator. Pure, so it can be unit-tested.
 */
export function extractPathCells(csvText: string): string[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];
  const dataExt = /\.(fastq|fq|bam|cram|fasta|fa|fna|vcf|bed|gtf|gff|txt|tsv|csv)(\.gz)?$/i;
  const out = new Set<string>();
  for (const line of lines.slice(1)) {
    for (const cell of line.split(",")) {
      const v = cell.trim();
      if (!v) continue;
      if (dataExt.test(v) || v.includes("/")) out.add(v);
    }
  }
  return [...out];
}

/** True for remote references we shouldn't (and can't) stat locally. */
function isRemote(path: string): boolean {
  return /^(https?|ftp|s3|gs|az):\/\//i.test(path) || path.startsWith("s3://");
}

/**
 * Sums the sizes of local files at the given paths (bytes). Missing files and
 * remote URLs are skipped; never throws.
 */
export async function sumFileSizes(paths: string[]): Promise<number> {
  let total = 0;
  for (const p of paths) {
    if (!p || isRemote(p)) continue;
    try {
      const s = await stat(p);
      if (s.isFile()) total += s.size;
    } catch {
      /* skip unreadable/missing */
    }
  }
  return total;
}
