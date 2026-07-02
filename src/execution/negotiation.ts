/**
 * Infrastructure negotiation (Phase 3).
 *
 * When the local machine can't comfortably run a pipeline, Hirsh shouldn't just
 * refuse — it should offer concrete alternatives with a rough feasibility, time
 * and cost for each, and a clear recommendation: cap and run slower here, move to
 * an HPC cluster, or burst to the cloud.
 *
 * Estimates are deliberately rough and labeled as such — the goal is to help the
 * scientist choose a path, not to promise an exact figure.
 */

export type OptionKind = "cap-local" | "cluster" | "cloud" | "abort";

export type Feasibility = "ok" | "risky" | "infeasible";

export interface InfraOption {
  kind: OptionKind;
  label: string;
  feasibility: Feasibility;
  /** Rough runtime characterization. */
  time?: string;
  /** Rough cost note. */
  cost?: string;
  /** One or two sentences of detail. */
  detail: string;
}

export interface NegotiationInput {
  /** "adapt" = only cappable steps overflow; "refuse" = a hard floor is exceeded. */
  verdict: "adapt" | "refuse";
  availableMemoryGB: number;
  /** Memory the heaviest (active) step / the pipeline really wants, in GB. */
  requiredMemoryGB: number;
  /** Name of the limiting step, if known. */
  limitingStep?: string;
}

export interface NegotiationResult {
  options: InfraOption[];
  /** Index into `options` of the recommended path. */
  recommendedIndex: number;
  summary: string;
}

/** Rough AWS on-demand memory-optimized rate, US$ per GB of RAM per hour. */
const CLOUD_USD_PER_GB_HOUR = 0.013;
/** Typical upper bound of a single HPC node's RAM (GB) for the cluster path. */
const TYPICAL_HPC_NODE_GB = 512;

function roundUp(n: number): number {
  return Math.ceil(n);
}

/**
 * Produces the ranked set of infrastructure options and a recommendation.
 * `cap-local` is only a real option under an "adapt" verdict (cappable steps);
 * under "refuse" it is marked infeasible.
 */
export function negotiateInfrastructure(input: NegotiationInput): NegotiationResult {
  const req = roundUp(input.requiredMemoryGB);
  const avail = Math.floor(input.availableMemoryGB);
  const stepName = input.limitingStep ? `"${input.limitingStep}"` : "the heaviest step";
  const perHour = Math.max(0.05, req * CLOUD_USD_PER_GB_HOUR);

  const capLocal: InfraOption = {
    kind: "cap-local",
    label: `Cap and run locally (${avail} GB)`,
    feasibility: input.verdict === "adapt" ? "risky" : "infeasible",
    time: "slower — limited RAM can bottleneck heavy steps",
    cost: "free (your own hardware)",
    detail:
      input.verdict === "adapt"
        ? `Cap Nextflow to ${avail} GB. The steps with a hard memory floor fit; ${stepName} ` +
          "will run within the cap (slower)."
        : `${stepName} needs ~${req} GB and can't be reduced, so capping to ${avail} GB would ` +
          "run out of memory. Not a real option here.",
  };

  const cluster: InfraOption = {
    kind: "cluster",
    label: "Move to an HPC cluster (Slurm/SGE/LSF/PBS)",
    feasibility: req <= TYPICAL_HPC_NODE_GB ? "ok" : "risky",
    time: "often fastest — runs on a large node and parallelizes",
    cost: "usually free (institutional allocation)",
    detail:
      `Submit to a scheduler queue with a node that has ≥${req} GB. ` +
      (req <= TYPICAL_HPC_NODE_GB
        ? "Well within a typical HPC node."
        : `${req} GB is large even for HPC — check a high-memory queue.`),
  };

  const cloud: InfraOption = {
    kind: "cloud",
    label: "Burst to the cloud (AWS Batch)",
    feasibility: "ok",
    time: "hours, plus provisioning; scales to the job",
    cost: `~$${perHour.toFixed(2)}/hour for a ≥${req} GB node (rough AWS on-demand; total depends on runtime)`,
    detail:
      `Provision a ≥${req} GB instance on demand. Needs an AWS account, a Batch job ` +
      "queue and an S3 work directory.",
  };

  const abort: InfraOption = {
    kind: "abort",
    label: "Don't run now",
    feasibility: "ok",
    detail: "Stop here; nothing is executed. The command and inputs remain prepared.",
  };

  const options = [capLocal, cluster, cloud, abort];

  // Recommendation: cap locally when it's genuinely viable (adapt); otherwise a
  // cluster if the requirement fits a typical node, else the cloud.
  let recommendedIndex: number;
  if (input.verdict === "adapt") {
    recommendedIndex = 0; // cap-local
  } else if (req <= TYPICAL_HPC_NODE_GB) {
    recommendedIndex = 1; // cluster
  } else {
    recommendedIndex = 2; // cloud
  }

  const summary =
    input.verdict === "adapt"
      ? `This machine (~${avail} GB) is below what ${stepName} wants (~${req} GB), but the ` +
        "shortfall is in cappable steps. Here's how you could run it:"
      : `${stepName} needs ~${req} GB and this machine has ~${avail} GB, so it won't run here ` +
        "as-is. Here are concrete alternatives:";

  return { options, recommendedIndex, summary };
}
