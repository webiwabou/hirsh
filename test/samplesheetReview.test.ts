import { describe, expect, it } from "vitest";
import {
  classifyBatchDesign,
  detectTechnicalReplicates,
  reviewSamplesheetContent,
} from "../src/conversation/samplesheetReview.js";

describe("reviewSamplesheetContent", () => {
  it("returns nothing when there is no grouping column (plain rnaseq sheet)", () => {
    const csv = "sample,fastq_1,fastq_2,strandedness\ns1,a_1.fq,a_2.fq,auto\ns2,b_1.fq,b_2.fq,auto";
    const d = reviewSamplesheetContent(csv);
    expect(d.groupColumn).toBeNull();
    expect(d.observations).toEqual([]);
  });

  it("counts biological replicates per group and surfaces the facts", () => {
    const csv = ["sample,fastq_1,condition", "t1,x,tumor", "t2,x,tumor", "t3,x,tumor", "n1,x,normal", "n2,x,normal", "n3,x,normal"].join("\n");
    const d = reviewSamplesheetContent(csv);
    expect(d.groupColumn).toBe("condition");
    expect(d.groupCounts).toEqual([
      { group: "normal", replicates: 3 },
      { group: "tumor", replicates: 3 },
    ]);
    const facts = d.observations.find((o) => o.topic === "replication" && o.severity === "info");
    expect(facts?.message).toMatch(/tumor=3/);
    // A balanced, well-replicated design raises no risk/caution.
    expect(d.observations.some((o) => o.severity !== "info")).toBe(false);
  });

  it("flags a group with no replication as a risk", () => {
    const csv = ["sample,condition", "a1,ctrl", "a2,ctrl", "a3,ctrl", "b1,treat"].join("\n");
    const d = reviewSamplesheetContent(csv);
    const risk = d.observations.find((o) => o.severity === "risk");
    expect(risk?.message).toMatch(/treat.*n=1/s);
    expect(risk?.suggestion).toMatch(/replicate/i);
  });

  it("flags a two-replicate group as a caution", () => {
    const csv = ["sample,group", "a1,A", "a2,A", "a3,A", "b1,B", "b2,B"].join("\n");
    const d = reviewSamplesheetContent(csv);
    expect(d.observations.some((o) => o.severity === "caution" && /two replicates/.test(o.message))).toBe(true);
  });

  it("merges technical replicates (same sample id) into one biological replicate", () => {
    // b appears twice (two lanes) → still one biological replicate for group B.
    const csv = ["sample,group", "a1,A", "a2,A", "a3,A", "b,B", "b,B"].join("\n");
    const d = reviewSamplesheetContent(csv);
    const b = d.groupCounts.find((g) => g.group === "B");
    expect(b?.replicates).toBe(1);
    expect(d.observations.some((o) => o.severity === "risk")).toBe(true);
  });

  it("notes merged technical replicates (lane merging) and names the sample", () => {
    // s1 sequenced across two lanes → merged into one biological replicate.
    const csv = [
      "sample,fastq_1,condition",
      "s1,s1_L1.fq,tumor", "s1,s1_L2.fq,tumor", "s2,s2.fq,tumor", "s3,s3.fq,tumor",
      "n1,n1.fq,normal", "n2,n2.fq,normal", "n3,n3.fq,normal",
    ].join("\n");
    const d = reviewSamplesheetContent(csv);
    expect(d.mergedSamples).toEqual([{ sample: "s1", group: "tumor", rows: 2 }]);
    const note = d.observations.find((o) => o.topic === "technical replicates");
    expect(note?.severity).toBe("info");
    expect(note?.message).toMatch(/s1 \(2 rows in condition "tumor"\)/);
    expect(note?.message).toMatch(/merges rows that share a sample id/);
  });

  it("notes lane merging even on a plain sheet with no grouping column", () => {
    const csv = ["sample,fastq_1,fastq_2", "s1,s1_L1_1.fq,s1_L1_2.fq", "s1,s1_L2_1.fq,s1_L2_2.fq", "s2,s2_1.fq,s2_2.fq"].join("\n");
    const d = reviewSamplesheetContent(csv);
    expect(d.groupColumn).toBeNull();
    const note = d.observations.find((o) => o.topic === "technical replicates");
    expect(note).toBeDefined();
    expect(note?.message).not.toMatch(/ in undefined /);
    expect(d.mergedSamples).toEqual([{ sample: "s1", group: "", rows: 2 }]);
  });

  it("says nothing about merging when every sample id is unique", () => {
    const csv = ["sample,condition", "a1,A", "a2,A", "b1,B", "b2,B"].join("\n");
    const d = reviewSamplesheetContent(csv);
    expect(d.mergedSamples).toEqual([]);
    expect(d.observations.some((o) => o.topic === "technical replicates")).toBe(false);
  });

  it("flags unbalanced groups", () => {
    const csv = ["sample,condition", ...Array.from({ length: 9 }, (_, i) => `a${i},A`), "b1,B", "b2,B", "b3,B"].join("\n");
    const d = reviewSamplesheetContent(csv);
    expect(d.observations.some((o) => o.topic === "balance")).toBe(true);
  });

  it("notes when only one group is present", () => {
    const csv = ["sample,condition", "a1,only", "a2,only"].join("\n");
    const d = reviewSamplesheetContent(csv);
    expect(d.observations.some((o) => /Only one group/.test(o.message))).toBe(true);
  });

  it("flags a batch confounded with the condition as a risk", () => {
    // Each batch holds a single condition → confounded.
    const csv = [
      "sample,condition,batch",
      "t1,treated,b1", "t2,treated,b1", "t3,treated,b1",
      "c1,control,b2", "c2,control,b2", "c3,control,b2",
    ].join("\n");
    const d = reviewSamplesheetContent(csv);
    const risk = d.observations.find((o) => o.topic === "batch effects" && o.severity === "risk");
    expect(risk?.message).toMatch(/confounded/);
  });

  it("recommends a batch covariate when batch crosses conditions", () => {
    const csv = [
      "sample,condition,batch",
      "t1,treated,b1", "t2,treated,b2", "t3,treated,b1",
      "c1,control,b1", "c2,control,b2", "c3,control,b2",
    ].join("\n");
    const d = reviewSamplesheetContent(csv);
    const caution = d.observations.find((o) => o.topic === "batch effects" && o.severity === "caution");
    expect(caution?.suggestion).toMatch(/covariate/);
  });
});

describe("detectTechnicalReplicates", () => {
  it("returns sample ids appearing on multiple rows, most rows first", () => {
    const merged = detectTechnicalReplicates(["a", "b", "a", "c", "a", "b"]);
    expect(merged).toEqual([
      { sample: "a", group: "", rows: 3 },
      { sample: "b", group: "", rows: 2 },
    ]);
  });

  it("ignores blank ids and returns nothing when all are unique", () => {
    expect(detectTechnicalReplicates(["a", "", "b", " ", "c"])).toEqual([]);
  });

  it("carries the group label through groupOf", () => {
    const merged = detectTechnicalReplicates(["s1", "s1"], new Map([["s1", "tumor"]]));
    expect(merged).toEqual([{ sample: "s1", group: "tumor", rows: 2 }]);
  });
});

describe("classifyBatchDesign", () => {
  it("detects confounded, crossed and indeterminate designs", () => {
    expect(
      classifyBatchDesign([
        { condition: "A", batch: "1" },
        { condition: "B", batch: "2" },
      ]),
    ).toBe("confounded");
    expect(
      classifyBatchDesign([
        { condition: "A", batch: "1" },
        { condition: "B", batch: "1" },
        { condition: "A", batch: "2" },
      ]),
    ).toBe("crossed");
    expect(classifyBatchDesign([{ condition: "A", batch: "1" }])).toBe("none");
  });
});
