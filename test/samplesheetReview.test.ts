import { describe, expect, it } from "vitest";
import { reviewSamplesheetContent } from "../src/conversation/samplesheetReview.js";

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
});
