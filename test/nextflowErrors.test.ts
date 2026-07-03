import { describe, expect, it } from "vitest";
import { parseInvalidParams } from "../src/execution/nextflowErrors.js";

describe("parseInvalidParams", () => {
  it("extracts the offending param, value and allowed values", () => {
    const err = [
      "ERROR ~ Validation of pipeline parameters failed!",
      "The following invalid input values have been detected:",
      "* --clustering_tool (mmseqs): Expected any of [[linclust, cluster]]",
    ].join("\n");
    expect(parseInvalidParams(err)).toEqual([
      { param: "clustering_tool", value: "mmseqs", allowed: ["linclust", "cluster"] },
    ]);
  });

  it("handles multiple invalid params and single-bracket forms, de-duplicated", () => {
    const err =
      "* --aligner (foo): Expected any of [bwa, bowtie2]\n" +
      "* --tool (x): Expected any of [[a, b, c]]\n" +
      "* --aligner (foo): Expected any of [bwa, bowtie2]"; // dup
    const got = parseInvalidParams(err);
    expect(got.map((p) => p.param)).toEqual(["aligner", "tool"]);
    expect(got[1].allowed).toEqual(["a", "b", "c"]);
  });

  it("returns [] for an unrelated error", () => {
    expect(parseInvalidParams("ERROR ~ No space left on device")).toEqual([]);
    expect(parseInvalidParams("")).toEqual([]);
  });
});
