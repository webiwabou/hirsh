import { describe, expect, it } from "vitest";
import { buildInclusionGuide, validateNfCoreName } from "../src/composition/inclusion.js";

describe("validateNfCoreName", () => {
  it("accepts a clean lowercase alphanumeric name", () => {
    const r = validateNfCoreName("rnavariants");
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe("rnavariants");
    expect(r.issues).toEqual([]);
  });

  it("strips an nf-core/ prefix before checking", () => {
    expect(validateNfCoreName("nf-core/rnaseq").ok).toBe(true);
  });

  it("flags uppercase, punctuation and normalizes", () => {
    const r = validateNfCoreName("My_Cool-Pipeline");
    expect(r.ok).toBe(false);
    expect(r.normalized).toBe("mycoolpipeline");
    expect(r.issues.join(" ")).toMatch(/lowercase/i);
    expect(r.issues.join(" ")).toMatch(/letters and digits/i);
  });

  it("flags a leading digit and empty input", () => {
    expect(validateNfCoreName("3prime").issues.join(" ")).toMatch(/digit/i);
    expect(validateNfCoreName("   ").ok).toBe(false);
    expect(validateNfCoreName("   ").normalized).toBe("mypipeline");
  });
});

describe("buildInclusionGuide", () => {
  const guide = buildInclusionGuide("MyPipeline");

  it("is honest that acceptance is a community decision", () => {
    expect(guide).toMatch(/community decision/i);
    expect(guide).toMatch(/cannot guarantee/i);
  });

  it("covers naming, proposal, template, lint and review", () => {
    expect(guide).toMatch(/Naming/);
    expect(guide).toMatch(/#new-pipelines|proposal/i);
    expect(guide).toMatch(/nf-core pipelines create/);
    expect(guide).toMatch(/nf-core pipelines lint/);
    expect(guide).toMatch(/review/i);
  });

  it("surfaces a name issue with a normalized suggestion", () => {
    expect(guide).toContain("mypipeline"); // normalized from "MyPipeline"
  });
});
