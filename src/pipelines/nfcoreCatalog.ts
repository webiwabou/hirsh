/**
 * Live nf-core pipeline catalog.
 *
 * Hirsh curates a handful of pipelines in depth (rnaseq, sarek, proteinfamilies),
 * but nf-core publishes ~100 production pipelines. A real bioinformatician, asked
 * about ATAC-seq or methylation, reaches for the *established* pipeline
 * (nf-core/atacseq, nf-core/methylseq) before assembling one from modules. This
 * module tracks the official catalog (https://nf-co.re/pipelines.json) so that,
 * when no curated pipeline fits, Hirsh can recommend the real existing pipeline
 * instead of jumping straight to composition.
 *
 * The parsing and ranking are pure (JSON in, data out) and unit-tested without
 * network. The catalog is cached on disk under ~/.bioagent/cache with a TTL,
 * since the pipeline list changes slowly.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const CATALOG_URL = "https://nf-co.re/pipelines.json";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week; the catalog moves slowly

export interface NfCorePipeline {
  /** Bare name, e.g. "atacseq". */
  name: string;
  /** Full nf-core identifier, e.g. "nf-core/atacseq". */
  fullName: string;
  description: string;
  /** nf-core topic tags, e.g. ["atac-seq", "chromatin-accessibility"]. */
  topics: string[];
  /** Latest stable release tag (excluding "dev"), or null if unreleased. */
  latestRelease: string | null;
  url: string;
  stargazers: number;
}

export interface RankedPipeline {
  pipeline: NfCorePipeline;
  score: number;
}

export class CatalogFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogFetchError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Picks the newest stable release tag from a workflow's release list. */
function latestStableRelease(releases: unknown): string | null {
  if (!Array.isArray(releases)) return null;
  // The API lists releases newest-first; skip the rolling "dev" tag.
  for (const r of releases) {
    if (!isRecord(r)) continue;
    const tag = typeof r.tag_name === "string" ? r.tag_name : "";
    if (tag && tag !== "dev") return tag;
  }
  return null;
}

/**
 * Parses the nf-core `pipelines.json` payload into a clean list. Drops archived
 * repositories (deprecated pipelines) so Hirsh never recommends a dead pipeline.
 * Pure.
 */
export function parseNfCoreCatalog(json: unknown): NfCorePipeline[] {
  const root = isRecord(json) ? json : {};
  const workflows = Array.isArray(root.remote_workflows) ? root.remote_workflows : [];
  const out: NfCorePipeline[] = [];
  for (const w of workflows) {
    if (!isRecord(w)) continue;
    if (w.archived === true) continue;
    const name = typeof w.name === "string" ? w.name : "";
    if (!name) continue;
    const topics = Array.isArray(w.topics)
      ? w.topics.filter((t): t is string => typeof t === "string")
      : [];
    out.push({
      name,
      fullName: typeof w.full_name === "string" ? w.full_name : `nf-core/${name}`,
      description: typeof w.description === "string" ? w.description.trim() : "",
      topics,
      latestRelease: latestStableRelease(w.releases),
      url: typeof w.html_url === "string" ? w.html_url : `https://nf-co.re/${name}`,
      stargazers: typeof w.stargazers_count === "number" ? w.stargazers_count : 0,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Ranks catalog pipelines by relevance to free-text intent terms. Name and topic
 * matches weigh most (they are the pipeline's identity), description matches less.
 * Pure and offline. Returns only positive-scoring pipelines, highest first.
 */
export function rankNfCorePipelines(
  catalog: NfCorePipeline[],
  terms: string[],
  limit = 5,
): RankedPipeline[] {
  const toks = [...new Set(terms.flatMap(tokenize))];
  if (toks.length === 0) return [];
  const scored: RankedPipeline[] = [];
  for (const pipeline of catalog) {
    const name = pipeline.name.toLowerCase();
    const topicHay = pipeline.topics.map((t) => t.toLowerCase());
    const descToks = new Set(tokenize(pipeline.description));
    let score = 0;
    for (const tok of toks) {
      if (name === tok) score += 6;
      else if (name.includes(tok)) score += 4;
      if (topicHay.some((t) => t === tok || t.replace(/[^a-z0-9]/g, "").includes(tok))) score += 4;
      if (descToks.has(tok)) score += 1;
    }
    // A released pipeline is runnable; nudge it above unreleased/dev-only repos.
    if (score > 0 && pipeline.latestRelease) score += 1;
    if (score > 0) scored.push({ pipeline, score });
  }
  scored.sort((a, b) => b.score - a.score || b.pipeline.stargazers - a.pipeline.stargazers);
  return scored.slice(0, limit);
}

function cacheFile(): string {
  const dir = resolve(homedir(), ".bioagent", "cache", "nf-core-pipelines");
  mkdirSync(dir, { recursive: true });
  return join(dir, "catalog.json");
}

function readFreshCache(path: string): NfCorePipeline[] | null {
  try {
    if (!existsSync(path)) return null;
    if (Date.now() - statSync(path).mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(readFileSync(path, "utf8")) as NfCorePipeline[];
  } catch {
    return null;
  }
}

/**
 * Fetches (and caches) the official nf-core pipeline catalog. Uses a fresh
 * on-disk cache when present; on a network failure with a stale cache, it falls
 * back to the stale copy rather than erroring — a slightly old list is far more
 * useful than none.
 */
export async function fetchNfCoreCatalog(): Promise<NfCorePipeline[]> {
  const path = cacheFile();
  const fresh = readFreshCache(path);
  if (fresh) return fresh;

  let json: unknown;
  try {
    const res = await fetch(CATALOG_URL);
    if (!res.ok) throw new CatalogFetchError(`nf-core catalog returned ${res.status}.`);
    json = await res.json();
  } catch (err) {
    // Fall back to any (even stale) cached copy before giving up.
    try {
      if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as NfCorePipeline[];
    } catch {
      /* ignore */
    }
    throw err instanceof CatalogFetchError
      ? err
      : new CatalogFetchError(
          `Could not reach the nf-core catalog: ${err instanceof Error ? err.message : String(err)}`,
        );
  }

  const catalog = parseNfCoreCatalog(json);
  try {
    writeFileSync(path, JSON.stringify(catalog), "utf8");
  } catch {
    /* cache is best-effort */
  }
  return catalog;
}

/**
 * Builds the command to run an arbitrary nf-core pipeline's bundled `test`
 * profile — a self-contained smoke run (nf-core ships test data with every
 * pipeline). This is the honest, runnable way to show a not-yet-curated pipeline
 * working, without needing to know its samplesheet columns. Pure.
 */
export function buildNfCoreTestRunCommand(opts: {
  pipeline: string;
  revision: string;
  engine: string;
  outdir: string;
  extraConfigs?: string[];
}): string[] {
  const cmd = [
    "run",
    opts.pipeline,
    "-r",
    opts.revision,
    "-profile",
    `test,${opts.engine}`,
    "--outdir",
    opts.outdir,
  ];
  for (const cfg of opts.extraConfigs ?? []) cmd.push("-c", cfg);
  return cmd;
}
