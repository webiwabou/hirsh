import { describe, expect, it } from "vitest";
import {
  assessResources,
  formatMemoryGB,
  parseMemoryToGB,
} from "../src/execution/resources.js";

describe("parseMemoryToGB", () => {
  it("parses plain numbers as GB", () => {
    expect(parseMemoryToGB(30)).toBe(30);
  });
  it("parses nf-core style strings", () => {
    expect(parseMemoryToGB("40.GB")).toBe(40);
    expect(parseMemoryToGB("8G")).toBe(8);
    expect(parseMemoryToGB("512.MB")).toBeCloseTo(0.5, 5);
    expect(parseMemoryToGB("1.TB")).toBe(1024);
  });
  it("returns null on garbage", () => {
    expect(parseMemoryToGB("lots")).toBeNull();
    expect(parseMemoryToGB(null)).toBeNull();
  });
});

describe("formatMemoryGB", () => {
  it("floors to an nf-core memory string", () => {
    expect(formatMemoryGB(30.7)).toBe("30.GB");
    expect(formatMemoryGB(0.2)).toBe("1.GB");
  });
});

describe("assessResources (the 40 / 30 / 2 GB story)", () => {
  const hints = { recommendedMemoryGB: 38, minMemoryGB: 24, recommendedCpus: 8 };

  it("is OK when the machine covers the recommendation", () => {
    const a = assessResources(hints, { cpus: 16, memoryGB: 64 });
    expect(a.verdict).toBe("ok");
    expect(a.caps).toBeUndefined();
  });

  it("adapts when below recommended but above the floor (30 GB)", () => {
    const a = assessResources(hints, { cpus: 8, memoryGB: 30 });
    expect(a.verdict).toBe("adapt");
    expect(a.caps?.maxMemory).toBe("30.GB");
    expect(a.caps?.maxCpus).toBe(8);
  });

  it("refuses when far below the floor (2 GB)", () => {
    const a = assessResources(hints, { cpus: 4, memoryGB: 2 });
    expect(a.verdict).toBe("refuse");
    expect(a.caps).toBeUndefined();
  });

  it("cannot judge without hints", () => {
    const a = assessResources({}, { cpus: 4, memoryGB: 8 });
    expect(a.verdict).toBe("ok");
  });
});
