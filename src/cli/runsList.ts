/**
 * `hirsh runs` — list the runs recorded in the workspace.
 *
 * Each run directory under the workdir carries a `run_manifest.json` (written by
 * the provenance step). This scans them and renders a compact table — date,
 * pipeline, status, directory — so a scientist can see a project's history at a
 * glance. Summary/formatting are pure (manifests in, rows/string out) and
 * unit-tested; `listRuns` does the directory scan.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RunEntry {
  dir: string;
  date: string;
  pipeline: string;
  status: string;
  outdir?: string;
}

interface ManifestLike {
  createdAt?: string;
  pipeline?: { name?: string; revision?: string };
  outdir?: string;
  execution?: { executed?: boolean; exitCode?: number };
}

/** Derives the run status label from a manifest's execution block. Pure. */
export function runStatus(m: ManifestLike): string {
  const e = m.execution ?? {};
  if (!e.executed) return "prepared (not run)";
  if (e.exitCode === 0) return "completed";
  return `failed (exit ${e.exitCode ?? "?"})`;
}

/** Summarizes one run manifest into a table row. Pure. */
export function summarizeRun(dir: string, m: ManifestLike): RunEntry {
  const name = m.pipeline?.name ?? "(unknown)";
  const rev = m.pipeline?.revision ? ` ${m.pipeline.revision}` : "";
  return {
    dir,
    date: (m.createdAt ?? "").replace("T", " ").slice(0, 19) || "(no date)",
    pipeline: name + rev,
    status: runStatus(m),
    outdir: m.outdir,
  };
}

/** Renders run entries (already sorted) as an aligned table. Pure. */
export function formatRunsTable(entries: RunEntry[]): string {
  if (entries.length === 0) return "No runs found in this workspace yet.";
  const col = (s: string, w: number) => s.padEnd(w);
  const dateW = Math.max(4, ...entries.map((e) => e.date.length));
  const pipeW = Math.max(8, ...entries.map((e) => e.pipeline.length));
  const statusW = Math.max(6, ...entries.map((e) => e.status.length));
  const header = `${col("DATE", dateW)}  ${col("PIPELINE", pipeW)}  ${col("STATUS", statusW)}  DIRECTORY`;
  const rows = entries.map(
    (e) => `${col(e.date, dateW)}  ${col(e.pipeline, pipeW)}  ${col(e.status, statusW)}  ${e.dir}`,
  );
  return [header, ...rows].join("\n");
}

/**
 * Scans a workdir for run directories with a `run_manifest.json`, newest first.
 * Best-effort: unreadable/invalid manifests are skipped.
 */
export function listRuns(workdir: string): RunEntry[] {
  if (!existsSync(workdir)) return [];
  const entries: RunEntry[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(workdir);
  } catch {
    return [];
  }
  for (const name of dirs) {
    const dir = join(workdir, name);
    const manifestPath = join(dir, "run_manifest.json");
    try {
      if (!statSync(dir).isDirectory() || !existsSync(manifestPath)) continue;
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestLike;
      entries.push(summarizeRun(dir, m));
    } catch {
      /* skip unreadable/invalid manifest */
    }
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}
