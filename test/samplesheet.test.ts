import { describe, expect, it } from "vitest";
import {
  checkSomaticDesign,
  inferPairs,
  validateSamplesheetContent,
  type ScanResult,
} from "../src/execution/samplesheet.js";

function scan(files: string[]): ScanResult {
  return { dir: "/data", files };
}

const sarekCols = [
  { name: "patient", required: true },
  { name: "sample", required: true },
  { name: "status", required: false },
  { name: "fastq_1", required: true },
  { name: "fastq_2", required: false },
];

describe("validateSamplesheetContent", () => {
  it("accepts a well-formed samplesheet", () => {
    const csv = "patient,sample,status,fastq_1,fastq_2\nP1,N1,0,a_1.fq.gz,a_2.fq.gz\n";
    const r = validateSamplesheetContent(csv, sarekCols);
    expect(r.ok).toBe(true);
    expect(r.rowCount).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it("flags a missing required column", () => {
    const csv = "sample,status,fastq_1\nN1,0,a_1.fq.gz\n";
    const r = validateSamplesheetContent(csv, sarekCols);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain('"patient"');
  });

  it("warns about unexpected columns and empty files", () => {
    const withExtra = validateSamplesheetContent("patient,sample,fastq_1,extra\nP,S,f,x\n", sarekCols);
    expect(withExtra.warnings.join(" ")).toContain("extra");
    const empty = validateSamplesheetContent("", sarekCols);
    expect(empty.ok).toBe(false);
  });
});

describe("checkSomaticDesign", () => {
  it("is quiet for a matched tumor/normal pair", () => {
    const rows = [
      { patient: "P1", sample: "N1", status: "0" },
      { patient: "P1", sample: "T1", status: "1" },
    ];
    expect(checkSomaticDesign(rows)).toEqual([]);
  });

  it("warns when a patient has no normal", () => {
    const rows = [{ patient: "P1", sample: "T1", status: "1" }];
    const w = checkSomaticDesign(rows).join(" ");
    expect(w).toContain("no normal");
  });
});

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
