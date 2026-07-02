import { describe, expect, it } from "vitest";
import { countVcfRecords, parseGeneralStats, summarizeTable } from "../src/results/parsers.js";

describe("summarizeTable", () => {
  const tsv = [
    "gene_id\tgene_name\tsampleA\tsampleB",
    "ENSG1\tGENE1\t10\t20",
    "ENSG2\tGENE2\t5\t7",
    "ENSG3\tGENE3\t0\t3",
  ].join("\n");

  it("counts rows/cols and treats id/name as non-numeric", () => {
    const s = summarizeTable(tsv);
    expect(s.rows).toBe(3);
    expect(s.cols).toBe(4);
    expect(s.numericColumns).toEqual(["sampleA", "sampleB"]);
  });

  it("computes per-sample column totals (library sizes)", () => {
    const s = summarizeTable(tsv);
    expect(s.columnSums.sampleA).toBe(15);
    expect(s.columnSums.sampleB).toBe(30);
  });

  it("handles CSV too", () => {
    const s = summarizeTable("id,x\nA,1\nB,2\n");
    expect(s.rows).toBe(2);
    expect(s.columnSums.x).toBe(3);
  });
});

describe("parseGeneralStats", () => {
  const txt = ["Sample\tpercent_gc\tpercent_dups", "s1\t45\t12", "s2\t47\t15"].join("\n");
  it("extracts samples and metrics", () => {
    const g = parseGeneralStats(txt);
    expect(g.sampleCount).toBe(2);
    expect(g.metrics).toEqual(["percent_gc", "percent_dups"]);
    expect(g.perSample[0]).toEqual({ sample: "s1", values: { percent_gc: "45", percent_dups: "12" } });
  });
});

describe("countVcfRecords", () => {
  it("counts non-header, non-empty lines", () => {
    const vcf = [
      "##fileformat=VCFv4.2",
      "#CHROM\tPOS\tID\tREF\tALT",
      "chr1\t100\t.\tA\tT",
      "chr1\t200\t.\tG\tC",
      "",
    ].join("\n");
    expect(countVcfRecords(vcf)).toBe(2);
  });
});
