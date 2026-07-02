import { describe, expect, it } from "vitest";
import { buildMethods, parseSoftwareVersions } from "../src/results/methods.js";

const VERSIONS_YAML = `
FASTQC:
  fastqc: 0.12.1
STAR_ALIGN:
  star: 2.7.9a
  samtools: 1.16.1
SALMON_QUANT:
  salmon: 1.10.1
Workflow:
  nf-core/rnaseq: 3.14.0
  Nextflow: 23.10.0
`;

describe("parseSoftwareVersions", () => {
  it("flattens tools and drops Nextflow/Workflow/pipeline entries", () => {
    const tools = parseSoftwareVersions(VERSIONS_YAML, "nf-core/rnaseq");
    expect(tools).toEqual({
      fastqc: "0.12.1",
      star: "2.7.9a",
      samtools: "1.16.1",
      salmon: "1.10.1",
    });
    expect(tools.Nextflow).toBeUndefined();
  });

  it("returns an empty map on bad input", () => {
    expect(parseSoftwareVersions("::: not yaml :::")).toEqual({});
    expect(parseSoftwareVersions("")).toEqual({});
  });
});

describe("buildMethods", () => {
  const input = {
    pipelineName: "nf-core/rnaseq",
    revision: "3.14.0",
    nextflowVersion: "version 25.10.4 build 11173",
    containerEngine: "docker",
    organism: "mouse",
    dataType: "bulk RNA-seq",
    tools: { star: "2.7.9a", salmon: "1.10.1" },
    pipelineCitation: { text: "Patel H, et al. nf-core/rnaseq.", doi: "10.5281/zenodo.1400710" },
  };

  it("writes a paragraph with pinned versions, engine and tools", () => {
    const { paragraph } = buildMethods(input);
    expect(paragraph).toContain("nf-core/rnaseq pipeline (v3.14.0)");
    expect(paragraph).toContain("Nextflow (v25.10.4)"); // cleaned from "version … build …"
    expect(paragraph).toContain("docker containers");
    expect(paragraph).toContain("salmon (v1.10.1) and star (v2.7.9a)");
    expect(paragraph).toMatch(/^Mouse bulk RNA-seq data were processed/);
  });

  it("includes the pipeline, nf-core and Nextflow references with DOIs", () => {
    const { markdown } = buildMethods(input);
    expect(markdown).toContain("doi:10.5281/zenodo.1400710");
    expect(markdown).toContain("doi:10.1038/s41587-020-0439-x"); // nf-core
    expect(markdown).toContain("doi:10.1038/nbt.3820"); // Nextflow
  });

  it("describes conda as environments, not containers", () => {
    const { paragraph } = buildMethods({ ...input, containerEngine: "conda" });
    expect(paragraph).toContain("conda environments");
  });

  it("omits the tool sentence when no versions are available", () => {
    const { paragraph } = buildMethods({ ...input, tools: {} });
    expect(paragraph).not.toContain("The workflow used");
  });
});
