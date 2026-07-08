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
import { stringify as stringifyYaml } from "yaml";
import { detectControlGroup, reviewSamplesheetContent } from "./samplesheetReview.js";

export interface Contrast {
  id: string;
  variable: string;
  reference: string;
  target: string;
  /** Optional blocking factor / covariate (e.g. a crossed batch). */
  blocking?: string;
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
  blocking?: string | null,
): Contrast[] {
  const uniq = [...new Set(groups.map((g) => g.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (uniq.length < 2) return [];
  const ctrl = control && uniq.includes(control) ? control : detectControlGroup(uniq);
  const reference = ctrl ?? uniq[0];
  const block = blocking?.trim() || undefined;
  return uniq
    .filter((g) => g !== reference)
    .map((target) => ({
      id: `${sanitizeId(target)}_vs_${sanitizeId(reference)}`,
      variable,
      reference,
      target,
      ...(block ? { blocking: block } : {}),
    }));
}

/**
 * Renders contrasts as the differentialabundance `contrasts` CSV. Includes the
 * optional `blocking` column only when at least one contrast carries a blocking
 * factor. Pure.
 */
export function contrastsCsv(contrasts: Contrast[]): string {
  const withBlocking = contrasts.some((c) => c.blocking);
  const header = withBlocking ? "id,variable,reference,target,blocking" : "id,variable,reference,target";
  const rows = contrasts.map((c) => {
    const base = `${c.id},${c.variable},${c.reference},${c.target}`;
    return withBlocking ? `${base},${c.blocking ?? ""}` : base;
  });
  return [header, ...rows].join("\n") + "\n";
}

export interface ProposedContrasts {
  variable: string;
  contrasts: Contrast[];
  /** True when no control was recognizable and the reference was assumed. */
  assumedReference: boolean;
  /** Batch column added as a blocking factor (a crossed batch), or null. */
  blocking: string | null;
}

/**
 * Proposes contrasts from a condition samplesheet's CSV text, using its grouping
 * column — and, when a technical batch **crosses** the conditions, adds it as a
 * blocking factor so differentialabundance models it out. Returns null when there
 * is no usable grouping column or fewer than two groups. Pure.
 */
export function proposeContrastsFromSheet(csvText: string): ProposedContrasts | null {
  const design = reviewSamplesheetContent(csvText);
  if (!design.groupColumn || design.groupCounts.length < 2) return null;
  const groups = design.groupCounts.map((g) => g.group);
  const control = detectControlGroup(groups);
  // Only a *crossed* batch is a usable blocking factor; a confounded one is not.
  const blocking = design.batchDesign === "crossed" ? design.batchColumn : null;
  const contrasts = proposeContrasts(design.groupColumn, groups, control, blocking);
  if (contrasts.length === 0) return null;
  return { variable: design.groupColumn, contrasts, assumedReference: control === null, blocking };
}

// ---------------------------------------------------------------------------
// Interaction contrasts for a multi-factor (factorial) design.
//
// When the samplesheet crosses two experimental factors (e.g. genotype ×
// treatment), the scientific question is often the *interaction*: does the
// treatment effect differ by genotype? nf-core/differentialabundance supports
// this via its YAML contrasts form — a `formula` with an interaction term and a
// `make_contrasts_str` naming the interaction coefficient — which the CSV form
// can't express. Detection and proposal are pure and unit-tested; the scientist
// always reviews before it runs.
// ---------------------------------------------------------------------------

/** Column names that denote an experimental factor to model (mirrors samplesheetReview). */
const FACTOR_COLUMN_RE =
  /^(condition|group|treatment|genotype|status|timepoint|time_?point|dose|cohort|phenotype|cell_?type|tissue|sample_?group|class|label|disease|state|arm)$/i;
/** Technical batch columns — modelled as covariates, not interaction factors. */
const BATCH_COLUMN_RE =
  /^(batch|lane|run|run_?id|flow_?cell|flowcell|date|processing_?date|prep|library_?prep|seq_?run|sequencing_?run|center|centre|plate|pool)$/i;

export interface Factor {
  /** The samplesheet column. */
  column: string;
  /** Distinct levels, control/reference first, then the rest alphabetically. */
  levels: string[];
  /** The reference level (detected control, else the first level alphabetically). */
  reference: string;
  /** True when no control was recognizable and the reference was assumed. */
  assumedReference: boolean;
}

export interface InteractionContrast {
  id: string;
  /** R-style model formula with the interaction term, e.g. "~ genotype * treatment". */
  formula: string;
  /** The interaction coefficient to test, e.g. "genotypeKO.treatmentTreated". */
  makeContrastsStr: string;
}

export interface InteractionProposal {
  factorA: Factor;
  factorB: Factor;
  /** The interaction contrasts (one per non-reference level combination). */
  contrasts: InteractionContrast[];
  /** True when either factor's reference level was assumed. */
  assumedReference: boolean;
  /**
   * "full" when every factor-level cell has ≥2 biological replicates (interaction
   * is well powered); "partial" when some cell has a single replicate (the model
   * still fits a full-factorial design but interaction power is limited).
   */
  replication: "full" | "partial";
}

/**
 * Approximates R's `make.names` for a factor-level column name: characters R
 * can't use in a name become ".". Good enough for the simple identifier levels a
 * samplesheet normally carries (the caveat is stated to the scientist).
 */
function rColumnName(factor: string, level: string): string {
  return `${factor}${level}`.replace(/[^A-Za-z0-9._]/g, ".");
}

function orderLevels(levels: string[]): { ordered: string[]; reference: string; assumed: boolean } {
  const uniq = [...new Set(levels.map((l) => l.trim()).filter(Boolean))];
  const control = detectControlGroup(uniq);
  const rest = uniq.filter((l) => l !== control).sort((a, b) => a.localeCompare(b));
  const reference = control ?? rest[0];
  const ordered = control ? [control, ...rest] : rest;
  return { ordered, reference, assumed: control === null };
}

interface ParsedSheet {
  header: string[];
  rows: string[][];
  sampleIdx: number;
}

function parseSheet(csvText: string): ParsedSheet {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [], sampleIdx: -1 };
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((l) => l.split(",").map((c) => c.trim()));
  const sampleIdx = header.findIndex((h) => /^(sample|sample_?id|id)$/i.test(h));
  return { header, rows, sampleIdx };
}

/**
 * The experimental factor columns (≥2 distinct biological levels each), in
 * samplesheet column order. Batch/technical columns are excluded — they belong
 * in a model as covariates, not as interaction factors. Levels are counted over
 * distinct sample ids so technical replicates (shared id) don't inflate them.
 * Pure.
 */
export function detectFactors(csvText: string): Factor[] {
  const { header, rows, sampleIdx } = parseSheet(csvText);
  const factors: Factor[] = [];
  for (let idx = 0; idx < header.length; idx++) {
    const col = header[idx];
    if (!FACTOR_COLUMN_RE.test(col) || BATCH_COLUMN_RE.test(col)) continue;
    // Distinct levels by biological sample (merge technical replicates by id).
    const levelOf = new Map<string, string>();
    let rowOrder = 0;
    for (const row of rows) {
      const level = (row[idx] ?? "").trim();
      if (level === "") continue;
      const sample = sampleIdx >= 0 ? (row[sampleIdx] ?? "").trim() : "";
      const key = sample || `__row_${rowOrder++}`;
      if (!levelOf.has(key)) levelOf.set(key, level);
    }
    const levels = new Set(levelOf.values());
    if (levels.size < 2) continue;
    const { ordered, reference, assumed } = orderLevels([...levels]);
    factors.push({ column: col, levels: ordered, reference, assumedReference: assumed });
  }
  return factors;
}

/**
 * Biological replicates per (levelA, levelB) cell, keyed "a b", counting
 * distinct sample ids. Pure helper for crossing/replication checks.
 */
function cellCounts(csvText: string, colA: string, colB: string): Map<string, number> {
  const { header, rows, sampleIdx } = parseSheet(csvText);
  const a = header.indexOf(colA);
  const b = header.indexOf(colB);
  const perCell = new Map<string, Set<string>>();
  let rowOrder = 0;
  for (const row of rows) {
    const la = (row[a] ?? "").trim();
    const lb = (row[b] ?? "").trim();
    if (la === "" || lb === "") continue;
    const sample = sampleIdx >= 0 ? (row[sampleIdx] ?? "").trim() : "";
    const key = sample || `__row_${rowOrder++}`;
    const cell = `${la} ${lb}`;
    if (!perCell.has(cell)) perCell.set(cell, new Set());
    perCell.get(cell)!.add(key);
  }
  return new Map([...perCell.entries()].map(([k, ids]) => [k, ids.size]));
}

/**
 * Proposes interaction contrasts from a samplesheet with a crossed two-factor
 * design. Returns null unless there are ≥2 experimental factors whose first two
 * are **fully crossed** (every level combination is present) — an interaction is
 * only estimable then. One contrast per non-reference level pair (capped). Pure.
 */
export function proposeInteractionContrasts(csvText: string): InteractionProposal | null {
  const factors = detectFactors(csvText);
  if (factors.length < 2) return null;
  const [factorA, factorB] = factors;
  const counts = cellCounts(csvText, factorA.column, factorB.column);

  // Fully crossed: every level combination must appear at least once.
  for (const la of factorA.levels) {
    for (const lb of factorB.levels) {
      if (!counts.has(`${la} ${lb}`)) return null;
    }
  }
  const replication: "full" | "partial" = [...counts.values()].every((n) => n >= 2) ? "full" : "partial";

  const formula = `~ ${factorA.column} * ${factorB.column}`;
  const targetsA = factorA.levels.filter((l) => l !== factorA.reference);
  const targetsB = factorB.levels.filter((l) => l !== factorB.reference);
  const contrasts: InteractionContrast[] = [];
  for (const ta of targetsA) {
    for (const tb of targetsB) {
      if (contrasts.length >= 6) break; // keep the proposal reviewable
      contrasts.push({
        id: sanitizeId(`${factorA.column}_${factorA.reference}_${ta}_${factorB.column}_${factorB.reference}_${tb}`),
        formula,
        makeContrastsStr: `${rColumnName(factorA.column, ta)}.${rColumnName(factorB.column, tb)}`,
      });
    }
  }
  if (contrasts.length === 0) return null;
  return {
    factorA,
    factorB,
    contrasts,
    assumedReference: factorA.assumedReference || factorB.assumedReference,
    replication,
  };
}

/**
 * Renders differentialabundance's YAML contrasts file, mixing main-effect
 * comparisons and formula-based interaction contrasts (both are valid entries in
 * the same file). Emitted only when an interaction is included, since the CSV
 * form can't express a formula. Pure.
 */
export function contrastsYaml(main: Contrast[], interactions: InteractionContrast[]): string {
  const entries: unknown[] = [];
  for (const c of main) {
    const entry: Record<string, unknown> = {
      id: c.id,
      comparison: [c.variable, c.reference, c.target],
    };
    if (c.blocking) entry.blocking_factors = [c.blocking];
    entries.push(entry);
  }
  for (const c of interactions) {
    entries.push({ id: c.id, formula: c.formula, make_contrasts_str: c.makeContrastsStr });
  }
  // Force double-quoted string scalars: the formula starts with "~" (YAML's null
  // shorthand) and contains "*" (an alias indicator), which some parsers (R/Python)
  // could misread if left as a plain scalar. Keys stay plain for readability.
  return stringifyYaml({ contrasts: entries }, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" });
}
