import { describe, expect, it } from "vitest";
import {
  addRun,
  emptyMemory,
  extractReferences,
  knownReferences,
  relevantRuns,
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

describe("addRun", () => {
  it("prepends newest-first and keeps the version", () => {
    const a = addRun(emptyMemory(), run({ pipeline: "a" }));
    const b = addRun(a, run({ pipeline: "b" }));
    expect(b.runs.map((r) => r.pipeline)).toEqual(["b", "a"]);
    expect(b.version).toBe(1);
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
