import { describe, expect, it } from "vitest";
import {
  contrastsCsv,
  proposeContrasts,
  proposeContrastsFromSheet,
} from "../src/conversation/contrasts.js";
import { detectControlGroup } from "../src/conversation/samplesheetReview.js";

describe("detectControlGroup", () => {
  it("recognizes common control/reference labels", () => {
    expect(detectControlGroup(["treated", "untreated"])).toBe("untreated");
    expect(detectControlGroup(["tumor", "normal"])).toBe("normal");
    expect(detectControlGroup(["KO", "WT"])).toBe("WT");
    expect(detectControlGroup(["drugA", "drugB"])).toBeNull();
  });
});

describe("proposeContrasts", () => {
  it("compares each group against the detected control", () => {
    const c = proposeContrasts("condition", ["treated", "untreated"]);
    expect(c).toEqual([
      { id: "treated_vs_untreated", variable: "condition", reference: "untreated", target: "treated" },
    ]);
  });

  it("handles multiple treatments vs one control", () => {
    const c = proposeContrasts("condition", ["ctrl", "dose_low", "dose_high"]);
    expect(c.map((x) => x.id)).toEqual(["dose_high_vs_ctrl", "dose_low_vs_ctrl"]);
    expect(c.every((x) => x.reference === "ctrl")).toBe(true);
  });

  it("falls back to the first group as reference when no control is present", () => {
    const c = proposeContrasts("genotype", ["mutantB", "mutantA"]);
    // alphabetical → reference mutantA
    expect(c).toEqual([
      { id: "mutantB_vs_mutantA", variable: "genotype", reference: "mutantA", target: "mutantB" },
    ]);
  });

  it("returns nothing for fewer than two groups", () => {
    expect(proposeContrasts("condition", ["only"])).toEqual([]);
  });
});

describe("contrastsCsv", () => {
  it("renders the differentialabundance contrasts header and rows", () => {
    const csv = contrastsCsv(proposeContrasts("condition", ["treated", "control"]));
    expect(csv).toBe("id,variable,reference,target\ntreated_vs_control,condition,control,treated\n");
  });
});

describe("proposeContrastsFromSheet", () => {
  it("proposes contrasts from a condition samplesheet, marking assumed references", () => {
    const withControl = "sample,condition\ns1,treated\ns2,treated\ns3,control\ns4,control";
    const r = proposeContrastsFromSheet(withControl)!;
    expect(r.variable).toBe("condition");
    expect(r.assumedReference).toBe(false);
    expect(r.contrasts[0].reference).toBe("control");

    const noControl = "sample,genotype\ns1,mutA\ns2,mutB";
    const r2 = proposeContrastsFromSheet(noControl)!;
    expect(r2.assumedReference).toBe(true);
  });

  it("returns null when there is no grouping column", () => {
    expect(proposeContrastsFromSheet("sample,fastq_1\ns1,a.fq")).toBeNull();
  });
});
