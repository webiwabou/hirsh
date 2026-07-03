import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findHtmlReports,
  gatherResults,
  summarizeResults,
  type InterpretablePipeline,
  type ResultsReport,
} from "../src/results/interpreter.js";
import type { ChatOptions, ChatResponse, LLMProvider } from "../src/llm/provider.js";
import type { PipelineDefinition } from "../src/pipelines/types.js";

/** Captures the prompt passed to the LLM so we can assert on it. */
class CapturingProvider implements LLMProvider {
  readonly label = "mock";
  last?: ChatOptions;
  async healthCheck(): Promise<void> {}
  async chat(options: ChatOptions): Promise<ChatResponse> {
    this.last = options;
    return { text: "A brief summary.", toolCalls: [] };
  }
  userContent(): string {
    return this.last?.messages.find((m) => m.role === "user")?.content ?? "";
  }
  systemContent(): string {
    return this.last?.messages.find((m) => m.role === "system")?.content ?? "";
  }
}

const pipeline = { name: "nf-core/rnaseq", title: "RNA-seq" } as unknown as PipelineDefinition;
const query = { organism: "mouse", dataType: "RNA-seq", objective: "DEGs", experimentalDesign: "treated vs control, n=2" };
const report: ResultsReport = {
  outdir: "/out",
  outputs: [
    {
      output: { path: "star_salmon/salmon.merged.gene_counts.tsv", description: "gene counts", kind: "table" },
      absPath: "/out/x.tsv",
      found: true,
      detail: "20,000 rows x 6 columns.",
    },
  ],
  htmlReports: [],
};

describe("summarizeResults prompt", () => {
  it("injects pre-run design caveats to revisit", async () => {
    const p = new CapturingProvider();
    await summarizeResults(p, pipeline, query, report, () => {}, [
      "[batch effects] treatment confounded with processing date",
    ]);
    const user = p.userContent();
    expect(user).toContain("Design caveats flagged before the run");
    expect(user).toContain("treatment confounded with processing date");
    expect(user).toContain("20,000 rows"); // the concrete facts are included
    // system prompt asks it to revisit design caveats and give biological meaning
    expect(p.systemContent()).toMatch(/biologic/i);
    expect(p.systemContent()).toMatch(/caveat/i);
  });

  it("says so when there are no caveats", async () => {
    const p = new CapturingProvider();
    await summarizeResults(p, pipeline, query, report, () => {}, []);
    expect(p.userContent()).toContain("No design caveats were flagged");
  });
});

describe("gatherResults — differential-abundance follow-up", () => {
  let outdir: string;
  const followUp: InterpretablePipeline = {
    name: "nf-core/differentialabundance",
    title: "differential expression (DESeq2)",
    results: {
      outputs: [
        { path: "tables/differential", description: "per-contrast DE tables", kind: "de_table_dir" },
        { path: "report", description: "HTML report", kind: "directory" },
      ],
    },
  };

  beforeAll(() => {
    outdir = mkdtempSync(join(tmpdir(), "hirsh-de-"));
    mkdirSync(join(outdir, "tables", "differential"), { recursive: true });
    mkdirSync(join(outdir, "report"), { recursive: true });
    writeFileSync(
      join(outdir, "tables", "differential", "treated_vs_control.deseq2.results.tsv"),
      ["gene_id\tlog2FoldChange\tpadj", "G1\t2\t0.01", "G2\t-3\t0.02", "G3\t0.1\t0.9"].join("\n"),
    );
    writeFileSync(join(outdir, "report", "study.html"), "<html></html>");
  });
  afterAll(() => rmSync(outdir, { recursive: true, force: true }));

  it("counts significant genes per contrast in the DE tables directory", () => {
    const r = gatherResults(followUp, outdir);
    const de = r.outputs.find((o) => o.output.kind === "de_table_dir")!;
    expect(de.found).toBe(true);
    expect(de.detail).toContain("1 contrast(s)");
    expect(de.detail).toContain("2 significant gene(s) total"); // G1, G2
    expect(de.detail).toContain("1 up, 1 down");
  });

  it("finds the follow-up's HTML report", () => {
    expect(findHtmlReports(outdir)).toEqual([join(outdir, "report", "study.html")]);
  });
});
