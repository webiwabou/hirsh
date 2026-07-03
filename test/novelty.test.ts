import { describe, expect, it } from "vitest";
import { renderNoveltyManifest, summarizeNovelty } from "../src/composition/novelty.js";
import type { ResolvedComposition } from "../src/composition/types.js";

const resolved = {
  plan: { pipelineName: "proteingraph", description: "x", steps: [] },
  sha: "abcdef1234567890",
  modules: [
    { name: "fastqc", local: false },
    { name: "bwa/mem", local: false },
    { name: "graphderive", local: true },
  ],
  localTools: [{ name: "graphderive", description: "Derive a graph from a structure" }],
} as unknown as ResolvedComposition;

describe("summarizeNovelty", () => {
  it("splits reused nf-core modules from new custom tools", () => {
    const s = summarizeNovelty(resolved);
    expect(s.reused).toEqual(["bwa/mem", "fastqc"]); // sorted, local excluded
    expect(s.custom).toEqual([{ name: "graphderive", description: "Derive a graph from a structure" }]);
    expect(s.pipelineName).toBe("proteingraph");
  });
});

describe("renderNoveltyManifest", () => {
  it("renders reused and new sections with a summary line", () => {
    const md = renderNoveltyManifest(summarizeNovelty(resolved));
    expect(md).toContain("# Novelty — proteingraph");
    expect(md).toContain("pinned @ abcdef1234"); // 10-char short sha
    expect(md).toContain("- fastqc");
    expect(md).toContain("**graphderive** — Derive a graph from a structure");
    expect(md).toContain("2 reused nf-core module(s), 1 new custom tool(s).");
  });

  it("says so when everything is reused (no custom tools)", () => {
    const md = renderNoveltyManifest({
      pipelineName: "p",
      sha: "deadbeef00",
      reused: ["fastqc"],
      custom: [],
    });
    expect(md).toContain("composed entirely of existing nf-core modules");
    expect(md).toContain("1 reused nf-core module(s), 0 new custom tool(s).");
  });
});
