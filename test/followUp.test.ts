import { describe, expect, it } from "vitest";
import {
  buildFollowUpCommand,
  isRunnableFollowUp,
  upstreamInputPaths,
} from "../src/execution/followUp.js";
import type { FollowUpSpec } from "../src/pipelines/types.js";

const spec: FollowUpSpec = {
  pipeline: "nf-core/differentialabundance",
  when: "you want DEGs",
  note: "runs on counts",
  revision: "1.5.0",
  inputsFromUpstream: { matrix: "star_salmon/salmon.merged.gene_counts.tsv" },
  carryParams: ["gtf"],
  requiredInputs: [
    { name: "input", description: "sample-condition CSV" },
    { name: "contrasts", description: "contrasts CSV" },
  ],
};

describe("isRunnableFollowUp", () => {
  it("is runnable only with a pinned revision", () => {
    expect(isRunnableFollowUp(spec)).toBe(true);
    expect(isRunnableFollowUp({ ...spec, revision: undefined })).toBe(false);
    expect(isRunnableFollowUp({ ...spec, revision: "  " })).toBe(false);
    expect(isRunnableFollowUp(undefined)).toBe(false);
  });
});

describe("upstreamInputPaths", () => {
  it("joins relative upstream paths onto the outdir", () => {
    const paths = upstreamInputPaths(spec, "/runs/rnaseq/results");
    expect(paths.matrix).toBe("/runs/rnaseq/results/star_salmon/salmon.merged.gene_counts.tsv");
  });

  it("keeps absolute upstream paths as-is and handles an empty map", () => {
    expect(upstreamInputPaths({ ...spec, inputsFromUpstream: { matrix: "/abs/m.tsv" } }, "/x").matrix).toBe(
      "/abs/m.tsv",
    );
    expect(upstreamInputPaths({ ...spec, inputsFromUpstream: undefined }, "/x")).toEqual({});
  });
});

describe("buildFollowUpCommand", () => {
  it("builds a pinned real-data run and appends extra configs", () => {
    const cmd = buildFollowUpCommand({
      pipeline: "nf-core/differentialabundance",
      revision: "1.5.0",
      engine: "docker",
      paramsFile: "/run/params.yaml",
      extraConfigs: ["/run/executor.config"],
    });
    expect(cmd).toEqual([
      "run",
      "nf-core/differentialabundance",
      "-r",
      "1.5.0",
      "-profile",
      "docker",
      "-params-file",
      "/run/params.yaml",
      "-c",
      "/run/executor.config",
    ]);
  });
});
