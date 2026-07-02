/**
 * Resource awareness.
 *
 * Compares what a pipeline typically needs against what the machine (or the
 * configured caps) can offer, and produces an honest verdict:
 *   - ok      → run as-is.
 *   - adapt   → the machine is below the recommended amount but above the hard
 *               floor; propose capping Nextflow to the available memory/CPUs and
 *               warn that it may be slower and that heavy steps might still fail.
 *   - refuse  → below the hard floor; the honest recommendation is NOT to run
 *               here (e.g. a 40 GB pipeline on a 2 GB machine).
 *
 * This is a first, deliberately simple model (whole-pipeline memory). Per-process
 * modeling is a roadmap item (see RECOMMENDATIONS.md).
 */
import { cpus, totalmem } from "node:os";

export interface MachineResources {
  cpus: number;
  memoryGB: number;
}

export interface PipelineResourceHints {
  /** Comfortable memory for a real run (largest step, e.g. genome indexing). */
  recommendedMemoryGB?: number;
  /** Hard floor below which the run is very unlikely to succeed. */
  minMemoryGB?: number;
  /** Comfortable CPU count for a real run. */
  recommendedCpus?: number;
}

export type ResourceVerdict = "ok" | "adapt" | "refuse";

export interface ResourceAssessment {
  verdict: ResourceVerdict;
  available: MachineResources;
  /** Human-readable explanation for the scientist (no jargon). */
  message: string;
  /** Caps to apply if adapting (Nextflow --max_memory / --max_cpus). */
  caps?: { maxMemory: string; maxCpus: number };
}

/** Detects the machine's total RAM (GB) and logical CPU count. */
export function detectMachine(): MachineResources {
  return {
    cpus: cpus().length,
    memoryGB: round1(totalmem() / 1024 ** 3),
  };
}

/**
 * Parses a memory value into GB. Accepts a plain number (GB) or nf-core-style
 * strings like "40.GB", "40 GB", "40G", "512.MB", "512MB".
 * Returns null if it cannot be parsed.
 */
export function parseMemoryToGB(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const m = /^\s*([\d.]+)\s*\.?\s*(g|gb|m|mb|t|tb)?\s*$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (Number.isNaN(n)) return null;
  const unit = (m[2] ?? "gb").toLowerCase();
  if (unit.startsWith("t")) return n * 1024;
  if (unit.startsWith("m")) return n / 1024;
  return n; // g / gb / default
}

/** Formats a GB number as an nf-core memory string, e.g. 30 → "30.GB". */
export function formatMemoryGB(gb: number): string {
  return `${Math.max(1, Math.floor(gb))}.GB`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Assesses a real (non-test) run. `available` is the usable budget: normally the
 * detected machine, or the configured caps if the user set lower ones.
 */
export function assessResources(
  hints: PipelineResourceHints,
  available: MachineResources,
): ResourceAssessment {
  const recommended = hints.recommendedMemoryGB;
  const floor = hints.minMemoryGB ?? (recommended ? recommended * 0.6 : undefined);

  // No hints declared: we cannot judge; allow but say so.
  if (recommended === undefined && floor === undefined) {
    return {
      verdict: "ok",
      available,
      message:
        `This machine has about ${available.memoryGB} GB of RAM and ${available.cpus} CPUs. ` +
        "No memory guidance is declared for this pipeline, so I can't pre-check it.",
    };
  }

  if (recommended !== undefined && available.memoryGB >= recommended) {
    return {
      verdict: "ok",
      available,
      message:
        `This machine has about ${available.memoryGB} GB of RAM and ${available.cpus} CPUs, ` +
        `which comfortably covers the ~${recommended} GB this pipeline typically wants.`,
    };
  }

  if (floor !== undefined && available.memoryGB < floor) {
    return {
      verdict: "refuse",
      available,
      message:
        `This pipeline usually needs around ${recommended ?? floor} GB of RAM, but this machine only ` +
        `has about ${available.memoryGB} GB — well below the ~${round1(floor)} GB floor. ` +
        "My honest recommendation is NOT to run it here; use a machine or cluster with more memory.",
    };
  }

  // Between floor and recommended → adaptable with caveats.
  return {
    verdict: "adapt",
    available,
    message:
      `This pipeline is happiest with ~${recommended} GB of RAM, but this machine has about ` +
      `${available.memoryGB} GB. It can often still run if I cap Nextflow to ${Math.floor(
        available.memoryGB,
      )} GB, though it may be slower and a heavy step (e.g. genome indexing) could still fail.`,
    caps: {
      maxMemory: formatMemoryGB(available.memoryGB),
      maxCpus: available.cpus,
    },
  };
}
