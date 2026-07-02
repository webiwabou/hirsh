import { describe, expect, it } from "vitest";
import { applyResume, coerceLike } from "../src/conversation/stateMachine.js";

describe("applyResume", () => {
  const cmd = ["run", "nf-core/rnaseq", "-profile", "docker", "-params-file", "params.yaml"];

  it("appends -resume when asked", () => {
    expect(applyResume(cmd, true)).toEqual([...cmd, "-resume"]);
  });

  it("removes -resume when not asked", () => {
    expect(applyResume([...cmd, "-resume"], false)).toEqual(cmd);
  });

  it("never duplicates -resume on repeated re-runs", () => {
    const once = applyResume(cmd, true);
    const twice = applyResume(once, true);
    expect(twice.filter((a) => a === "-resume")).toHaveLength(1);
    expect(twice).toEqual([...cmd, "-resume"]);
  });
});

describe("coerceLike", () => {
  it("keeps numbers numeric", () => {
    expect(coerceLike(8, "16")).toBe(16);
    expect(typeof coerceLike(8, "16")).toBe("number");
  });

  it("coerces booleans", () => {
    expect(coerceLike(false, "true")).toBe(true);
    expect(coerceLike(true, "false")).toBe(false);
  });

  it("keeps strings as strings, incl. non-numeric input for a numeric field", () => {
    expect(coerceLike("star_salmon", "hisat2")).toBe("hisat2");
    expect(coerceLike(8, "auto")).toBe("auto");
  });
});
