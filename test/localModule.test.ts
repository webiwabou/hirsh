import { describe, expect, it } from "vitest";
import {
  globToStubFile,
  renderLocalModuleMain,
  toNfCoreModule,
  type LocalToolSpec,
} from "../src/composition/localModule.js";
import { buildWorkflow } from "../src/composition/wiring.js";

const spec: LocalToolSpec = {
  name: "myfilter",
  toolName: "myfilter",
  description: "Filters a BAM by a custom rule.",
  command: "myfilter --in $bam --out ${prefix}.filtered.bam $args",
  container: "biocontainers/samtools:1.19--h50ea8bc_0",
  inputs: [{ name: "bam", type: "file" }],
  outputs: [{ name: "bam", type: "file", pattern: "*.filtered.bam" }],
  versionCommand: "myfilter --version",
  hasMeta: true,
  label: "process_low",
};

describe("globToStubFile", () => {
  it("expands the leading wildcard with the prefix token", () => {
    expect(globToStubFile("*.filtered.bam", "PFX")).toBe("PFX.filtered.bam");
    expect(globToStubFile("*", "PFX")).toBe("PFX");
    expect(globToStubFile("out.txt", "PFX")).toBe("out.txt");
  });
});

describe("renderLocalModuleMain", () => {
  const nf = renderLocalModuleMain(spec);

  it("is a standards-compliant process with the nf-core conventions", () => {
    expect(nf).toContain("process MYFILTER {");
    expect(nf).toContain("label 'process_low'");
    expect(nf).toContain('container "biocontainers/samtools:1.19--h50ea8bc_0"');
    expect(nf).toContain("tuple val(meta), path(bam)");
    expect(nf).toContain('tuple val(meta), path("*.filtered.bam"), emit: bam');
    expect(nf).toContain('path "versions.yml", emit: versions');
    expect(nf).toContain("task.ext.when == null || task.ext.when");
    expect(nf).toContain("script:");
    expect(nf).toContain("stub:");
  });

  it("escapes the shell command substitution in the versions heredoc", () => {
    // Groovy triple-quoted strings interpolate $, so `$(...)` must be `\$(...)`
    // or the module fails to compile (verified end-to-end with -stub-run).
    expect(nf).toContain("\\$(myfilter --version)");
  });

  it("touches a concrete output file in the stub block", () => {
    // stub must materialize a file matching the glob so downstream stub steps see it
    expect(nf).toContain("touch ${prefix}.filtered.bam");
  });

  it("warns when no environment is declared", () => {
    const noEnv = renderLocalModuleMain({ ...spec, container: undefined, conda: undefined });
    expect(noEnv).toContain("no container or conda declared");
  });
});

describe("toNfCoreModule + wiring", () => {
  it("marks the module local and wires it from modules/local", () => {
    const mod = toNfCoreModule(spec);
    expect(mod.local).toBe(true);
    expect(mod.path).toBe("modules/local/myfilter");

    const wiring = buildWorkflow({ pipelineName: "custom", steps: [{ module: "myfilter" }] }, [mod]);
    expect(wiring.workflow).toContain("from '../modules/local/myfilter/main'");
    expect(wiring.workflow).toContain("MYFILTER (");
  });

  it("connects an upstream reads channel into the local module input", () => {
    // A local tool consuming 'reads' should be fed ch_input (the take: channel).
    const readsTool = toNfCoreModule({
      ...spec,
      name: "readstat",
      inputs: [{ name: "reads", type: "file" }],
      outputs: [{ name: "tsv", type: "file", pattern: "*.tsv" }],
    });
    const wiring = buildWorkflow(
      { pipelineName: "custom", steps: [{ module: "readstat" }] },
      [readsTool],
    );
    expect(wiring.workflow).toContain("READSTAT ( ch_input");
  });
});
