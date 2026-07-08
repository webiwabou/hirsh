import { describe, expect, it } from "vitest";
import {
  chartToSvg,
  renderResultsReportHtml,
  volcanoToSvg,
  type ResultsReportInput,
} from "../src/results/report.js";
import type { VolcanoData } from "../src/results/parsers.js";

const VOLCANO: VolcanoData = {
  points: [
    { x: 3, y: 3, cls: "up" },
    { x: -2.5, y: 2, cls: "down" },
    { x: 0.1, y: 0.2, cls: "ns" },
  ],
  alpha: 0.05,
  lfcThreshold: 1,
  plotted: 3,
  up: 1,
  down: 1,
};

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

describe("volcanoToSvg", () => {
  it("draws a circle per point and threshold guides, coloured by class", () => {
    const svg = volcanoToSvg(VOLCANO);
    expect(svg).toMatch(/^<svg /);
    expect((svg.match(/<circle /g) ?? []).length).toBe(3);
    expect((svg.match(/<line /g) ?? []).length).toBe(5); // 3 guides + 2 axes
    expect(svg).toContain("#dc2626"); // up colour
    expect(svg).toContain("#2563eb"); // down colour
    expect(svg).toContain("log2 fold-change");
    expect(svg).toContain("up 1");
  });

  it("returns empty string for no points", () => {
    expect(volcanoToSvg({ ...VOLCANO, points: [] })).toBe("");
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

  it("embeds volcano figures when provided", () => {
    const withVolcano = renderResultsReportHtml({
      ...BASE,
      volcanoFigures: [{ title: "tumor vs normal — volcano", data: VOLCANO }],
    });
    expect(withVolcano).toContain("tumor vs normal — volcano");
    expect((withVolcano.match(/<circle /g) ?? []).length).toBe(3);
  });

  it("escapes HTML in the interpretation prose", () => {
    const html2 = renderResultsReportHtml({ ...BASE, summaryText: "1 < 2 & <b>bold</b>" });
    expect(html2).toContain("1 &lt; 2 &amp; &lt;b&gt;bold&lt;/b&gt;");
    expect(html2).not.toContain("<b>bold</b>");
  });
});
