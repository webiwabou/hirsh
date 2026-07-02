/**
 * Project memory (Phase 6).
 *
 * Persists past analyses across sessions so Hirsh behaves like a collaborator
 * that remembers a scientist's datasets, references and prior runs — not a
 * command builder that forgets everything each time. Stored locally and privately
 * (a JSON file under the user's home); can be disabled in config.
 *
 * The scoring/query logic is pure (data in, result out) for testing; only load/
 * save touch disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { QueryContext } from "../conversation/session.js";

export interface RunRecord {
  date: string; // ISO timestamp
  pipeline: string;
  revision?: string;
  organism?: string;
  dataType?: string;
  objective?: string;
  experimentalDesign?: string;
  samplesheet?: string;
  outdir?: string;
  /** A few reference values worth remembering (genome/fasta/gtf). */
  references?: Record<string, string>;
  engine?: string;
  executor?: string;
  executed: boolean;
  exitCode?: number;
}

export interface MemoryData {
  version: 1;
  runs: RunRecord[];
}

const MAX_RUNS = 200;
const REFERENCE_KEYS = ["genome", "fasta", "gtf", "gff", "bwa", "bwamem2", "star_index"];

export function emptyMemory(): MemoryData {
  return { version: 1, runs: [] };
}

export function defaultMemoryPath(): string {
  return join(homedir(), ".bioagent", "memory.json");
}

/** Extracts the reference-like params worth remembering from a param map. */
export function extractReferences(
  params: Record<string, string | number | boolean> | undefined,
): Record<string, string> | undefined {
  if (!params) return undefined;
  const refs: Record<string, string> = {};
  for (const key of REFERENCE_KEYS) {
    const v = params[key];
    if (typeof v === "string" && v.trim() !== "") refs[key] = v;
  }
  return Object.keys(refs).length > 0 ? refs : undefined;
}

/** Prepends a run record, keeping the list bounded (newest first). Pure. */
export function addRun(data: MemoryData, record: RunRecord): MemoryData {
  return { version: 1, runs: [record, ...data.runs].slice(0, MAX_RUNS) };
}

function norm(s?: string): string {
  return (s ?? "").trim().toLowerCase();
}

function overlaps(a?: string, b?: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x !== "" && y !== "" && (x.includes(y) || y.includes(x));
}

function tokenOverlap(a?: string, b?: string): number {
  const ax = new Set(norm(a).split(/\W+/).filter((w) => w.length > 3));
  const bx = norm(b).split(/\W+/).filter((w) => w.length > 3);
  return bx.filter((w) => ax.has(w)).length;
}

/** Scores how relevant a past run is to the current query. */
export function scoreRun(record: RunRecord, query: QueryContext): number {
  let score = 0;
  if (overlaps(record.organism, query.organism)) score += 2;
  if (overlaps(record.dataType, query.dataType)) score += 2;
  score += tokenOverlap(record.objective, query.objective);
  return score;
}

/** Returns the most relevant past runs for a query (score > 0), newest first. */
export function relevantRuns(data: MemoryData, query: QueryContext, limit = 3): RunRecord[] {
  return data.runs
    .map((r) => ({ r, s: scoreRun(r, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.r.date.localeCompare(a.r.date))
    .slice(0, limit)
    .map((x) => x.r);
}

/** Distinct reference values seen across past runs (for suggestions). */
export function knownReferences(data: MemoryData): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const run of data.runs) {
    for (const [k, v] of Object.entries(run.references ?? {})) {
      (out[k] ??= new Set()).add(v);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}

/** Loads memory from disk; returns empty memory if missing or unreadable. */
export function loadMemory(path: string): MemoryData {
  try {
    if (!existsSync(path)) return emptyMemory();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MemoryData;
    if (!parsed || !Array.isArray(parsed.runs)) return emptyMemory();
    return { version: 1, runs: parsed.runs };
  } catch {
    return emptyMemory();
  }
}

/** Writes memory to disk (best-effort; creates the directory). */
export function saveMemory(path: string, data: MemoryData): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}
