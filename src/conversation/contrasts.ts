/**
 * Proposing differential-expression contrasts (Phase 6 — scientific dialogue).
 *
 * nf-core/differentialabundance needs a `contrasts` CSV (id,variable,reference,
 * target) naming the comparisons to test — the step a scientist most often gets
 * stuck on. From the condition samplesheet Hirsh already has, it proposes those
 * contrasts: each non-control group compared against the detected control
 * (untreated/vehicle/WT/normal…), or, if no control is recognizable, each group
 * against the first as a reference (flagged as an assumption). Pure and
 * unit-tested; the scientist always reviews before it runs.
 */
import { detectControlGroup, reviewSamplesheetContent } from "./samplesheetReview.js";

export interface Contrast {
  id: string;
  variable: string;
  reference: string;
  target: string;
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
}

/**
 * Proposes contrasts for a grouping variable. Uses the given/detected control as
 * the reference (each other group as a target vs it); with no control, the first
 * group alphabetically is the reference. Pure.
 */
export function proposeContrasts(
  variable: string,
  groups: string[],
  control?: string | null,
): Contrast[] {
  const uniq = [...new Set(groups.map((g) => g.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (uniq.length < 2) return [];
  const ctrl = control && uniq.includes(control) ? control : detectControlGroup(uniq);
  const reference = ctrl ?? uniq[0];
  return uniq
    .filter((g) => g !== reference)
    .map((target) => ({
      id: `${sanitizeId(target)}_vs_${sanitizeId(reference)}`,
      variable,
      reference,
      target,
    }));
}

/** Renders contrasts as the differentialabundance `contrasts` CSV. Pure. */
export function contrastsCsv(contrasts: Contrast[]): string {
  const rows = contrasts.map((c) => `${c.id},${c.variable},${c.reference},${c.target}`);
  return ["id,variable,reference,target", ...rows].join("\n") + "\n";
}

export interface ProposedContrasts {
  variable: string;
  contrasts: Contrast[];
  /** True when no control was recognizable and the reference was assumed. */
  assumedReference: boolean;
}

/**
 * Proposes contrasts from a condition samplesheet's CSV text, using its grouping
 * column. Returns null when there is no usable grouping column or fewer than two
 * groups. Pure.
 */
export function proposeContrastsFromSheet(csvText: string): ProposedContrasts | null {
  const design = reviewSamplesheetContent(csvText);
  if (!design.groupColumn || design.groupCounts.length < 2) return null;
  const groups = design.groupCounts.map((g) => g.group);
  const control = detectControlGroup(groups);
  const contrasts = proposeContrasts(design.groupColumn, groups, control);
  if (contrasts.length === 0) return null;
  return { variable: design.groupColumn, contrasts, assumedReference: control === null };
}
