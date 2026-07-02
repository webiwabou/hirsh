import { describe, expect, it } from "vitest";
import { inferPairs, type ScanResult } from "../src/execution/samplesheet.js";

function scan(files: string[]): ScanResult {
  return { dir: "/data", files };
}

describe("inferPairs", () => {
  it("pairs R1/R2 with the _R1_001 convention", () => {
    const pairs = inferPairs(scan(["sampleA_R1_001.fastq.gz", "sampleA_R2_001.fastq.gz"]));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].sample).toBe("sampleA");
    expect(pairs[0].fastq_1).toBe("/data/sampleA_R1_001.fastq.gz");
    expect(pairs[0].fastq_2).toBe("/data/sampleA_R2_001.fastq.gz");
  });

  it("pairs the _1/_2 convention", () => {
    const pairs = inferPairs(scan(["s_1.fq.gz", "s_2.fq.gz"]));
    expect(pairs[0].fastq_2).toBe("/data/s_2.fq.gz");
  });

  it("treats an unmatched file as single-end", () => {
    const pairs = inferPairs(scan(["solo_R1.fastq.gz"]));
    expect(pairs[0].sample).toBe("solo");
    expect(pairs[0].fastq_2).toBeUndefined();
  });

  it("groups multiple samples and sorts them", () => {
    const pairs = inferPairs(
      scan(["b_R1_001.fastq.gz", "a_R1_001.fastq.gz", "a_R2_001.fastq.gz"]),
    );
    expect(pairs.map((p) => p.sample)).toEqual(["a", "b"]);
  });
});
