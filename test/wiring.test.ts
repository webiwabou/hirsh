import { describe, expect, it } from "vitest";
import { buildWorkflow, classifyKind, entryInputSpec, inputColumn } from "../src/composition/wiring.js";
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

  it("reports a reads input spec and reads-shaped take comment", () => {
    expect(res.input).toEqual({ kind: "reads", reads: true });
    expect(wf).toContain("[ val(meta), [ path(reads) ] ]");
  });
});

describe("entryInputSpec (input-channel matching)", () => {
  // A protein-family pipeline whose first module consumes a FASTA, not reads.
  const hmmer = mod("hmmer/hmmsearch", [metaFile("fasta")], [
    { name: "output", elements: [{ name: "meta", type: "map" }, { name: "*.txt", type: "file" }] },
  ]);

  it("derives reads from a reads-consuming first module", () => {
    expect(entryInputSpec([fastqc])).toEqual({ kind: "reads", reads: true });
  });

  it("derives a single-file FASTA input from a FASTA-consuming first module", () => {
    expect(entryInputSpec([hmmer])).toEqual({ kind: "fasta", reads: false });
  });

  it("falls back to reads with no modules", () => {
    expect(entryInputSpec([])).toEqual({ kind: "reads", reads: true });
  });

  it("wires a FASTA input channel and single-file take comment", () => {
    const res = buildWorkflow({ pipelineName: "prot", steps: [{ module: "hmmer/hmmsearch" }] }, [hmmer]);
    expect(res.input.reads).toBe(false);
    // The FASTA input anchors the first module directly to ch_input.
    expect(res.workflow).toContain("HMMER_HMMSEARCH ( ch_input )");
    expect(res.workflow).toContain("[ val(meta), path(fasta) ]");
  });

  it("maps a fasta kind to the fasta samplesheet column", () => {
    expect(inputColumn("fasta")).toBe("fasta");
    expect(inputColumn("bam")).toBe("bam");
  });
});
