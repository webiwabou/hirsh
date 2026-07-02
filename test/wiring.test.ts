import { describe, expect, it } from "vitest";
import { buildWorkflow, classifyKind } from "../src/composition/wiring.js";
import type { NfCoreModule } from "../src/modules/types.js";

function mod(
  name: string,
  inputs: NfCoreModule["inputs"],
  outputs: NfCoreModule["outputs"],
): NfCoreModule {
  return { name, path: `modules/nf-core/${name}`, description: "", keywords: [], tools: [], inputs, outputs };
}

const metaFile = (fileName: string, opts: { optional?: boolean } = {}) => ({
  elements: [
    { name: "meta", type: "map" },
    { name: fileName, type: "file", optional: opts.optional },
  ],
});

const fastqc = mod("fastqc", [metaFile("reads")], [
  { name: "html", elements: [{ name: "meta", type: "map" }, { name: "*.html", type: "file" }] },
  { name: "zip", elements: [{ name: "meta", type: "map" }, { name: "*.zip", type: "file" }] },
]);

const fastp = mod(
  "fastp",
  [metaFile("reads"), { elements: [{ name: "adapter_fasta", type: "string" }] }],
  [{ name: "reads", elements: [{ name: "meta", type: "map" }, { name: "*.fastq.gz", type: "file" }] }],
);

// Aligner needs reads + a reference index (comes from params).
const bwamem = mod(
  "bwa/mem",
  [metaFile("reads"), metaFile("index")],
  [{ name: "bam", elements: [{ name: "meta", type: "map" }, { name: "*.bam", type: "file" }] }],
);

const multiqc = mod(
  "multiqc",
  [
    { elements: [{ name: "multiqc_files", type: "file" }] },
    { elements: [{ name: "config", type: "file", optional: true }] },
  ],
  [{ name: "report", elements: [{ name: "*.html", type: "file" }] }],
);

describe("classifyKind", () => {
  it("maps names/patterns to canonical kinds", () => {
    expect(classifyKind("reads")).toBe("reads");
    expect(classifyKind("bam", "*.bam")).toBe("bam");
    expect(classifyKind("index")).toBe("index");
    expect(classifyKind("fasta", "*.fa")).toBe("fasta");
    expect(classifyKind("*.html")).toBe("report");
    expect(classifyKind("bai", "*.bai")).toBe("bam_index");
  });
});

describe("buildWorkflow (channel-type matching)", () => {
  const plan = {
    pipelineName: "align",
    steps: [{ module: "fastqc" }, { module: "fastp" }, { module: "bwa/mem" }, { module: "multiqc" }],
  };
  const res = buildWorkflow(plan, [fastqc, fastp, bwamem, multiqc]);
  const wf = res.workflow;

  it("feeds raw reads to the QC step without hijacking the data channel", () => {
    expect(wf).toContain("FASTQC ( ch_input )");
    expect(wf).toMatch(/FASTP \( ch_input,/);
  });

  it("passes trimmed reads (fastp output) into the aligner", () => {
    expect(wf).toContain("BWA_MEM ( FASTP.out.reads,");
  });

  it("wires an unavailable reference (index) to a pipeline param", () => {
    expect(res.referenceParams).toContain("index");
    expect(wf).toContain("file(params.index)");
  });

  it("collects report outputs into MultiQC", () => {
    expect(wf).toContain("ch_multiqc_files = Channel.empty()");
    expect(wf).toContain("FASTQC.out.zip");
    expect(wf).toContain("MULTIQC ( ch_multiqc_files.collect()");
  });

  it("collects versions via the nf-core channel topic", () => {
    expect(wf).toContain("Channel.topic('versions')");
    expect(wf).not.toContain(".out.versions");
  });
});
