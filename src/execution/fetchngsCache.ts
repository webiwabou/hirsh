/**
 * Caching fetchngs downloads across runs (co-scientist milestone).
 *
 * Re-downloading the same accessions every session is slow and wasteful. Hirsh
 * keys a fetch by its accession set (and the target pipeline's samplesheet tag,
 * since the emitted samplesheet is shaped for that pipeline) and reuses a
 * previous download when the same key comes back. The key/path logic is pure and
 * unit-tested; the state machine does the filesystem check and reuse prompt.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Accession } from "./fetchngs.js";

/**
 * A stable cache key for a fetch: the sorted accession ids plus the pipeline tag
 * (a different tag reshapes the samplesheet, so it's a distinct cache entry).
 * Order-independent — the same accessions in any order hit the same entry. Pure.
 */
export function fetchngsCacheKey(accessions: Accession[], pipelineTag?: string): string {
  const ids = [...new Set(accessions.map((a) => a.id))].sort();
  const raw = `${ids.join(",")}|${pipelineTag ?? ""}`;
  return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

/** The cache directory for a fetch key (holds ids.csv + the fetchngs results). Pure. */
export function fetchngsCacheDir(baseDir: string, key: string): string {
  return join(baseDir, ".hirsh-cache", "fetchngs", key);
}
