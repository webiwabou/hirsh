import { describe, expect, it } from "vitest";
import {
  assessDiskPressure,
  cacheEnvFor,
  defaultImageFootprintGB,
  estimateStagingNeeds,
  extractPathCells,
} from "../src/execution/staging.js";

const GB = 1024 ** 3;

describe("estimateStagingNeeds", () => {
  it("sums images, inputs and work (work = 3x inputs by default)", () => {
    const e = estimateStagingNeeds({ imagesGB: 12, inputBytes: 10 * GB });
    expect(e.imagesGB).toBe(12);
    expect(e.inputsGB).toBe(10);
    expect(e.workGB).toBe(30);
    expect(e.totalGB).toBe(52);
  });

  it("honors a custom work multiplier", () => {
    const e = estimateStagingNeeds({ imagesGB: 6, inputBytes: 2 * GB, workMultiplier: 1 });
    expect(e.workGB).toBe(2);
    expect(e.totalGB).toBe(10);
  });
});

describe("assessDiskPressure", () => {
  const est = estimateStagingNeeds({ imagesGB: 12, inputBytes: 8 * GB }); // total 44

  it("is ok with comfortable headroom (>=1.5x)", () => {
    expect(assessDiskPressure(100, est).level).toBe("ok");
  });
  it("is tight when it fits but under the 1.5x margin", () => {
    expect(assessDiskPressure(50, est).level).toBe("tight");
  });
  it("is insufficient when free < need", () => {
    const a = assessDiskPressure(30, est);
    expect(a.level).toBe("insufficient");
    expect(a.message).toContain("space");
  });
});

describe("cacheEnvFor", () => {
  it("sets the singularity cache dir", () => {
    expect(cacheEnvFor("singularity", "/c").NXF_SINGULARITY_CACHEDIR).toBe("/c/singularity");
  });
  it("sets the conda cache dir for conda and mamba", () => {
    expect(cacheEnvFor("conda", "/c").NXF_CONDA_CACHEDIR).toBe("/c/conda");
    expect(cacheEnvFor("mamba", "/c").NXF_CONDA_CACHEDIR).toBe("/c/conda");
  });
  it("returns nothing for docker (manages its own store)", () => {
    expect(Object.keys(cacheEnvFor("docker", "/c"))).toHaveLength(0);
  });
});

describe("defaultImageFootprintGB", () => {
  it("is smaller for conda than for containers", () => {
    expect(defaultImageFootprintGB("conda")).toBeLessThan(defaultImageFootprintGB("docker"));
  });
});

describe("extractPathCells", () => {
  it("pulls file paths from samplesheet rows, skipping the header", () => {
    const csv = [
      "sample,fastq_1,fastq_2,strandedness",
      "s1,/data/s1_R1.fastq.gz,/data/s1_R2.fastq.gz,auto",
      "s2,/data/s2_R1.fastq.gz,,reverse",
    ].join("\n");
    const cells = extractPathCells(csv);
    expect(cells).toContain("/data/s1_R1.fastq.gz");
    expect(cells).toContain("/data/s2_R1.fastq.gz");
    // header names and non-path values excluded
    expect(cells).not.toContain("fastq_1");
    expect(cells).not.toContain("auto");
  });

  it("returns nothing for a header-only sheet", () => {
    expect(extractPathCells("sample,fastq_1")).toEqual([]);
  });
});
