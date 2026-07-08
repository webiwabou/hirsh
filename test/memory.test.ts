import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRun,
  defaultMemoryPath,
  emptyMemory,
  extractReferences,
  knownReferences,
  lastPeakMemoryFor,
  loadMemory,
  preferredEnvironment,
  relevantRuns,
  saveMemory,
  scoreRun,
  type RunRecord,
} from "../src/memory/store.js";

const run = (over: Partial<RunRecord>): RunRecord => ({
  date: "2026-06-01T00:00:00.000Z",
  pipeline: "nf-core/rnaseq",
  organism: "mouse",
  dataType: "RNA short-read",
  objective: "differentially expressed genes",
  executed: true,
  exitCode: 0,
  ...over,
});

describe("defaultMemoryPath", () => {
  it("is per-project under the workspace when a base dir is given", () => {
    expect(defaultMemoryPath("/home/sci/study-a")).toBe("/home/sci/study-a/.hirsh/memory.json");
  });
  it("falls back to the machine-global location without a base dir", () => {
    expect(defaultMemoryPath()).toMatch(/\.bioagent[/\\]memory\.json$/);
  });
});

describe("lastPeakMemoryFor", () => {
  it("returns the newest recorded peak for a pipeline, ignoring others/absent", () => {
    let m = emptyMemory();
    m = addRun(m, run({ pipeline: "nf-core/rnaseq", peakMemoryGB: 28 }));
    m = addRun(m, run({ pipeline: "nf-core/sarek", peakMemoryGB: 40 }));
    m = addRun(m, run({ pipeline: "nf-core/rnaseq", peakMemoryGB: 31 })); // newest rnaseq
    expect(lastPeakMemoryFor(m, "nf-core/rnaseq")).toBe(31);
    expect(lastPeakMemoryFor(m, "nf-core/atacseq")).toBeNull();
  });
  it("skips runs without a recorded peak", () => {
    const m = addRun(emptyMemory(), run({ pipeline: "nf-core/rnaseq" }));
    expect(lastPeakMemoryFor(m, "nf-core/rnaseq")).toBeNull();
  });
});

describe("addRun", () => {
  it("prepends newest-first and keeps the version", () => {
    const a = addRun(emptyMemory(), run({ pipeline: "a" }));
    const b = addRun(a, run({ pipeline: "b" }));
    expect(b.runs.map((r) => r.pipeline)).toEqual(["b", "a"]);
    expect(b.version).toBe(1);
  });

  it("preserves the consent flag across records", () => {
    const withConsent = { version: 1 as const, runs: [], consent: true };
    expect(addRun(withConsent, run({})).consent).toBe(true);
    expect(addRun({ version: 1, runs: [], consent: false }, run({})).consent).toBe(false);
    expect(addRun(emptyMemory(), run({})).consent).toBeUndefined();
  });
});

describe("memory consent persistence", () => {
  it("round-trips the consent flag through save/load", () => {
    const dir = mkdtempSync(join(tmpdir(), "hirsh-consent-"));
    const path = join(dir, "memory.json");
    try {
      saveMemory(path, { version: 1, runs: [run({})], consent: false });
      expect(loadMemory(path).consent).toBe(false);
      saveMemory(path, { version: 1, runs: [], consent: true });
      expect(loadMemory(path).consent).toBe(true);
      // A file without the field loads as undefined (not asked yet).
      expect(loadMemory(join(dir, "nope.json")).consent).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scoreRun / relevantRuns", () => {
  const data = {
    version: 1 as const,
    runs: [
      run({ pipeline: "nf-core/rnaseq", organism: "mouse", dataType: "RNA short-read", objective: "differentially expressed genes", date: "2026-05-01T00:00:00Z" }),
      run({ pipeline: "nf-core/sarek", organism: "human", dataType: "WGS", objective: "germline variants", date: "2026-05-02T00:00:00Z" }),
    ],
  };

  it("scores organism + dataType + objective overlap", () => {
    const q = { organism: "mouse", dataType: "RNA short-read", objective: "find differentially expressed genes" };
    expect(scoreRun(data.runs[0], q)).toBeGreaterThan(scoreRun(data.runs[1], q));
  });

  it("returns only relevant runs, most relevant first", () => {
    const q = { organism: "mouse", dataType: "RNA-seq", objective: "expressed genes" };
    const rel = relevantRuns(data, q, 3);
    expect(rel.length).toBe(1);
    expect(rel[0].pipeline).toBe("nf-core/rnaseq");
  });

  it("returns nothing for an unrelated query", () => {
    expect(relevantRuns(data, { organism: "zebrafish", dataType: "ATAC" }, 3)).toEqual([]);
  });
});

describe("preferredEnvironment", () => {
  it("returns nothing for empty memory", () => {
    expect(preferredEnvironment(emptyMemory())).toEqual({});
  });

  it("takes the most recent engine and executor (newest is first)", () => {
    const data = {
      version: 1 as const,
      runs: [
        run({ engine: "conda", executorName: "slurm", queue: "short" }),
        run({ engine: "docker", executorName: "local" }),
      ],
    };
    expect(preferredEnvironment(data)).toEqual({ engine: "conda", executor: "slurm", queue: "short" });
  });

  it("falls through runs missing a field to the next one that has it", () => {
    const data = {
      version: 1 as const,
      runs: [
        run({ engine: undefined, executorName: undefined }),
        run({ engine: "mamba", executorName: "sge", queue: "all.q" }),
      ],
    };
    expect(preferredEnvironment(data)).toEqual({ engine: "mamba", executor: "sge", queue: "all.q" });
  });

  it("carries no queue when the remembered executor had none", () => {
    const data = { version: 1 as const, runs: [run({ engine: "docker", executorName: "local" })] };
    expect(preferredEnvironment(data)).toEqual({ engine: "docker", executor: "local", queue: undefined });
  });
});

describe("extractReferences / knownReferences", () => {
  it("keeps only reference-like params", () => {
    const refs = extractReferences({ genome: "GRCm39", fasta: "/ref/x.fa", outdir: "/results", aligner: "star" });
    expect(refs).toEqual({ genome: "GRCm39", fasta: "/ref/x.fa" });
  });

  it("returns undefined when there are no references", () => {
    expect(extractReferences({ outdir: "/results" })).toBeUndefined();
  });

  it("collects distinct references across runs", () => {
    const data = {
      version: 1 as const,
      runs: [run({ references: { genome: "GRCm39" } }), run({ references: { genome: "GRCh38" } })],
    };
    expect(knownReferences(data).genome.sort()).toEqual(["GRCh38", "GRCm39"]);
  });
});
