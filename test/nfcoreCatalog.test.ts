import { describe, expect, it } from "vitest";
import {
  buildNfCoreTestRunCommand,
  parseNfCoreCatalog,
  rankNfCorePipelines,
  type NfCorePipeline,
} from "../src/pipelines/nfcoreCatalog.js";

const SAMPLE = {
  remote_workflows: [
    {
      name: "atacseq",
      full_name: "nf-core/atacseq",
      description: "ATAC-seq peak-calling and QC analysis pipeline",
      topics: ["atac-seq", "chromatin-accessibility"],
      html_url: "https://github.com/nf-core/atacseq",
      stargazers_count: 200,
      archived: false,
      releases: [
        { tag_name: "dev" },
        { tag_name: "2.1.2" },
        { tag_name: "2.1.1" },
      ],
    },
    {
      name: "methylseq",
      full_name: "nf-core/methylseq",
      description: "Methylation (Bisulfite-Sequencing) analysis pipeline using Bismark",
      topics: ["methylation", "bisulfite"],
      html_url: "https://github.com/nf-core/methylseq",
      stargazers_count: 150,
      archived: false,
      releases: [{ tag_name: "2.6.0" }, { tag_name: "dev" }],
    },
    {
      // Archived pipelines must never be recommended.
      name: "oldpipe",
      full_name: "nf-core/oldpipe",
      description: "A deprecated atac chromatin pipeline",
      topics: ["atac-seq"],
      archived: true,
      releases: [{ tag_name: "1.0.0" }],
    },
    {
      // Unreleased (dev-only) pipeline: parses but ranks below released ones.
      name: "freshpipe",
      full_name: "nf-core/freshpipe",
      description: "Brand new methylation experiment",
      topics: ["methylation"],
      archived: false,
      releases: [{ tag_name: "dev" }],
    },
  ],
};

describe("parseNfCoreCatalog", () => {
  it("extracts name/description/topics and the latest stable release, dropping archived", () => {
    const catalog = parseNfCoreCatalog(SAMPLE);
    const names = catalog.map((p) => p.name);
    expect(names).toEqual(["atacseq", "freshpipe", "methylseq"]); // sorted, no "oldpipe"
    const atac = catalog.find((p) => p.name === "atacseq")!;
    expect(atac.fullName).toBe("nf-core/atacseq");
    expect(atac.latestRelease).toBe("2.1.2"); // newest non-dev
    expect(atac.topics).toContain("chromatin-accessibility");
    const fresh = catalog.find((p) => p.name === "freshpipe")!;
    expect(fresh.latestRelease).toBeNull(); // dev-only
  });

  it("tolerates a malformed payload", () => {
    expect(parseNfCoreCatalog(null)).toEqual([]);
    expect(parseNfCoreCatalog({})).toEqual([]);
    expect(parseNfCoreCatalog({ remote_workflows: [1, "x", {}] })).toEqual([]);
  });
});

describe("rankNfCorePipelines", () => {
  const catalog: NfCorePipeline[] = parseNfCoreCatalog(SAMPLE);

  it("ranks by name/topic match to the intent terms", () => {
    const ranked = rankNfCorePipelines(catalog, ["ATAC-seq", "chromatin accessibility"]);
    expect(ranked[0].pipeline.name).toBe("atacseq");
  });

  it("matches on topic words even when the name differs", () => {
    const ranked = rankNfCorePipelines(catalog, ["bisulfite methylation"]);
    expect(ranked[0].pipeline.name).toBe("methylseq");
  });

  it("prefers a released pipeline over a dev-only one on equal text match", () => {
    const ranked = rankNfCorePipelines(catalog, ["methylation"]);
    const names = ranked.map((r) => r.pipeline.name);
    expect(names.indexOf("methylseq")).toBeLessThan(names.indexOf("freshpipe"));
  });

  it("returns nothing for unrelated terms", () => {
    expect(rankNfCorePipelines(catalog, ["quantum", "banana"])).toEqual([]);
    expect(rankNfCorePipelines(catalog, [])).toEqual([]);
  });
});

describe("buildNfCoreTestRunCommand", () => {
  it("builds a self-contained test-profile run command", () => {
    const cmd = buildNfCoreTestRunCommand({
      pipeline: "nf-core/atacseq",
      revision: "2.1.2",
      engine: "docker",
      outdir: "/runs/atac/results",
    });
    expect(cmd).toEqual([
      "run",
      "nf-core/atacseq",
      "-r",
      "2.1.2",
      "-profile",
      "test,docker",
      "--outdir",
      "/runs/atac/results",
    ]);
  });

  it("appends extra -c configs (e.g. an executor config)", () => {
    const cmd = buildNfCoreTestRunCommand({
      pipeline: "nf-core/methylseq",
      revision: "2.6.0",
      engine: "singularity",
      outdir: "/out",
      extraConfigs: ["/cfg/slurm.config"],
    });
    expect(cmd.slice(-4)).toEqual(["--outdir", "/out", "-c", "/cfg/slurm.config"]);
  });
});
