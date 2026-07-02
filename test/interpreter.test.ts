import { describe, expect, it } from "vitest";
import { summarizeResults, type ResultsReport } from "../src/results/interpreter.js";
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
