import { describe, expect, it } from "vitest";
import {
  buildComposedRunCommand,
  composedRowsFromFiles,
  sampleNameFromPath,
} from "../src/composition/run.js";

describe("buildComposedRunCommand", () => {
  it("builds a real run with input, outdir, reference params and executor config", () => {
    const cmd = buildComposedRunCommand({
      dir: "/runs/proteinstructure",
      engine: "docker",
      input: "/data/samplesheet.csv",
      outdir: "/runs/proteinstructure/results",
      refParams: [
        { name: "fasta", value: "/ref/genome.fa" },
        { name: "model_dir", value: "/ref/models" },
      ],
      extraConfigs: ["/runs/proteinstructure/executor.config"],
    });
    expect(cmd).toEqual([
      "run",
      "/runs/proteinstructure",
      "-profile",
      "docker",
      "--input",
      "/data/samplesheet.csv",
      "--outdir",
      "/runs/proteinstructure/results",
      "--fasta",
      "/ref/genome.fa",
      "--model_dir",
      "/ref/models",
      "-c",
      "/runs/proteinstructure/executor.config",
    ]);
  });

  it("omits --input when none is given and needs no reference params", () => {
    const cmd = buildComposedRunCommand({
      dir: ".",
      engine: "singularity",
      outdir: "results",
      refParams: [],
    });
    expect(cmd).toEqual(["run", ".", "-profile", "singularity", "--outdir", "results"]);
    expect(cmd).not.toContain("--input");
  });

  it("builds one samplesheet row per file, pointing at fastq_1", () => {
    const rows = composedRowsFromFiles(["/data/hbz.fasta", "/data/s2.fastq.gz"]);
    expect(rows).toEqual([
      { sample: "hbz", fastq_1: "/data/hbz.fasta", fastq_2: "" },
      { sample: "s2", fastq_1: "/data/s2.fastq.gz", fastq_2: "" },
    ]);
  });

  it("derives a clean sample name (drops extension and .gz)", () => {
    expect(sampleNameFromPath("/d/SRR1_1.fastq.gz")).toBe("SRR1_1");
    expect(sampleNameFromPath("prot.fasta")).toBe("prot");
    expect(sampleNameFromPath("/x/weird name!.fa")).toBe("weird_name_");
  });

  it("uses the test profile (and ignores input/ref params) when test=true", () => {
    const cmd = buildComposedRunCommand({
      dir: "/p",
      engine: "docker",
      input: "/data/ss.csv",
      outdir: "/p/results_test",
      refParams: [{ name: "fasta", value: "/ref/x.fa" }],
      test: true,
    });
    expect(cmd).toEqual(["run", "/p", "-profile", "test,docker", "--outdir", "/p/results_test"]);
    expect(cmd).not.toContain("--input"); // test profile provides its own data
    expect(cmd).not.toContain("--fasta");
  });
});
