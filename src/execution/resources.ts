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
 * Two models are supported. The whole-pipeline model (recommendedMemoryGB /
 * minMemoryGB) is the coarse baseline. When a pipeline declares its heavy
 * `processes`, Hirsh uses a sharper per-process model: it can name *which* step
 * won't fit and distinguish a step whose memory can be capped down (slower) from
 * one with a hard floor (e.g. genome indexing) that would simply run out of
 * memory — turning a vague "maybe adapt" into a precise verdict.
 */
import { cpus, totalmem } from "node:os";

export interface MachineResources {
  cpus: number;
  memoryGB: number;
}

/**
 * A single heavy step in a pipeline. Modeling steps individually lets Hirsh point
 * at the real bottleneck instead of a single whole-pipeline number.
 */
export interface ProcessResourceHint {
  /** Plain-language step name, e.g. "genome indexing (STAR)". */
  name: string;
  /** Peak memory the step needs at human/reference scale (GB). */
  memoryGB: number;
  /** CPUs the step benefits from (optional, informational). */
  cpus?: number;
  /** One-line note on what the step does / why it's heavy. */
  note?: string;
  /**
   * Whether the step's memory can be capped lower and still succeed (just
   * slower). Steps with a hard floor tied to the reference/index size (genome
   * indexing, alignment) are NOT cappable — capping only makes them run out of
   * memory. Defaults to true (assume cappable unless stated).
   */
  cappable?: boolean;
  /**
   * Parameters whose presence means this step won't run — e.g. a prebuilt index
   * or an iGenomes key makes genome indexing unnecessary. When any of these is
   * provided, the step is excluded from the assessment (its memory floor no
   * longer applies).
   */
  skipIfParams?: string[];
}

export interface PipelineResourceHints {
  /** Comfortable memory for a real run (largest step, e.g. genome indexing). */
  recommendedMemoryGB?: number;
  /** Hard floor below which the run is very unlikely to succeed. */
  minMemoryGB?: number;
  /** Comfortable CPU count for a real run. */
  recommendedCpus?: number;
  /** Heavy steps, for the sharper per-process model. */
  processes?: ProcessResourceHint[];
}

export type ResourceVerdict = "ok" | "adapt" | "refuse";

export interface ResourceAssessment {
  verdict: ResourceVerdict;
  available: MachineResources;
  /** Human-readable explanation for the scientist (no jargon). */
  message: string;
  /** Caps to apply if adapting (Nextflow --max_memory / --max_cpus). */
  caps?: { maxMemory: string; maxCpus: number };
  /** The step driving the verdict, when the per-process model was used. */
  limitingStep?: string;
  /** Steps excluded because a prebuilt index/reference was provided. */
  skippedSteps?: string[];
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
 *
 * Uses the per-process model when the pipeline declares heavy `processes`;
 * otherwise falls back to the whole-pipeline memory model.
 */
export function assessResources(
  hints: PipelineResourceHints,
  available: MachineResources,
  providedParams?: Set<string>,
): ResourceAssessment {
  if (hints.processes && hints.processes.length > 0) {
    return assessProcesses(hints.processes, available, providedParams);
  }
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

/** The step wanting the most memory (drives the "comfortably covers" message). */
function peakProcess(processes: ProcessResourceHint[]): ProcessResourceHint {
  return processes.reduce((a, b) => (b.memoryGB > a.memoryGB ? b : a));
}

function isCappable(p: ProcessResourceHint): boolean {
  return p.cappable !== false;
}

/** True if a prebuilt index/reference param provided makes this step unnecessary. */
function isSkipped(p: ProcessResourceHint, provided?: Set<string>): boolean {
  if (!p.skipIfParams || !provided) return false;
  return p.skipIfParams.some((name) => provided.has(name));
}

/**
 * Per-process assessment: compares each heavy step against the memory budget.
 * Steps made unnecessary by a provided index/reference (`skipIfParams`) are
 * excluded first — a prebuilt genome index removes the indexing memory floor.
 *   - A step that exceeds the budget and can't be capped (hard floor, e.g. genome
 *     indexing) → refuse, naming that step.
 *   - Only cappable steps exceed the budget → adapt (cap and warn they'll be
 *     slower); non-cappable steps all fit.
 *   - Every step fits → ok.
 */
export function assessProcesses(
  processes: ProcessResourceHint[],
  available: MachineResources,
  providedParams?: Set<string>,
): ResourceAssessment {
  const budget = available.memoryGB;
  const skippedSteps = processes.filter((p) => isSkipped(p, providedParams)).map((p) => p.name);
  const active = processes.filter((p) => !isSkipped(p, providedParams));

  // Everything skipped (or nothing declared active): nothing heavy left to run.
  if (active.length === 0) {
    return {
      verdict: "ok",
      available,
      skippedSteps,
      message:
        `This machine has about ${available.memoryGB} GB of RAM and ${available.cpus} CPUs. ` +
        "The heaviest steps are skipped because a prebuilt reference/index was provided.",
    };
  }

  const peak = peakProcess(active);
  const overflow = active.filter((p) => p.memoryGB > budget);

  if (overflow.length === 0) {
    return {
      verdict: "ok",
      available,
      limitingStep: peak.name,
      skippedSteps,
      message:
        `This machine has about ${available.memoryGB} GB of RAM and ${available.cpus} CPUs, ` +
        `which covers every heavy step — the largest, ${peak.name}, needs about ${peak.memoryGB} GB.`,
    };
  }

  const blocking = overflow.filter((p) => !isCappable(p));
  if (blocking.length > 0) {
    // The largest blocking step is the honest headline.
    const worst = peakProcess(blocking);
    const others =
      blocking.length > 1 ? ` (and ${blocking.length - 1} other step(s) with a hard memory floor)` : "";
    return {
      verdict: "refuse",
      available,
      limitingStep: worst.name,
      skippedSteps,
      message:
        `The ${worst.name} step needs about ${worst.memoryGB} GB of RAM${
          worst.note ? ` — ${worst.note}` : ""
        } and can't be reduced${others}. This machine has about ${available.memoryGB} GB, so that ` +
        `step would run out of memory. My honest recommendation is NOT to run here; use a machine ` +
        `or cluster with at least ~${Math.ceil(worst.memoryGB)} GB.`,
    };
  }

  // Only cappable steps overflow → adaptable with caveats.
  const worst = peakProcess(overflow);
  return {
    verdict: "adapt",
    available,
    limitingStep: worst.name,
    skippedSteps,
    message:
      `Most steps fit, but ${worst.name} would like about ${worst.memoryGB} GB and this machine has ` +
      `around ${available.memoryGB} GB. That step's memory can be capped, so I can cap Nextflow to ` +
      `${Math.floor(budget)} GB and continue — it may be slower, but the steps with a hard memory ` +
      `floor all fit.`,
    caps: {
      maxMemory: formatMemoryGB(budget),
      maxCpus: available.cpus,
    },
  };
}
