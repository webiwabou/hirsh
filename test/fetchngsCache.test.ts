import { describe, expect, it } from "vitest";
import { fetchngsCacheDir, fetchngsCacheKey } from "../src/execution/fetchngsCache.js";
import type { Accession } from "../src/execution/fetchngs.js";

const acc = (id: string): Accession => ({ id, kind: "run" });

describe("fetchngsCacheKey", () => {
  it("is stable and order-independent for the same accession set", () => {
    const a = fetchngsCacheKey([acc("SRR1"), acc("SRR2")]);
    const b = fetchngsCacheKey([acc("SRR2"), acc("SRR1")]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("de-duplicates repeated accessions", () => {
    expect(fetchngsCacheKey([acc("SRR1"), acc("SRR1")])).toBe(fetchngsCacheKey([acc("SRR1")]));
  });

  it("changes with a different pipeline tag (samplesheet is reshaped)", () => {
    const generic = fetchngsCacheKey([acc("SRR1")]);
    const rnaseq = fetchngsCacheKey([acc("SRR1")], "rnaseq");
    expect(generic).not.toBe(rnaseq);
  });

  it("changes when the accession set changes", () => {
    expect(fetchngsCacheKey([acc("SRR1")])).not.toBe(fetchngsCacheKey([acc("SRR1"), acc("SRR2")]));
  });
});

describe("fetchngsCacheDir", () => {
  it("nests the key under a stable cache path", () => {
    expect(fetchngsCacheDir("/work", "abc123")).toBe("/work/.hirsh-cache/fetchngs/abc123");
  });
});
