/**
 * Data-grounded design review of the built samplesheet (Phase 6 — scientific
 * dialogue).
 *
 * The LLM design review (`designReview.ts`) reasons about what the scientist
 * *describes*. This complements it by reasoning about what the samplesheet
 * actually *contains*: it finds the grouping column (condition/treatment/status…),
 * counts biological replicates per group, and raises concrete, deterministic
 * concerns a statistician would — a group with no replication, the bare minimum
 * of two, or badly unbalanced groups. Pure (CSV text in, observations out) so it
 * is unit-tested and never guesses beyond the data.
 */
import type { DesignObservation } from "./designReview.js";

/** Column names that denote an experimental group/condition to compare. */
const GROUP_COLUMN_RE =
  /^(condition|group|treatment|genotype|status|timepoint|time_?point|dose|cohort|phenotype|cell_?type|tissue|sample_?group|class|label|disease|state|arm)$/i;

/** Group values that read as a control / reference level. */
const CONTROL_RE =
  /^(control|ctrl|untreated|vehicle|dmso|mock|wt|wild[\s_-]?type|wildtype|baseline|normal|reference|ref|healthy|placebo|naive|na[iï]ve|parental|uninfected|unstim(ulated)?|day[\s_-]?0|t0|d0|0h)$/i;

/**
 * The group that reads as the control/reference level (untreated, vehicle, WT,
 * normal, baseline…), or null if none is recognizable. Pure. Case-insensitive.
 */
export function detectControlGroup(groups: string[]): string | null {
  return groups.find((g) => CONTROL_RE.test(g.trim())) ?? null;
}

export interface GroupCount {
  group: string;
  replicates: number;
}

export interface SamplesheetDesign {
  /** The detected grouping column, or null if none is present. */
  groupColumn: string | null;
  /** Biological replicates per group (distinct sample ids), largest first. */
  groupCounts: GroupCount[];
  observations: DesignObservation[];
}

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((l) => l.split(",").map((c) => c.trim()));
  return { header, rows };
}

function detectGroupColumn(header: string[]): number {
  return header.findIndex((h) => GROUP_COLUMN_RE.test(h));
}

/**
 * Reviews a samplesheet's group structure. When no grouping column is present
 * (e.g. a plain rnaseq sample/fastq sheet, whose conditions are defined later in
 * a contrasts file), it returns no observations rather than guessing. Pure.
 */
export function reviewSamplesheetContent(
  text: string,
  opts: { recommendedReplicates?: number } = {},
): SamplesheetDesign {
  const recommended = opts.recommendedReplicates ?? 3;
  const { header, rows } = parseCsv(text);
  const groupIdx = detectGroupColumn(header);
  if (groupIdx === -1 || rows.length === 0) {
    return { groupColumn: null, groupCounts: [], observations: [] };
  }
  const sampleIdx = header.findIndex((h) => /^(sample|sample_?id|id)$/i.test(h));

  // Biological replicates = distinct sample ids per group (rows sharing a sample
  // id are technical replicates that get merged), falling back to row counts.
  const perGroup = new Map<string, Set<string>>();
  let rowOrder = 0;
  for (const row of rows) {
    const group = (row[groupIdx] ?? "").trim();
    if (group === "") continue;
    const sample = sampleIdx >= 0 ? (row[sampleIdx] ?? "").trim() : "";
    const key = sample || `__row_${rowOrder++}`;
    if (!perGroup.has(group)) perGroup.set(group, new Set());
    perGroup.get(group)!.add(key);
  }
  if (perGroup.size === 0) {
    return { groupColumn: header[groupIdx], groupCounts: [], observations: [] };
  }

  const groupCounts: GroupCount[] = [...perGroup.entries()]
    .map(([group, ids]) => ({ group, replicates: ids.size }))
    .sort((a, b) => b.replicates - a.replicates || a.group.localeCompare(b.group));

  const col = header[groupIdx];
  const observations: DesignObservation[] = [];

  // The facts, always surfaced so the scientist sees the real per-group counts.
  const summary = groupCounts.map((g) => `${g.group}=${g.replicates}`).join(", ");
  observations.push({
    severity: "info",
    topic: "replication",
    message: `Per-group replicate counts (by "${col}"): ${summary}.`,
  });

  if (groupCounts.length < 2) {
    observations.push({
      severity: "info",
      topic: "design",
      message: `Only one group ("${groupCounts[0].group}") is present in the samplesheet; any comparison groups must be defined elsewhere (e.g. a contrasts file).`,
    });
    return { groupColumn: col, groupCounts, observations };
  }

  const singles = groupCounts.filter((g) => g.replicates <= 1).map((g) => g.group);
  const twos = groupCounts.filter((g) => g.replicates === 2).map((g) => g.group);
  if (singles.length > 0) {
    observations.push({
      severity: "risk",
      topic: "replication",
      message: `Group(s) with no biological replication: ${singles.join(", ")} (n=1). Statistical tests can't estimate within-group variability, so calls involving them are unreliable.`,
      suggestion: `Add biological replicates (≥${recommended} per group is the usual recommendation).`,
    });
  }
  if (twos.length > 0) {
    observations.push({
      severity: "caution",
      topic: "replication",
      message: `Group(s) with only two replicates: ${twos.join(", ")} (n=2) — the practical minimum, so statistical power is low.`,
      suggestion: `Aim for ≥${recommended} replicates per group where feasible.`,
    });
  }

  const max = groupCounts[0].replicates;
  const min = groupCounts[groupCounts.length - 1].replicates;
  if (min >= 1 && max >= min * 3 && max - min >= 3) {
    observations.push({
      severity: "caution",
      topic: "balance",
      message: `Group sizes are unbalanced (largest ${max} vs smallest ${min}); this can bias comparisons and reduce power for the smaller group.`,
      suggestion: "Balance the groups where possible, or account for the imbalance in the analysis.",
    });
  }

  // No recognizable control/reference among the groups: differential comparisons
  // need a clear reference level, so flag it (gently — a valid design may just use
  // an unlabeled reference such as an early timepoint).
  if (detectControlGroup(groupCounts.map((g) => g.group)) === null) {
    observations.push({
      severity: "caution",
      topic: "controls",
      message: `None of the groups (${groupCounts.map((g) => g.group).join(", ")}) looks like a control/reference (e.g. untreated, vehicle, WT, normal).`,
      suggestion:
        "Make sure a reference level is defined for each comparison — add or identify a control group, or set the reference explicitly in the contrasts.",
    });
  }

  return { groupColumn: col, groupCounts, observations };
}
