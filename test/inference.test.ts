import { describe, expect, it } from "vitest";
import { deriveGenomeKey } from "../src/conversation/inference.js";

// The rnaseq definition's genome choices.
const RNASEQ_CHOICES = ["GRCh38", "GRCh37", "GRCm39", "GRCm38", "R64-1-1", "WBcel235", "TAIR10"];

describe("deriveGenomeKey", () => {
  it("maps common organisms to their iGenomes key (constrained to allowed)", () => {
    expect(deriveGenomeKey("human", RNASEQ_CHOICES)?.key).toBe("GRCh38");
    expect(deriveGenomeKey("Homo sapiens", RNASEQ_CHOICES)?.key).toBe("GRCh38");
    expect(deriveGenomeKey("mouse", RNASEQ_CHOICES)?.key).toBe("GRCm39");
    expect(deriveGenomeKey("Mus musculus", RNASEQ_CHOICES)?.key).toBe("GRCm39");
    expect(deriveGenomeKey("Saccharomyces cerevisiae (yeast)", RNASEQ_CHOICES)?.key).toBe("R64-1-1");
    expect(deriveGenomeKey("C. elegans", RNASEQ_CHOICES)?.key).toBe("WBcel235");
    expect(deriveGenomeKey("Arabidopsis thaliana", RNASEQ_CHOICES)?.key).toBe("TAIR10");
  });

  it("respects the allowed set — falls back to an allowed key or gives up", () => {
    // Only GRCh37 allowed → human derives to GRCh37, not GRCh38.
    expect(deriveGenomeKey("human", ["GRCh37"])?.key).toBe("GRCh37");
    // Organism matched but no allowed key → null (can't satisfy the pipeline).
    expect(deriveGenomeKey("zebrafish", RNASEQ_CHOICES)).toBeNull();
  });

  it("picks the best key when unconstrained", () => {
    expect(deriveGenomeKey("zebrafish")?.key).toBe("GRCz11");
    expect(deriveGenomeKey("rat")?.key).toBe("mRatBN7.2");
  });

  it("returns null for unknown or empty organisms", () => {
    expect(deriveGenomeKey("")).toBeNull();
    expect(deriveGenomeKey(undefined)).toBeNull();
    expect(deriveGenomeKey("some unnamed microbe")).toBeNull();
  });

  it("carries the organism it matched on", () => {
    expect(deriveGenomeKey("Mouse (C57BL/6)", RNASEQ_CHOICES)?.organism).toBe("Mouse (C57BL/6)");
  });
});
