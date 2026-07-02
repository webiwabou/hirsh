import { describe, expect, it } from "vitest";
import { buildParamsObject, buildRunArgs } from "../src/conversation/parameterFilling.js";
import { findPipeline } from "../src/pipelines/registry.js";
import { createSession } from "../src/conversation/session.js";
import type { HirshConfig } from "../src/config/types.js";

const baseConfig: HirshConfig = {
  provider: "ollama",
  ollama: { host: "http://localhost:11434", model: "m", temperature: 0 },
  anthropic: { apiKeyEnv: "X", model: "m", temperature: 0, maxTokens: 10 },
  execution: { containerEngine: "docker", workdir: "./runs" },
};

describe("buildParamsObject", () => {
  it("drops profile-provided params under the test profile", () => {
    const s = createSession();
    s.useTestProfile = true;
    s.paramValues = { outdir: "/x", input: "/s.csv", genome: "GRCm39", aligner: "star_salmon" };
    const obj = buildParamsObject(s, baseConfig);
    expect(obj.input).toBeUndefined();
    expect(obj.genome).toBeUndefined();
    expect(obj.outdir).toBe("/x");
    expect(obj.aligner).toBe("star_salmon");
  });

  it("keeps input/genome for real runs", () => {
    const s = createSession();
    s.useTestProfile = false;
    s.paramValues = { outdir: "/x", input: "/s.csv", genome: "GRCm39" };
    const obj = buildParamsObject(s, baseConfig);
    expect(obj.input).toBe("/s.csv");
    expect(obj.genome).toBe("GRCm39");
  });

  it("injects config resource caps as defaults", () => {
    const s = createSession();
    s.paramValues = { outdir: "/x" };
    const cfg = { ...baseConfig, execution: { ...baseConfig.execution, maxMemory: "16.GB", maxCpus: 4 } };
    const obj = buildParamsObject(s, cfg);
    expect(obj.max_memory).toBe("16.GB");
    expect(obj.max_cpus).toBe(4);
  });

  it("does not override an already-set cap (e.g. from adaptation)", () => {
    const s = createSession();
    s.paramValues = { outdir: "/x", max_memory: "30.GB" };
    const cfg = { ...baseConfig, execution: { ...baseConfig.execution, maxMemory: "16.GB" } };
    const obj = buildParamsObject(s, cfg);
    expect(obj.max_memory).toBe("30.GB");
  });
});

describe("buildRunArgs", () => {
  it("uses -params-file and adds the test profile", () => {
    const rnaseq = findPipeline("nf-core/rnaseq")!;
    const args = buildRunArgs(rnaseq, baseConfig, true, "/run/params.yaml");
    expect(args).toEqual([
      "run",
      "nf-core/rnaseq",
      "-r",
      rnaseq.version,
      "-profile",
      "test,docker",
      "-params-file",
      "/run/params.yaml",
    ]);
  });

  it("omits the test profile for real runs", () => {
    const sarek = findPipeline("nf-core/sarek")!;
    const args = buildRunArgs(sarek, baseConfig, false, "/run/params.yaml");
    expect(args).toContain("-profile");
    expect(args[args.indexOf("-profile") + 1]).toBe("docker");
  });
});
