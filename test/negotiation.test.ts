import { describe, expect, it } from "vitest";
import { negotiateInfrastructure } from "../src/execution/negotiation.js";

describe("negotiateInfrastructure", () => {
  it("recommends capping locally under an adapt verdict", () => {
    const r = negotiateInfrastructure({
      verdict: "adapt",
      availableMemoryGB: 30,
      requiredMemoryGB: 38,
      limitingStep: "quantification (Salmon)",
    });
    expect(r.options[r.recommendedIndex].kind).toBe("cap-local");
    expect(r.options[0].feasibility).toBe("risky");
    expect(r.summary).toContain("cappable");
  });

  it("marks cap-local infeasible and recommends a cluster under refuse", () => {
    const r = negotiateInfrastructure({
      verdict: "refuse",
      availableMemoryGB: 20,
      requiredMemoryGB: 38,
      limitingStep: "genome indexing (STAR)",
    });
    const capLocal = r.options.find((o) => o.kind === "cap-local")!;
    expect(capLocal.feasibility).toBe("infeasible");
    expect(r.options[r.recommendedIndex].kind).toBe("cluster");
    expect(r.summary).toContain("genome indexing (STAR)");
  });

  it("recommends the cloud when the requirement exceeds a typical HPC node", () => {
    const r = negotiateInfrastructure({
      verdict: "refuse",
      availableMemoryGB: 64,
      requiredMemoryGB: 900,
    });
    expect(r.options[r.recommendedIndex].kind).toBe("cloud");
    // cluster is still offered but flagged risky at that size
    expect(r.options.find((o) => o.kind === "cluster")!.feasibility).toBe("risky");
  });

  it("gives a rough per-hour cloud cost scaled by required memory", () => {
    const r = negotiateInfrastructure({
      verdict: "refuse",
      availableMemoryGB: 8,
      requiredMemoryGB: 100,
    });
    const cloud = r.options.find((o) => o.kind === "cloud")!;
    expect(cloud.cost).toMatch(/\$\d/);
    expect(cloud.cost).toContain("100 GB");
  });

  it("always offers an abort option", () => {
    const r = negotiateInfrastructure({
      verdict: "refuse",
      availableMemoryGB: 4,
      requiredMemoryGB: 40,
    });
    expect(r.options.some((o) => o.kind === "abort")).toBe(true);
  });
});
