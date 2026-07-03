import { describe, expect, it } from "vitest";
import {
  buildFetchngsCommand,
  detectAccessions,
  fetchngsPipelineTag,
  fetchngsSamplesheetPath,
  FETCHNGS_REVISION,
  renderIdsFile,
} from "../src/execution/fetchngs.js";

describe("detectAccessions", () => {
  it("detects and classifies SRA/GEO/BioProject ids", () => {
    const accs = detectAccessions(
      "Please analyze runs SRR12345678 and SRR12345679 from study SRP123456 (GEO GSE12345).",
    );
    expect(accs).toEqual([
      { id: "SRR12345678", kind: "run" },
      { id: "SRR12345679", kind: "run" },
      { id: "SRP123456", kind: "study" },
      { id: "GSE12345", kind: "geo-series" },
    ]);
  });

  it("de-duplicates repeated ids", () => {
    const accs = detectAccessions("SRR100000 SRR100000 PRJNA555");
    expect(accs.map((a) => a.id)).toEqual(["SRR100000", "PRJNA555"]);
  });

  it("returns nothing when there are no accessions", () => {
    expect(detectAccessions("mouse RNA-seq, treated vs control, 3 replicates")).toEqual([]);
  });

  it("does not match short numbers or lowercase lookalikes", () => {
    expect(detectAccessions("srr123 GSE1 the gene TP53")).toEqual([]);
  });

  it("recognizes ENA/DDBJ and ArrayExpress forms", () => {
    const accs = detectAccessions("ERR2000000, DRR100000, PRJEB12345, E-MTAB-1234");
    expect(accs.map((a) => a.kind)).toEqual(["run", "run", "bioproject", "arrayexpress"]);
  });
});

describe("renderIdsFile", () => {
  it("writes one id per line with a trailing newline", () => {
    expect(renderIdsFile([{ id: "SRR1", kind: "run" }, { id: "GSE2", kind: "geo-series" }])).toBe(
      "SRR1\nGSE2\n",
    );
  });
});

describe("fetchngsPipelineTag", () => {
  it("maps supported pipelines and returns undefined otherwise", () => {
    expect(fetchngsPipelineTag("nf-core/rnaseq")).toBe("rnaseq");
    expect(fetchngsPipelineTag("nf-core/sarek")).toBeUndefined();
    expect(fetchngsPipelineTag("nf-core/proteinfamilies")).toBeUndefined();
  });
});

describe("buildFetchngsCommand", () => {
  it("builds a pinned run with the pipeline tag when provided", () => {
    const cmd = buildFetchngsCommand({
      idsFile: "/run/ids.csv",
      outdir: "/run/fetchngs",
      engine: "docker",
      pipelineTag: "rnaseq",
    });
    expect(cmd).toEqual([
      "run",
      "nf-core/fetchngs",
      "-r",
      FETCHNGS_REVISION,
      "-profile",
      "docker",
      "--input",
      "/run/ids.csv",
      "--outdir",
      "/run/fetchngs",
      "--nf_core_pipeline",
      "rnaseq",
    ]);
  });

  it("omits the pipeline tag and appends extra configs", () => {
    const cmd = buildFetchngsCommand({
      idsFile: "/run/ids.csv",
      outdir: "/run/fetchngs",
      engine: "singularity",
      extraConfigs: ["/run/executor.config"],
    });
    expect(cmd).not.toContain("--nf_core_pipeline");
    expect(cmd.slice(-2)).toEqual(["-c", "/run/executor.config"]);
  });
});

describe("fetchngsSamplesheetPath", () => {
  it("points at the samplesheet fetchngs emits", () => {
    expect(fetchngsSamplesheetPath("/run/fetchngs")).toBe("/run/fetchngs/samplesheet/samplesheet.csv");
  });
});
