import { describe, expect, it } from "vitest";
import {
  buildEnaFileReportUrl,
  formatBytes,
  isEnaResolvable,
  parseEnaFileReport,
  summarizeRunMetadata,
} from "../src/execution/fetchngsMetadata.js";

// A realistic ENA filereport response (as returned by the Portal API, TSV).
const TSV = [
  "run_accession\tsample_title\tscientific_name\tlibrary_strategy\tlibrary_layout\tread_count\tfastq_bytes",
  "SRR390728\tB cell lymphoma\tHomo sapiens\tRNA-Seq\tPAIRED\t7178576\t101304405;101858469",
  "SRR390729\tB cell lymphoma\tHomo sapiens\tRNA-Seq\tPAIRED\t5000000\t80000000;80000000",
].join("\n");

describe("buildEnaFileReportUrl", () => {
  it("builds a read_run TSV filereport URL for an accession", () => {
    const url = buildEnaFileReportUrl("SRP009053");
    expect(url).toContain("https://www.ebi.ac.uk/ena/portal/api/filereport?");
    expect(url).toContain("accession=SRP009053");
    expect(url).toContain("result=read_run");
    expect(url).toContain("format=tsv");
  });
});

describe("parseEnaFileReport", () => {
  it("parses runs, summing paired fastq_bytes into one total per run", () => {
    const rows = parseEnaFileReport(TSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      run: "SRR390728",
      title: "B cell lymphoma",
      organism: "Homo sapiens",
      strategy: "RNA-Seq",
      layout: "PAIRED",
      reads: 7178576,
      bytes: 101304405 + 101858469,
    });
  });

  it("tolerates reordered columns (maps by header name)", () => {
    const reordered = [
      "scientific_name\trun_accession\tread_count",
      "Mus musculus\tSRR1\t42",
    ].join("\n");
    const rows = parseEnaFileReport(reordered);
    expect(rows[0]).toMatchObject({ run: "SRR1", organism: "Mus musculus", reads: 42 });
    expect(rows[0].bytes).toBeUndefined();
  });

  it("returns nothing for empty or header-only input", () => {
    expect(parseEnaFileReport("")).toEqual([]);
    expect(parseEnaFileReport("run_accession\tread_count")).toEqual([]);
  });
});

describe("summarizeRunMetadata", () => {
  it("aggregates runs, reads, bytes and distinct organism/strategy/layout", () => {
    const s = summarizeRunMetadata(parseEnaFileReport(TSV));
    expect(s.runs).toBe(2);
    expect(s.totalReads).toBe(7178576 + 5000000);
    expect(s.totalBytes).toBe(101304405 + 101858469 + 80000000 + 80000000);
    expect(s.hasBytes).toBe(true);
    expect(s.organisms).toEqual(["Homo sapiens"]);
    expect(s.strategies).toEqual(["RNA-Seq"]);
    expect(s.layouts).toEqual(["PAIRED"]);
  });

  it("reports hasBytes=false when no size is known", () => {
    const s = summarizeRunMetadata([{ run: "SRR1", reads: 10 }]);
    expect(s.hasBytes).toBe(false);
    expect(s.totalBytes).toBe(0);
  });
});

describe("isEnaResolvable", () => {
  it("accepts SRA/ENA/DDBJ kinds and rejects GEO/ArrayExpress", () => {
    expect(isEnaResolvable("run")).toBe(true);
    expect(isEnaResolvable("study")).toBe(true);
    expect(isEnaResolvable("bioproject")).toBe(true);
    expect(isEnaResolvable("geo-series")).toBe(false);
    expect(isEnaResolvable("geo-sample")).toBe(false);
    expect(isEnaResolvable("arrayexpress")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("renders human-readable base-1024 sizes", () => {
    expect(formatBytes(0)).toBe("unknown size");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
  });
});
