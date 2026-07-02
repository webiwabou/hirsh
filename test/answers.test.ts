import { describe, expect, it } from "vitest";
import { interpretYesNo } from "../src/conversation/answers.js";

describe("interpretYesNo", () => {
  it("understands plain affirmatives", () => {
    for (const a of ["y", "yes", "Yeah", "yep", "sure", "ok", "okay", "Correct", "sí", "dale"]) {
      expect(interpretYesNo(a)).toBe(true);
    }
  });

  it("understands plain negatives", () => {
    for (const a of ["n", "no", "Nope", "nah", "cancel", "stop", "abort"]) {
      expect(interpretYesNo(a)).toBe(false);
    }
  });

  it("tolerates trailing punctuation and phrases", () => {
    expect(interpretYesNo("yes!")).toBe(true);
    expect(interpretYesNo("go ahead")).toBe(true);
    expect(interpretYesNo("yes please")).toBe(true);
    expect(interpretYesNo("no thanks")).toBe(false);
  });

  it("returns null for content that isn't a bare yes/no", () => {
    expect(interpretYesNo("actually use sarek")).toBeNull();
    expect(interpretYesNo("no, pick sarek instead")).toBeNull();
    expect(interpretYesNo("it's paired-end WGS")).toBeNull();
    expect(interpretYesNo("")).toBeNull();
  });
});
