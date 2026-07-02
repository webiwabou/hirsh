import { describe, expect, it } from "vitest";
import { buildManifest, renderProvenanceMarkdown, type ManifestInput } from "../src/execution/provenance.js";

const input: ManifestInput = {
  pipelineName: "nf-core/rnaseq",
  revision: "3.14.0",
  query: { organism: "mouse", dataType: "RNA short-read", objective: "DEGs", experimentalDesign: "treated vs control" },
  command: ["run", "nf-core/rnaseq", "-r", "3.14.0", "-profile", "test,docker", "-params-file", "params.yaml"],
  paramsFile: "/runs/x/params.yaml",
  params: { outdir: "/runs/x/results", aligner: "star_salmon" },
  samplesheet: "/runs/x/samplesheet.csv",
  outdir: "/runs/x/results",
  nextflowVersion: "version 25.10.4",
  containerEngine: "docker",
  machine: { cpus: 8, memoryGB: 32 },
  llmLabel: "ollama (llama3.1:8b)",
  executed: true,
  exitCode: 0,
  createdAt: "2026-07-02T00:00:00.000Z",
};

describe("buildManifest", () => {
  it("captures pipeline, command, env and execution status", () => {
    const m = buildManifest(input);
    expect(m.tool).toBe("hirsh");
    expect(m.pipeline).toEqual({ name: "nf-core/rnaseq", revision: "3.14.0" });
    expect(m.command).toBe("nextflow run nf-core/rnaseq -r 3.14.0 -profile test,docker -params-file params.yaml");
    expect(m.environment.containerEngine).toBe("docker");
    expect(m.environment.cpus).toBe(8);
    expect(m.environment.executor).toBe("local machine");
    expect(m.execution).toEqual({ executed: true, exitCode: 0 });
  });

  it("records a non-local executor when provided", () => {
    const m = buildManifest({ ...input, executor: "Slurm, queue \"short\"" });
    expect(m.environment.executor).toBe('Slurm, queue "short"');
    expect(renderProvenanceMarkdown(m)).toContain("Slurm");
  });
});

describe("renderProvenanceMarkdown", () => {
  const md = renderProvenanceMarkdown(buildManifest(input));
  it("is human-readable and includes the command and key facts", () => {
    expect(md).toContain("# Provenance — nf-core/rnaseq");
    expect(md).toContain("completed successfully");
    expect(md).toContain("nextflow run nf-core/rnaseq");
    expect(md).toContain("`aligner`: star_salmon");
    expect(md).toContain("mouse");
  });

  it("reflects a prepared-but-not-run state", () => {
    const md2 = renderProvenanceMarkdown(buildManifest({ ...input, executed: false, exitCode: undefined }));
    expect(md2).toContain("prepared but not executed");
  });
});
