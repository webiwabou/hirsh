/**
 * Novelty manifest (Phase 5 — provenance for novelty).
 *
 * A composed pipeline mixes reused nf-core building blocks with genuinely new
 * custom tools. This writes a single honest summary of what was reused vs what is
 * new, so a scientist (or a reviewer, or a future nf-core PR) can see the origin
 * of every step at a glance. Pure (data in, markdown out) so it is unit-tested.
 */
import type { ResolvedComposition } from "./types.js";

export interface NoveltySummary {
  pipelineName: string;
  sha: string;
  /** nf-core modules reused as-is (names). */
  reused: string[];
  /** New custom local tools (name + description). */
  custom: Array<{ name: string; description: string }>;
}

/** Extracts the reused-vs-new split from a resolved composition. Pure. */
export function summarizeNovelty(resolved: ResolvedComposition): NoveltySummary {
  const reused = resolved.modules.filter((m) => !m.local).map((m) => m.name).sort();
  const custom = (resolved.localTools ?? [])
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { pipelineName: resolved.plan.pipelineName, sha: resolved.sha, reused, custom };
}

/** Renders the novelty manifest as Markdown. Pure. */
export function renderNoveltyManifest(s: NoveltySummary): string {
  const shortSha = s.sha ? s.sha.slice(0, 10) : "(unknown)";
  const reusedBlock = s.reused.length
    ? s.reused.map((n) => `- ${n}`).join("\n")
    : "- (none)";
  const customBlock = s.custom.length
    ? s.custom.map((c) => `- **${c.name}** — ${c.description}`).join("\n")
    : "- (none) — this pipeline is composed entirely of existing nf-core modules.";

  return `# Novelty — ${s.pipelineName}

This pipeline was composed by Hirsh. It separates what was **reused** from
nf-core from what is **new** here, so the origin of every step is explicit.

## Reused from nf-core/modules (pinned @ ${shortSha})

${reusedBlock}

## New in this pipeline (custom tools, not from nf-core)

${customBlock}

## Summary

${s.reused.length} reused nf-core module(s), ${s.custom.length} new custom tool(s).
`;
}
