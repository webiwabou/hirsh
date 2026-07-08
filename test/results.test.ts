import { describe, expect, it } from "vitest";
import {
  countDifferential,
  countVcfRecords,
  extractVolcano,
  metricSeries,
  parseGeneralStats,
  parseTraceResources,
  prettyMetric,
  summarizeTable,
  summarizeVcf,
} from "../src/results/parsers.js";

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

describe("prettyMetric", () => {
  it("strips the MultiQC generalstats prefix and separators", () => {
    expect(prettyMetric("FastQC_mqc-generalstats-fastqc-percent_duplicates")).toBe("fastqc percent duplicates");
    expect(prettyMetric("percent_gc")).toBe("percent gc");
  });
});

describe("metricSeries", () => {
  it("builds one per-sample series per numeric, non-constant metric", () => {
    const g = parseGeneralStats(
      ["Sample\tpercent_gc\tpercent_dups\tflag", "s1\t45\t12\t1", "s2\t47\t15\t1", "s3\t50\t9\t1"].join("\n"),
    );
    const series = metricSeries(g);
    // "flag" is constant (all 1) → skipped; two varying metrics remain.
    expect(series.map((s) => s.title)).toEqual(["percent gc", "percent dups"]);
    expect(series[0].items).toEqual([
      { label: "s1", value: 45 },
      { label: "s2", value: 47 },
      { label: "s3", value: 50 },
    ]);
  });

  it("skips non-numeric metrics and honors the metric cap", () => {
    const g = parseGeneralStats(
      ["Sample\ttool\tm1\tm2", "s1\tstar\t1\t9", "s2\tbwa\t2\t8"].join("\n"),
    );
    const series = metricSeries(g, { maxMetrics: 1 });
    expect(series).toHaveLength(1);
    expect(series[0].title).toBe("m1"); // "tool" (non-numeric) skipped
  });
});

describe("countDifferential", () => {
  // DESeq2-style table: padj + log2FoldChange, with an NA (untested) row.
  const tsv = [
    "gene_id\tlog2FoldChange\tpvalue\tpadj",
    "G1\t2.5\t0.001\t0.01", // sig, up
    "G2\t-3.0\t0.002\t0.02", // sig, down
    "G3\t0.5\t0.2\t0.30", // not sig (padj high)
    "G4\t4.0\t0.04\t0.049", // sig, up (padj just under 0.05, |lfc|>1)
    "G5\t0.2\t0.001\t0.01", // padj sig but |lfc|<=1 → excluded
    "G6\t5.0\tNA\tNA", // untested
  ].join("\n");

  it("counts significant genes with padj + log2FC thresholds and up/down split", () => {
    const d = countDifferential(tsv);
    expect(d.padjColumn).toBe("padj");
    expect(d.lfcColumn).toBe("log2FoldChange");
    expect(d.total).toBe(6);
    expect(d.tested).toBe(5); // G6 has NA padj
    expect(d.significant).toBe(3); // G1, G2, G4 (G3 padj high, G5 low fold-change)
    expect(d.up).toBe(2); // G1, G4
    expect(d.down).toBe(1); // G2
  });

  it("recognizes alternative column names (FDR/logFC) in CSV", () => {
    const csv = ["id,logFC,FDR", "A,2,0.001", "B,0.1,0.001", "C,-3,0.2"].join("\n");
    const d = countDifferential(csv);
    expect(d.padjColumn).toBe("FDR");
    expect(d.lfcColumn).toBe("logFC");
    expect(d.significant).toBe(1); // only A (B fold-change too small, C not significant)
    expect(d.up).toBe(1);
  });

  it("respects custom thresholds", () => {
    const d = countDifferential(tsv, { alpha: 0.05, lfcThreshold: 0 });
    expect(d.significant).toBe(4); // now G5 (|lfc|>0) also counts
  });

  it("returns padjColumn null when it can't identify the p-value column", () => {
    const d = countDifferential("gene\tvalue\nA\t1\nB\t2");
    expect(d.padjColumn).toBeNull();
    expect(d.total).toBe(2);
    expect(d.significant).toBe(0);
  });
});

describe("extractVolcano", () => {
  const tsv = [
    "gene_id\tlog2FoldChange\tpadj",
    "A\t3.0\t0.001", // up (sig)
    "B\t-2.5\t0.01", // down (sig)
    "C\t0.2\t0.9", // ns (small fc, high padj)
    "D\t4.0\tNA", // dropped (NA padj)
    "E\t0.0\t0.001", // ns (fc below threshold)
  ].join("\n");

  it("classifies up/down/ns points and maps -log10(padj)", () => {
    const v = extractVolcano(tsv)!;
    expect(v).not.toBeNull();
    expect(v.up).toBe(1);
    expect(v.down).toBe(1);
    expect(v.plotted).toBe(4); // A,B,C,E (D dropped for NA)
    const up = v.points.find((p) => p.cls === "up")!;
    expect(up.x).toBe(3.0);
    expect(up.y).toBeCloseTo(3, 5); // -log10(0.001)
  });

  it("returns null without a fold-change column (a volcano needs it)", () => {
    expect(extractVolcano("gene\tpadj\nA\t0.01\nB\t0.2")).toBeNull();
  });

  it("keeps all significant points and down-samples ns to the cap", () => {
    const rows = ["gene\tlog2FoldChange\tpadj"];
    for (let i = 0; i < 50; i++) rows.push(`ns${i}\t0.1\t0.9`); // 50 ns
    rows.push("sig1\t5\t0.0001", "sig2\t-5\t0.0001"); // 2 sig
    const v = extractVolcano(rows.join("\n"), { cap: 10 })!;
    expect(v.points.length).toBe(10); // 2 sig + 8 sampled ns
    expect(v.up + v.down).toBe(2);
    expect(v.plotted).toBe(52);
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

describe("summarizeVcf", () => {
  const vcf = [
    "##fileformat=VCFv4.2",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER",
    "chr1\t100\t.\tA\tG\t.\tPASS", // SNP, transition (A>G)
    "chr1\t200\t.\tC\tA\t.\tPASS", // SNP, transversion (C>A)
    "chr1\t300\t.\tAT\tA\t.\tPASS", // deletion (indel)
    "chr1\t400\t.\tG\tGTT\t.\tPASS", // insertion (indel)
    "chr1\t500\t.\tAC\tGT\t.\tPASS", // MNP
    "chr1\t600\t.\tT\t<DEL>\t.\tPASS", // symbolic → other
    "chr1\t700\t.\tG\tA,T\t.\tPASS", // multi-allelic: G>A (ts) + G>T (tv)
  ].join("\n");

  it("classifies SNPs, indels, MNPs and computes Ts/Tv", () => {
    const s = summarizeVcf(vcf);
    expect(s.records).toBe(7);
    expect(s.snps).toBe(4); // A>G, C>A, and G>A + G>T from the multi-allelic
    expect(s.indels).toBe(2);
    expect(s.mnps).toBe(1);
    expect(s.other).toBe(1); // <DEL>
    expect(s.transitions).toBe(2); // A>G, G>A
    expect(s.transversions).toBe(2); // C>A, G>T
    expect(s.tstv).toBeCloseTo(1, 5);
  });

  it("returns null Ts/Tv when there are no transversions", () => {
    const s = summarizeVcf("#CHROM\tPOS\tID\tREF\tALT\nchr1\t1\t.\tA\tG");
    expect(s.snps).toBe(1);
    expect(s.tstv).toBeNull();
  });

  it("ignores headers and malformed lines", () => {
    expect(summarizeVcf("##only headers\n#CHROM\tPOS").records).toBe(0);
  });
});

describe("parseTraceResources", () => {
  const trace = [
    "task_id\tname\tstatus\texit\tpeak_rss",
    "1\tSTAR_ALIGN (sample1)\tCOMPLETED\t0\t28.5 GB",
    "2\tSTAR_ALIGN (sample2)\tCOMPLETED\t0\t31.2 GB",
    "3\tFASTQC (sample1)\tCOMPLETED\t0\t512 MB",
    "4\tSALMON\tCOMPLETED\t0\t2 GB",
  ].join("\n");

  it("reads peak RSS per process (max across tags) and the overall max", () => {
    const r = parseTraceResources(trace);
    expect(r.maxPeakRssGB).toBeCloseTo(31.2, 5);
    expect(r.processes[0].name).toBe("STAR_ALIGN");
    expect(r.processes[0].peakRssGB).toBeCloseTo(31.2, 5); // max of the two STAR tasks
    const fastqc = r.processes.find((p) => p.name === "FASTQC")!;
    expect(fastqc.peakRssGB).toBeCloseTo(0.5, 5); // 512 MB
  });

  it("returns nulls when the trace lacks the columns", () => {
    expect(parseTraceResources("task_id\tname\tstatus\n1\tX\tOK").maxPeakRssGB).toBeNull();
    expect(parseTraceResources("").maxPeakRssGB).toBeNull();
  });
});
