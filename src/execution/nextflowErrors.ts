/**
 * Understanding Nextflow / nf-core failures well enough to self-correct.
 *
 * nf-core's schema validation fails with lines like:
 *   * --clustering_tool (mmseqs): Expected any of [[linclust, cluster]]
 * Rather than just report that and re-run the same doomed command, Hirsh parses
 * these so it can offer to fix the offending parameter to a valid value. Pure.
 */

export interface InvalidParam {
  /** Parameter name without the leading `--`. */
  param: string;
  /** The rejected value. */
  value: string;
  /** The allowed values, in order. */
  allowed: string[];
}

const INVALID_RE = /--([\w.]+)\s*\(([^)]*)\):\s*Expected any of \[+(.*?)\]+/g;

/**
 * Extracts the invalid-enum parameters from a Nextflow error text (nf-core schema
 * validation). Returns [] when the failure isn't of this recognizable kind. Pure.
 */
export function parseInvalidParams(errorText: string): InvalidParam[] {
  const out: InvalidParam[] = [];
  const seen = new Set<string>();
  for (const m of errorText.matchAll(INVALID_RE)) {
    const param = m[1];
    if (seen.has(param)) continue;
    const allowed = m[3]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (allowed.length === 0) continue;
    seen.add(param);
    out.push({ param, value: m[2].trim(), allowed });
  }
  return out;
}
