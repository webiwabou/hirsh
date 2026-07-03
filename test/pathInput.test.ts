import { describe, expect, it } from "vitest";
import {
  classifyPathAnswer,
  looksLikePath,
  pathReference,
  wantsTestProfile,
} from "../src/conversation/pathInput.js";

describe("classifyPathAnswer", () => {
  it("treats absolute/relative/bare-token answers as paths", () => {
    expect(classifyPathAnswer("/data/reads")).toEqual({ kind: "path", path: "/data/reads" });
    expect(classifyPathAnswer("./reads")).toEqual({ kind: "path", path: "./reads" });
    expect(classifyPathAnswer("~/proteins")).toEqual({ kind: "path", path: "~/proteins" });
    expect(classifyPathAnswer("proteins")).toEqual({ kind: "path", path: "proteins" });
  });

  it("honors an explicit @ reference, even with spaces", () => {
    expect(classifyPathAnswer("@/data/reads")).toEqual({ kind: "path", path: "/data/reads" });
    expect(classifyPathAnswer("@/home/My Data/reads")).toEqual({
      kind: "path",
      path: "/home/My Data/reads",
    });
    expect(classifyPathAnswer("@")).toEqual({ kind: "empty" });
  });

  it("treats a sentence (a change of mind / question) as text, not a path", () => {
    expect(classifyPathAnswer("actually, i do want to run the test profile")).toEqual({
      kind: "text",
      text: "actually, i do want to run the test profile",
    });
    expect(classifyPathAnswer("")).toEqual({ kind: "empty" });
  });
});

describe("looksLikePath", () => {
  it("is false for multi-word sentences, true for single tokens", () => {
    expect(looksLikePath("i don't have the files")).toBe(false);
    expect(looksLikePath("data")).toBe(true);
    expect(looksLikePath("/abs/path")).toBe(true);
    expect(looksLikePath("")).toBe(false);
  });
});

describe("pathReference", () => {
  it("strips a leading @", () => {
    expect(pathReference("@/data/x")).toBe("/data/x");
    expect(pathReference("/data/x")).toBe("/data/x");
    expect(pathReference("  @./y  ")).toBe("./y");
  });
});

describe("wantsTestProfile", () => {
  it("detects a redirect to the test profile in English and Spanish", () => {
    expect(wantsTestProfile("actually, i do want to run the test profile")).toBe(true);
    expect(wantsTestProfile("let's just do a test run")).toBe(true);
    expect(wantsTestProfile("use the test data")).toBe(true);
    expect(wantsTestProfile("corramos el perfil de prueba")).toBe(true);
    expect(wantsTestProfile("/data/reads")).toBe(false);
    expect(wantsTestProfile("cluster my proteins")).toBe(false);
  });
});
