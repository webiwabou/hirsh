import { describe, expect, it } from "vitest";
import {
  chartToSvg,
  renderResultsReportHtml,
  type ResultsReportInput,
} from "../src/results/report.js";

describe("chartToSvg", () => {
  it("renders a bar per item, scaled to the max, with escaped labels", () => {
    const svg = chartToSvg({
      title: "Library sizes",
      items: [
        { label: "S1", value: 100 },
        { label: "S2 <x>", value: 50 },
      ],
    });
    expect(svg).toMatch(/^<svg /);
    expect((svg.match(/<rect /g) ?? []).length).toBe(2);
    expect(svg).toContain("S2 &lt;x&gt;"); // label escaped
    expect(svg).toContain("100");
  });

  it("returns empty string for no items", () => {
    expect(chartToSvg({ title: "empty", items: [] })).toBe("");
  });
});

const BASE: ResultsReportInput = {
  pipelineName: "nf-core/rnaseq",
  pipelineTitle: "RNA-seq (gene expression)",
  query: { organism: "human", dataType: "RNA", objective: "find DEGs", experimentalDesign: "3 vs 3" },
  outdir: "/runs/rnaseq/results",
  outputs: [
    { path: "multiqc/report.html", description: "QC report", found: true, detail: "12 samples" },
    { path: "counts.tsv", description: "count matrix", found: false, detail: "" },
  ],
  charts: [{ title: "Library sizes", items: [{ label: "S1", value: 1000 }, { label: "S2", value: 2000 }] }],
  summaryText: "The run looks healthy.\n\nSample S2 has twice the depth of S1.",
  htmlReports: ["/runs/rnaseq/results/multiqc/report.html"],
  artifacts: [{ label: "Methods", path: "/runs/rnaseq/METHODS.md" }],
  generatedOn: "2026-07-07",
};

describe("renderResultsReportHtml", () => {
  const html = renderResultsReportHtml(BASE);

  it("is a self-contained HTML document with no external resource references", () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<style>");
    // No external scripts/stylesheets/images.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src=|<link/i);
  });

  it("includes the study metadata, prose (as paragraphs), figures and outputs", () => {
    expect(html).toContain("RNA-seq (gene expression)");
    expect(html).toContain("find DEGs");
    expect((html.match(/<p>/g) ?? []).length).toBeGreaterThanOrEqual(2); // two paragraphs
    expect(html).toContain("<svg "); // figure
    expect(html).toContain("counts.tsv");
    expect(html).toContain("not generated"); // missing output flagged
  });

  it("links the MultiQC report and artifacts", () => {
    expect(html).toContain('href="/runs/rnaseq/results/multiqc/report.html"');
    expect(html).toContain("METHODS.md");
  });

  it("escapes HTML in the interpretation prose", () => {
    const html2 = renderResultsReportHtml({ ...BASE, summaryText: "1 < 2 & <b>bold</b>" });
    expect(html2).toContain("1 &lt; 2 &amp; &lt;b&gt;bold&lt;/b&gt;");
    expect(html2).not.toContain("<b>bold</b>");
  });
});
