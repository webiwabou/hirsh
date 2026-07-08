/**
 * Lint auto-fix planning (Phase 5 — local quality gate iterating toward green).
 *
 * Maps `nf-core lint` findings to the fixes Hirsh can make automatically, and
 * strips leftover template TODO markers. Pure (findings/text in, plan/text out)
 * so the decision logic is unit-tested without invoking the CLI; the state
 * machine applies the plan (re-package / strip TODOs) and re-lints in a bounded
 * loop, stopping when green or when the failure count stops improving.
 */

export interface LintFixPlan {
  /** Re-run packaging (idempotent): re-add missing standard files, patch manifest. */
  repackage: boolean;
  /** Strip `TODO nf-core:` markers left in generated files. */
  stripTodos: boolean;
}

/** Findings that packaging (files + manifest) can address. */
const REPACKAGE_RE =
  /(files?_exist|file not found|not found|missing|manifest|home_?page|author|nextflow_config|license|changelog|code_of_conduct|readme|docs\/|contributing|citation|editorconfig|gitattributes|gitignore|pull_request)/i;

/**
 * Decides which automatic fixes apply to a set of lint findings. Conservative:
 * only recognizes failures Hirsh actually knows how to fix; unknown findings
 * leave both flags false so the loop stops rather than spinning. Pure.
 */
export function planLintFixes(findings: string[]): LintFixPlan {
  let repackage = false;
  let stripTodos = false;
  for (const f of findings) {
    if (/todo/i.test(f)) stripTodos = true;
    if (REPACKAGE_RE.test(f)) repackage = true;
  }
  return { repackage, stripTodos };
}

/**
 * Removes lines carrying an nf-core template TODO marker (`TODO nf-core:`), which
 * `nf-core lint`'s pipeline_todos check flags. Returns the cleaned text and how
 * many lines were removed. Pure.
 */
export function stripNfCoreTodos(text: string): { text: string; removed: number } {
  const lines = text.split("\n");
  const kept = lines.filter((l) => !/TODO nf-core:/i.test(l));
  return { text: kept.join("\n"), removed: lines.length - kept.length };
}

/**
 * Whether the fix loop should continue: only when lint ran, there are still
 * failures, the count strictly improved over the previous round, and there is a
 * fix to apply. Pure — the loop guard, unit-tested.
 */
export function shouldContinueFixing(
  lint: { ran: boolean; failed?: number },
  previousFailed: number,
  plan: LintFixPlan,
): boolean {
  if (!lint.ran || lint.failed === undefined) return false;
  if (lint.failed === 0) return false; // green
  if (lint.failed >= previousFailed) return false; // no progress
  return plan.repackage || plan.stripTodos;
}
