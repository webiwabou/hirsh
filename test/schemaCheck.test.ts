import { describe, expect, it } from "vitest";
import {
  checkParamsAgainstSchema,
  collectSchemaProperties,
  diffDefaults,
} from "../src/pipelines/schemaCheck.js";

const schema = {
  definitions: {
    clustering: {
      properties: {
        clustering_tool: { type: "string", enum: ["linclust", "cluster"], default: "linclust" },
        cluster_coverage: { type: "number", default: 0.9 },
      },
    },
  },
  allOf: [{ $ref: "#/definitions/clustering" }],
  properties: { input: { type: "string" } },
};

describe("collectSchemaProperties", () => {
  it("collects properties from nested definitions and the root", () => {
    const props = collectSchemaProperties(schema);
    expect([...props.keys()].sort()).toEqual(["cluster_coverage", "clustering_tool", "input"]);
    expect((props.get("clustering_tool") as { enum: string[] }).enum).toEqual(["linclust", "cluster"]);
  });
});

describe("checkParamsAgainstSchema", () => {
  const props = collectSchemaProperties(schema);

  it("passes a consistent definition", () => {
    expect(
      checkParamsAgainstSchema(
        [
          { name: "clustering_tool", default: "linclust", choices: ["linclust", "cluster"] },
          { name: "cluster_coverage", default: 0.9 },
          { name: "input" },
        ],
        props,
      ),
    ).toEqual([]);
  });

  it("flags a default and choices outside the upstream enum (the proteinfamilies bug)", () => {
    const problems = checkParamsAgainstSchema(
      [{ name: "clustering_tool", default: "mmseqs", choices: ["mmseqs", "linclust"] }],
      props,
    );
    expect(problems.some((p) => /default "mmseqs" is not in the upstream enum/.test(p))).toBe(true);
    expect(problems.some((p) => /choices \[mmseqs\]/.test(p))).toBe(true);
  });

  it("flags a param that isn't in the upstream schema", () => {
    expect(checkParamsAgainstSchema([{ name: "not_real" }], props)).toEqual([
      "not_real: not a parameter of the upstream schema",
    ]);
  });
});

describe("diffDefaults", () => {
  const props = collectSchemaProperties(schema);

  it("notes a non-enum default that drifted from upstream", () => {
    const notes = diffDefaults([{ name: "cluster_coverage", default: 0.8 }], props);
    expect(notes).toEqual(['cluster_coverage: default "0.8" differs from the upstream default "0.9"']);
  });

  it("stays silent when the default matches, is an enum, or upstream has none", () => {
    expect(diffDefaults([{ name: "cluster_coverage", default: 0.9 }], props)).toEqual([]);
    // clustering_tool has choices → handled by checkParamsAgainstSchema, skipped here.
    expect(diffDefaults([{ name: "clustering_tool", default: "cluster", choices: ["linclust", "cluster"] }], props)).toEqual([]);
    // input has no upstream default.
    expect(diffDefaults([{ name: "input", default: "x" }], props)).toEqual([]);
  });
});
