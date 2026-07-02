import { describe, expect, it } from "vitest";
import {
  assessProcesses,
  assessResources,
  formatMemoryGB,
  parseMemoryToGB,
  type ProcessResourceHint,
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

describe("assessProcesses (per-process model)", () => {
  const processes: ProcessResourceHint[] = [
    { name: "genome indexing (STAR)", memoryGB: 38, note: "holds the index", cappable: false },
    { name: "read alignment (STAR)", memoryGB: 12, cappable: false },
    { name: "quantification (Salmon)", memoryGB: 8, cappable: true },
    { name: "QC and reporting", memoryGB: 4, cappable: true },
  ];

  it("is OK when every step fits, naming the peak step", () => {
    const a = assessProcesses(processes, { cpus: 16, memoryGB: 64 });
    expect(a.verdict).toBe("ok");
    expect(a.limitingStep).toBe("genome indexing (STAR)");
    expect(a.caps).toBeUndefined();
  });

  it("refuses and names the non-cappable step that won't fit", () => {
    // 20 GB budget: indexing (38, hard floor) can't fit and can't be capped.
    const a = assessProcesses(processes, { cpus: 8, memoryGB: 20 });
    expect(a.verdict).toBe("refuse");
    expect(a.limitingStep).toBe("genome indexing (STAR)");
    expect(a.message).toContain("genome indexing (STAR)");
    expect(a.caps).toBeUndefined();
  });

  it("adapts when only cappable steps exceed the budget", () => {
    // 10 GB budget: only Salmon (8, cappable) — wait, 8 <= 10. Use 6 GB budget so
    // Salmon(8) overflows but is cappable; all non-cappable steps must fit.
    const light: ProcessResourceHint[] = [
      { name: "alignment", memoryGB: 5, cappable: false },
      { name: "quantification", memoryGB: 8, cappable: true },
    ];
    const a = assessProcesses(light, { cpus: 4, memoryGB: 6 });
    expect(a.verdict).toBe("adapt");
    expect(a.limitingStep).toBe("quantification");
    expect(a.caps?.maxMemory).toBe("6.GB");
  });

  it("refuses if a non-cappable step overflows even when a cappable one does too", () => {
    const a = assessProcesses(processes, { cpus: 8, memoryGB: 10 });
    // alignment (12, non-cappable) overflows → refuse, not adapt.
    expect(a.verdict).toBe("refuse");
  });

  it("assessResources dispatches to the per-process model when processes exist", () => {
    const a = assessResources(
      { recommendedMemoryGB: 38, minMemoryGB: 24, processes },
      { cpus: 8, memoryGB: 20 },
    );
    expect(a.verdict).toBe("refuse");
    expect(a.limitingStep).toBe("genome indexing (STAR)");
  });

  it("skips the indexing floor when a prebuilt index/reference is provided", () => {
    const withIndex: ProcessResourceHint[] = [
      { name: "genome indexing (STAR)", memoryGB: 38, cappable: false, skipIfParams: ["genome"] },
      { name: "read alignment (STAR)", memoryGB: 12, cappable: false },
    ];
    // 20 GB: without the index this refuses; with genome provided, indexing is
    // skipped and alignment (12) fits → ok.
    const refused = assessProcesses(withIndex, { cpus: 8, memoryGB: 20 });
    expect(refused.verdict).toBe("refuse");

    const ok = assessProcesses(withIndex, { cpus: 8, memoryGB: 20 }, new Set(["genome"]));
    expect(ok.verdict).toBe("ok");
    expect(ok.skippedSteps).toContain("genome indexing (STAR)");
    expect(ok.limitingStep).toBe("read alignment (STAR)");
  });
});
