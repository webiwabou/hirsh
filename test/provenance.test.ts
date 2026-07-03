import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  readRunContainers,
  renderProvenanceMarkdown,
  type ManifestInput,
} from "../src/execution/provenance.js";
import { parseTraceContainers } from "../src/results/parsers.js";

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

  it("lists container images when captured, and says none otherwise", () => {
    const withImgs = renderProvenanceMarkdown(
      buildManifest({ ...input, containers: ["quay.io/biocontainers/fastqc:0.12.1--hdfd78af_0"] }),
    );
    expect(withImgs).toContain("## Container images");
    expect(withImgs).toContain("quay.io/biocontainers/fastqc:0.12.1--hdfd78af_0");
    expect(renderProvenanceMarkdown(buildManifest(input))).toContain("none recorded");
  });
});

describe("parseTraceContainers", () => {
  const trace = [
    "task_id\thash\tname\tstatus\tcontainer",
    "1\tab/cd\tFASTQC (s1)\tCOMPLETED\tquay.io/biocontainers/fastqc:0.12.1--hdfd78af_0",
    "2\tef/gh\tFASTP (s1)\tCOMPLETED\tquay.io/biocontainers/fastp:0.23.4--h5f740d0_0",
    "3\tij/kl\tFASTQC (s2)\tCOMPLETED\tquay.io/biocontainers/fastqc:0.12.1--hdfd78af_0", // dup
    "4\tmn/op\tCUSTOM\tCOMPLETED\t-", // conda / no container
  ].join("\n");

  it("returns distinct container images from the trace, excluding '-'", () => {
    expect(parseTraceContainers(trace)).toEqual([
      "quay.io/biocontainers/fastp:0.23.4--h5f740d0_0",
      "quay.io/biocontainers/fastqc:0.12.1--hdfd78af_0",
    ]);
  });

  it("returns [] when there is no container column", () => {
    expect(parseTraceContainers("task_id\tstatus\n1\tCOMPLETED")).toEqual([]);
  });
});

describe("readRunContainers", () => {
  let outdir: string;
  beforeAll(() => {
    outdir = mkdtempSync(join(tmpdir(), "hirsh-prov-"));
    mkdirSync(join(outdir, "pipeline_info"), { recursive: true });
    // An older and a newer trace; the newest (by name) should win.
    writeFileSync(
      join(outdir, "pipeline_info", "execution_trace_2026-07-01_00-00-00.txt"),
      "task_id\tcontainer\n1\told/image:1",
    );
    writeFileSync(
      join(outdir, "pipeline_info", "execution_trace_2026-07-02_00-00-00.txt"),
      "task_id\tcontainer\n1\tnew/image:2",
    );
  });
  afterAll(() => rmSync(outdir, { recursive: true, force: true }));

  it("reads containers from the most recent trace, [] when absent", () => {
    expect(readRunContainers(outdir)).toEqual(["new/image:2"]);
    expect(readRunContainers(join(outdir, "nope"))).toEqual([]);
  });
});
