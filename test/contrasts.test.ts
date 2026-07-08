import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  contrastsCsv,
  contrastsYaml,
  detectFactors,
  proposeContrasts,
  proposeContrastsFromSheet,
  proposeInteractionContrasts,
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

  it("adds a blocking column when a blocking factor is present", () => {
    const csv = contrastsCsv(proposeContrasts("condition", ["treated", "control"], "control", "batch"));
    expect(csv).toBe(
      "id,variable,reference,target,blocking\ntreated_vs_control,condition,control,treated,batch\n",
    );
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

  it("adds a crossed batch as a blocking factor, but not a confounded one", () => {
    const crossed = [
      "sample,condition,batch",
      "t1,treated,b1", "t2,treated,b2",
      "c1,control,b1", "c2,control,b2",
    ].join("\n");
    const r = proposeContrastsFromSheet(crossed)!;
    expect(r.blocking).toBe("batch");
    expect(r.contrasts[0].blocking).toBe("batch");

    const confounded = [
      "sample,condition,batch",
      "t1,treated,b1", "t2,treated,b1",
      "c1,control,b2", "c2,control,b2",
    ].join("\n");
    const r2 = proposeContrastsFromSheet(confounded)!;
    expect(r2.blocking).toBeNull(); // confounded batch is unusable as a covariate
  });
});

const FACTORIAL = [
  "sample,genotype,treatment",
  "s1,WT,Control", "s2,WT,Control",
  "s3,WT,Treated", "s4,WT,Treated",
  "s5,KO,Control", "s6,KO,Control",
  "s7,KO,Treated", "s8,KO,Treated",
].join("\n");

describe("detectFactors", () => {
  it("finds the experimental factors with levels ordered control-first", () => {
    const factors = detectFactors(FACTORIAL);
    expect(factors.map((f) => f.column)).toEqual(["genotype", "treatment"]);
    const genotype = factors.find((f) => f.column === "genotype")!;
    expect(genotype.reference).toBe("WT"); // WT recognized as the control level
    expect(genotype.levels[0]).toBe("WT");
    const treatment = factors.find((f) => f.column === "treatment")!;
    expect(treatment.reference).toBe("Control");
  });

  it("excludes batch columns and single-level columns", () => {
    const csv = ["sample,condition,batch", "s1,treated,b1", "s2,treated,b2"].join("\n");
    // condition has a single level, batch is technical → no usable factors.
    expect(detectFactors(csv)).toEqual([]);
  });

  it("counts levels by biological sample, merging technical replicates", () => {
    // sample s1 spans two lanes but is one biological sample → treatment still 2 levels.
    const csv = [
      "sample,treatment", "s1,Control", "s1,Control", "s2,Treated", "s3,Treated",
    ].join("\n");
    const [treatment] = detectFactors(csv);
    expect(treatment.levels.sort()).toEqual(["Control", "Treated"]);
  });
});

describe("proposeInteractionContrasts", () => {
  it("proposes the interaction contrast for a crossed 2x2 design", () => {
    const p = proposeInteractionContrasts(FACTORIAL)!;
    expect(p.factorA.column).toBe("genotype");
    expect(p.factorB.column).toBe("treatment");
    expect(p.replication).toBe("full");
    expect(p.contrasts).toEqual([
      {
        id: "genotype_WT_KO_treatment_Control_Treated",
        formula: "~ genotype * treatment",
        makeContrastsStr: "genotypeKO.treatmentTreated",
      },
    ]);
  });

  it("returns null when the two factors are not fully crossed", () => {
    // KO only ever appears with Treated → the WT/KO × Control/Treated cells are incomplete.
    const csv = [
      "sample,genotype,treatment",
      "s1,WT,Control", "s2,WT,Control", "s3,WT,Treated", "s4,WT,Treated",
      "s5,KO,Treated", "s6,KO,Treated",
    ].join("\n");
    expect(proposeInteractionContrasts(csv)).toBeNull();
  });

  it("returns null with fewer than two experimental factors", () => {
    const csv = ["sample,condition", "s1,treated", "s2,control"].join("\n");
    expect(proposeInteractionContrasts(csv)).toBeNull();
  });

  it("flags partial replication when a cell has a single replicate", () => {
    const csv = [
      "sample,genotype,treatment",
      "s1,WT,Control", "s2,WT,Control",
      "s3,WT,Treated", "s4,WT,Treated",
      "s5,KO,Control", "s6,KO,Control",
      "s7,KO,Treated", // only one KO/Treated replicate
    ].join("\n");
    const p = proposeInteractionContrasts(csv)!;
    expect(p.replication).toBe("partial");
  });

  it("emits one interaction contrast per non-reference level pair (2x3)", () => {
    const csv = [
      "sample,genotype,dose",
      "a1,WT,none", "a2,WT,none", "a3,WT,low", "a4,WT,low", "a5,WT,high", "a6,WT,high",
      "b1,KO,none", "b2,KO,none", "b3,KO,low", "b4,KO,low", "b5,KO,high", "b6,KO,high",
    ].join("\n");
    const p = proposeInteractionContrasts(csv)!;
    // genotype: ref WT, target KO; dose: ref none? "none" isn't a control label → alphabetical ref "high"
    expect(p.contrasts.length).toBe(2);
    expect(p.contrasts.every((c) => c.formula === "~ genotype * dose")).toBe(true);
  });
});

describe("contrastsYaml", () => {
  it("mixes main-effect comparisons and formula-based interaction contrasts", () => {
    const main = proposeContrasts("treatment", ["Treated", "Control"]);
    const p = proposeInteractionContrasts(FACTORIAL)!;
    const yaml = contrastsYaml(main, p.contrasts);
    const parsed = parseYaml(yaml) as { contrasts: any[] };
    expect(parsed.contrasts).toHaveLength(2);
    expect(parsed.contrasts[0].comparison).toEqual(["treatment", "Control", "Treated"]);
    expect(parsed.contrasts[1].formula).toBe("~ genotype * treatment");
    expect(parsed.contrasts[1].make_contrasts_str).toBe("genotypeKO.treatmentTreated");
  });

  it("carries a blocking factor as blocking_factors on a main-effect entry", () => {
    const main = proposeContrasts("condition", ["treated", "control"], "control", "batch");
    const yaml = contrastsYaml(main, []);
    const parsed = parseYaml(yaml) as { contrasts: any[] };
    expect(parsed.contrasts[0].blocking_factors).toEqual(["batch"]);
  });
});
